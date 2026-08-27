import { NextResponse } from "next/server";

/**
 * Public, unauthenticated, minimal health-status endpoint for
 * gpt-5.6-luna (Free tier's only model). Added 2026-08-21 while
 * FreeModel's vip-sg.freemodel.dev pool for Luna specifically was down
 * (real 503 "No available channel"), so an external monitor (a
 * Superagent scheduled workflow) can poll for recovery instead of the
 * owner having to ask manually.
 *
 * Deliberately exposes ONLY a boolean + timestamp -- no upstream error
 * text, no internal routing details -- safe to leave public/unauthed.
 * Does a real tiny completion call (max_tokens: 5) through the gateway
 * on every underlying check, so keep polling interval sane (intended
 * to be hit every 15-30 min by one scheduled job).
 *
 * 2026-08-26: added an explicit request timeout. While Luna's upstream
 * pool was down, the fetch call itself was HANGING (not just erroring),
 * so this route ran until Vercel's hard 300s function timeout killed it
 * with a 504 -- every single poll. An AbortController with a short
 * (8s) budget now guarantees this always resolves fast.
 *
 * 2026-08-27: found via a live pentest that this route had NO caching
 * and NO rate limit -- being public + unauthenticated, every single
 * hit fired a real, separately-billed completion call through
 * GATEWAY_API_KEY with no cap. Confirmed live: two back-to-back curls
 * each triggered their own fresh upstream call (8.3s then 2.2s, no
 * reuse). Harmless right now only because Luna happens to be down; the
 * moment it recovers this becomes an unauthenticated way for anyone to
 * spend the owner's real metered API budget on demand, unbounded. Added
 * the same short in-process cache + in-flight de-dupe pattern as the
 * sibling redis-status route: bursts within CACHE_TTL_MS collapse into
 * at most one real upstream call.
 */
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 20_000;

let cached: {
  available: boolean;
  checkedAt: string;
  expiresAt: number;
} | null = null;
let inFlight: Promise<{ available: boolean; checkedAt: string }> | null = null;

async function checkLunaAvailability(): Promise<{
  available: boolean;
  checkedAt: string;
}> {
  const baseURL = process.env.GATEWAY_BASE_URL;
  const apiKey = process.env.GATEWAY_API_KEY;
  if (!(baseURL && apiKey)) {
    return { available: false, checkedAt: new Date().toISOString() };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${baseURL.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          max_tokens: 5,
          messages: [{ role: "user", content: "ok" }],
        }),
        signal: controller.signal,
      },
    );
    return {
      available: response.status === 200,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return { available: false, checkedAt: new Date().toISOString() };
  } finally {
    clearTimeout(timeoutId);
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

  if (!inFlight) {
    inFlight = checkLunaAvailability().finally(() => {
      inFlight = null;
    });
  }

  const result = await inFlight;
  cached = { ...result, expiresAt: now + CACHE_TTL_MS };
  return NextResponse.json(result);
}
