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
  }
}
