import { NextResponse } from "next/server";
import { createRedisClient, isRedisConfigured } from "@/lib/redis";

/**
 * Public, unauthenticated, minimal health-status endpoint for the
 * shared rate-limit Redis (Upstash). Added 2026-08-26 after that Redis
 * instance started hitting a provider-side rate limit / erroring,
 * which checkRateLimit() (lib/rate-limit.ts) now handles by failing
 * open + alerting once via Telegram. This endpoint lets an external
 * monitor (a Superagent scheduled workflow) poll for recovery instead
 * of the owner having to check manually.
 *
 * Deliberately exposes ONLY a boolean + timestamp -- no connection
 * string, no error text, no internal details -- safe to leave
 * public/unauthed. Opens a short-lived dedicated connection and issues
 * a real PING on every underlying check, so keep polling interval sane
 * (intended to be hit every 15-30 min by one scheduled job).
 *
 * 2026-08-27: found via a live pentest that this route had NO caching
 * and NO rate limit of its own -- being public + unauthenticated, any
 * script/scanner hitting it in a tight loop would open a fresh real
 * Redis connection and PING per request, unbounded. That's exactly the
 * kind of load that has already tipped this same Upstash instance into
 * provider-side throttling twice before. Added a short in-process cache
 * so bursts of requests within CACHE_TTL_MS collapse into at most one
 * real PING -- the endpoint's own contract (a boolean + timestamp) is
 * unaffected, callers just get an answer that's at most a few seconds
 * stale.
 */
const PING_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 10_000;

let cached: {
  available: boolean;
  checkedAt: string;
  expiresAt: number;
} | null = null;
let inFlight: Promise<{ available: boolean; checkedAt: string }> | null = null;

async function checkRedisAvailability(): Promise<{
  available: boolean;
  checkedAt: string;
}> {
  if (!isRedisConfigured()) {
    return { available: false, checkedAt: new Date().toISOString() };
  }

  const client = createRedisClient("redis-status-check");
  try {
    const pong = await Promise.race([
      client.ping(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("ping timeout")), PING_TIMEOUT_MS);
      }),
    ]);
    return { available: pong === "PONG", checkedAt: new Date().toISOString() };
  } catch {
    return { available: false, checkedAt: new Date().toISOString() };
  } finally {
    client.disconnect();
  }
}

export async function GET() {
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return NextResponse.json({
      available: cached.available,
      checkedAt: cached.checkedAt,
    });
  }

  // Collapse concurrent requests that land while a real check is already
  // in flight into a single upstream PING instead of one each.
  if (!inFlight) {
    inFlight = checkRedisAvailability().finally(() => {
      inFlight = null;
    });
  }

  const result = await inFlight;
  cached = { ...result, expiresAt: now + CACHE_TTL_MS };
  return NextResponse.json(result);
}
