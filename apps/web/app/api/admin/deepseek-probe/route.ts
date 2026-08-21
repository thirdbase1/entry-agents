import { NextResponse } from "next/server";

export const maxDuration = 30;

// TEMPORARY diagnostic route -- fires a single real chat.completions call
// for deepseek-v4-flash through entry-gateway and returns the raw
// upstream error body verbatim, so the benchmark run's "Failed after 3
// attempts. Last error: All compatible upstream routes failed." can be
// root-caused instead of guessed at. Gated by the same AUDIT_ROUTE_SECRET
// (_LIVE) pattern as the other admin diagnostic routes. Delete once the
// deepseek-v4-flash investigation is resolved.
export async function GET(request: Request) {
  const expected = process.env.AUDIT_ROUTE_SECRET;
  const expectedLive = process.env.AUDIT_ROUTE_SECRET_LIVE;
  const provided = request.headers.get("x-audit-secret");
  if (!provided || (provided !== expected && provided !== expectedLive)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const baseURL = process.env.GATEWAY_BASE_URL;
  const apiKey = process.env.GATEWAY_API_KEY;
  if (!baseURL || !apiKey) {
    return NextResponse.json(
      { error: "GATEWAY_BASE_URL / GATEWAY_API_KEY not set" },
      { status: 500 },
    );
  }

  const started = Date.now();
  const response = await fetch(
    `${baseURL.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        max_tokens: 16,
        messages: [{ role: "user", content: "Say ok." }],
      }),
    },
  );
  const latencyMs = Date.now() - started;
  const text = await response.text();
  return NextResponse.json({
    status: response.status,
    latencyMs,
    body: text.slice(0, 4000),
  });
}
