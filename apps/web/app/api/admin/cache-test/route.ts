import { NextResponse } from "next/server";

// TEMPORARY diagnostic route -- fires two back-to-back chat.completions
// calls per configured model with an identical long shared prefix, so we
// can inspect the raw usage object each upstream actually returns and
// confirm whether prompt caching (cache read on the 2nd call) is really
// happening. Gated by the same one-off AUDIT_ROUTE_SECRET as the routes
// debug endpoint. Delete once the caching audit is done.

// A long, deterministic filler block. Needs to be well above each
// provider's minimum cacheable-prefix size (OpenAI-compatible providers
// commonly require ~1024 tokens before caching kicks in).
const FILLER = Array.from(
  { length: 220 },
  (_, i) =>
    `Fact ${i}: The quick brown fox jumps over the lazy dog near river bank number ${i * 7 + 3} while clouds drift slowly overhead in the afternoon sky.`,
).join(" ");

const SYSTEM_PROMPT = `You are a terse test assistant. Reply with exactly one word: "ok".\n\nReference material (do not repeat it back):\n${FILLER}`;

async function callOnce(baseURL: string, apiKey: string, model: string) {
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
        model,
        max_tokens: 8,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: "Reply with one word." },
        ],
      }),
    },
  );
  const latencyMs = Date.now() - started;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = await response.text().catch(() => undefined);
  }
  const usage =
    body && typeof body === "object" && "usage" in body
      ? (body as { usage?: unknown }).usage
      : undefined;
  const error =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: unknown }).error
      : undefined;
  return { status: response.status, latencyMs, usage, error };
}

export async function GET(request: Request) {
  const supplied = request.headers.get("x-audit-secret");
  const expected = process.env.AUDIT_ROUTE_SECRET;
  if (!expected || supplied !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const baseURL = process.env.GATEWAY_BASE_URL;
  const apiKey = process.env.GATEWAY_API_KEY;
  if (!baseURL || !apiKey) {
    return NextResponse.json(
      { error: "GATEWAY_BASE_URL / GATEWAY_API_KEY not set" },
      { status: 500 },
    );
  }

  const modelsParam = new URL(request.url).searchParams.get("models");
  if (!modelsParam) {
    return NextResponse.json(
      { error: "Pass ?models=comma,separated,ids" },
      { status: 400 },
    );
  }
  const models = modelsParam
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  const results: Record<string, unknown> = {};
  for (const model of models) {
    try {
      const first = await callOnce(baseURL, apiKey, model);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const second = await callOnce(baseURL, apiKey, model);
      results[model] = { first, second };
    } catch (e) {
      results[model] = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  return NextResponse.json({ results });
}
