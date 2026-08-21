import { NextResponse } from "next/server";

// TEMPORARY diagnostic route -- see benchmark-debug/live-probe history in
// docs/agents/lessons-learned.md (2026-08-21 entry). Verifies the
// ling-3.0-flash-free + gpt-5.6-luna gateway fixes are actually live.
// Delete once confirmed.
async function callOnce(baseURL: string, apiKey: string, model: string) {
  const started = Date.now();
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
          model,
          max_tokens: 8,
          messages: [{ role: "user", content: "Reply with one word: ok" }],
        }),
      },
    );
    const text = await response.text();
    return {
      model,
      status: response.status,
      ms: Date.now() - started,
      body: text.slice(0, 500),
    };
  } catch (error) {
    return {
      model,
      status: "fetch_threw",
      ms: Date.now() - started,
      body: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function GET(request: Request) {
  const expected = process.env.AUDIT_ROUTE_SECRET;
  const expectedLive = process.env.AUDIT_ROUTE_SECRET_LIVE;
  const provided = request.headers.get("x-audit-secret");
  if (!provided || (provided !== expected && provided !== expectedLive)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const baseURL = process.env.GATEWAY_BASE_URL;
  const apiKey = process.env.GATEWAY_API_KEY;
  if (!(baseURL && apiKey)) {
    return NextResponse.json(
      { error: "GATEWAY_BASE_URL / GATEWAY_API_KEY not set" },
      { status: 500 },
    );
  }

  const modelsParam = new URL(request.url).searchParams.get("models") ?? "";
  const models = modelsParam.split(",").filter(Boolean);
  if (models.length === 0) {
    return NextResponse.json({ error: "pass ?models=a,b,c" }, { status: 400 });
  }

  const results = [];
  for (const model of models) {
    results.push(await callOnce(baseURL, apiKey, model));
  }

  return NextResponse.json({ results });
}
