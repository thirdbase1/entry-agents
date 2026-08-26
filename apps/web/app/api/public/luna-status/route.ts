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
 * on every request, so keep polling interval sane (this is intended to
 * be hit every 15-30 min by one scheduled job, not on a tight loop).
 *
 * 2026-08-26: added an explicit request timeout. While Luna's upstream
 * pool was down, the fetch call itself was HANGING (not just erroring),
 * so this route ran until Vercel's hard 300s function timeout killed it
 * with a 504 -- every single poll. An AbortController with a short
 * (8s) budget now guarantees this always resolves fast, treating a
 * timeout the same as "not available" (which is the correct signal
 * anyway -- a real healthy model responds to a 5-token completion in
 * well under a second).
 */
export async function GET() {
  const baseURL = process.env.GATEWAY_BASE_URL;
  const apiKey = process.env.GATEWAY_API_KEY;
  if (!(baseURL && apiKey)) {
    return NextResponse.json(
      { available: false, checkedAt: new Date().toISOString() },
      { status: 200 },
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

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
    return NextResponse.json({
      available: response.status === 200,
      checkedAt: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({
      available: false,
      checkedAt: new Date().toISOString(),
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
