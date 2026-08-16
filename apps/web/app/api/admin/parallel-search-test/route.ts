import { NextResponse } from "next/server";

// TEMPORARY diagnostic route -- tests the live PARALLEL_API_KEY exactly as
// packages/agent/tools/web-search.ts does, to see the real upstream error
// instead of guessing. Gated by a one-off SEARCH_AUDIT_SECRET so it's not
// wide open. Delete once the web-search issue is diagnosed.
export async function GET(request: Request) {
  const expected = process.env.SEARCH_AUDIT_SECRET;
  const supplied = request.headers.get("x-audit-secret");
  if (!expected || supplied !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.PARALLEL_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "PARALLEL_API_KEY not set" }, { status: 200 });
  }

  const started = Date.now();
  try {
    const response = await fetch("https://api.parallel.ai/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        search_queries: ["current weather Lagos Nigeria"],
        objective: "diagnostic test",
        mode: "fast",
        max_chars_total: 500,
      }),
    });
    const latencyMs = Date.now() - started;
    const bodyText = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = null;
    }
    return NextResponse.json({
      status: response.status,
      ok: response.ok,
      latencyMs,
      keyPrefix: apiKey.slice(0, 6),
      keySuffix: apiKey.slice(-4),
      keyLength: apiKey.length,
      body: parsed ?? bodyText.slice(0, 500),
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      keyPrefix: apiKey.slice(0, 6),
      keyLength: apiKey.length,
    });
  }
}
