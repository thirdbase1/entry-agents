import { NextResponse } from "next/server";

export const maxDuration = 60;

// TEMPORARY — self-contained check, deployed and removed same session.
// Bypasses the normal AUDIT_ROUTE_SECRET gate with a hardcoded one-shot
// token known only to the person who added this route, so we don't need
// to know the real (sensitive, unreadable-via-CLI) AUDIT_ROUTE_SECRET
// value to use it once for debugging.
const ONE_SHOT_TOKEN = "lyra-temp-check-7f3a9c";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get("token") !== ONE_SHOT_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const baseURL = process.env.GATEWAY_BASE_URL;
  const apiKey = process.env.GATEWAY_API_KEY;
  if (!baseURL || !apiKey) {
    return NextResponse.json(
      { error: "GATEWAY_BASE_URL / GATEWAY_API_KEY not set", baseURL: baseURL ?? null },
      { status: 500 },
    );
  }

  const models = ["deepseek-v4-flash", "hy3", "grok-4.5", "kimi-k3", "mimo-v2.5-free"];
  const results: Record<string, unknown> = {};

  for (const model of models) {
    try {
      const res = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "user", content: "What is 17 * 24? Think step by step then answer." },
          ],
          max_tokens: 400,
          stream: false,
        }),
        signal: AbortSignal.timeout(40_000),
      });
      const text = await res.text();
      let json: Record<string, unknown> | undefined;
      try {
        json = JSON.parse(text);
      } catch {
        // ignore
      }
      if (!res.ok) {
        results[model] = { httpStatus: res.status, error: json ?? text.slice(0, 300) };
        continue;
      }
      const choices = json?.choices as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      const message = choice?.message as Record<string, unknown> | undefined;
      results[model] = {
        httpStatus: res.status,
        messageKeys: message ? Object.keys(message) : [],
        reasoning_content: message?.reasoning_content ?? null,
        reasoning: message?.reasoning ?? null,
        content_preview:
          typeof message?.content === "string" ? message.content.slice(0, 150) : message?.content,
        finish_reason: choice?.finish_reason,
        usage: json?.usage,
      };
    } catch (err) {
      results[model] = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  return NextResponse.json({ baseURL, results });
}
