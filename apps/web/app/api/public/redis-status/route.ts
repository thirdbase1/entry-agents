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
 * a real PING on every request, so keep polling interval sane (this is
 * intended to be hit every 15-30 min by one scheduled job, not on a
 * tight loop).
 */
const PING_TIMEOUT_MS = 3000;

export async function GET() {
  if (!isRedisConfigured()) {
    return NextResponse.json(
      { available: false, checkedAt: new Date().toISOString() },
      { status: 200 },
    );
  }

  const client = createRedisClient("redis-status-check");

  try {
    const pong = await Promise.race([
      client.ping(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("ping timeout")), PING_TIMEOUT_MS);
      }),
    ]);

    return NextResponse.json({
      available: pong === "PONG",
      checkedAt: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({
      available: false,
      checkedAt: new Date().toISOString(),
    });
  } finally {
    client.disconnect();
  }
}
