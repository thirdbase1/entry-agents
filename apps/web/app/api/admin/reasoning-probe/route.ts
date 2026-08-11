import { NextResponse } from "next/server";

// TEMPORARY diagnostic route -- probes entry-gateway directly with a
// battery of candidate reasoning/thinking request-body shapes per model,
// so we can empirically confirm (not just assume from vendor docs) which
// reasoning controls each model's actual upstream route honors through
// OUR resellers (iamhc / unimodel / opencode-zen), which may differ from
// each model's canonical first-party API. Gated by the same one-off
// AUDIT_ROUTE_SECRET as the other admin diagnostic routes. Delete once
// the reasoning-support audit is done.

interface ProbeVariant {
  label: string;
  body: Record<string, unknown>;
}

async function runProbe(
  baseURL: string,
  apiKey: string,
  model: string,
  variant: ProbeVariant,
) {
  const payload = {
    model,
    messages: [
      {
        role: "user",
        content: "What is 17 * 24? Answer with just the number, briefly.",
      },
    ],
    max_tokens: 300,
    stream: false,
    ...variant.body,
  };

  const started = Date.now();
  try {
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    });
    const elapsedMs = Date.now() - started;
    const text = await res.text();
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      // leave undefined
    }

    if (!res.ok) {
      return {
        label: variant.label,
        httpStatus: res.status,
        error: json ?? text.slice(0, 500),
        elapsedMs,
      };
    }

    const choices = json?.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    const message = choice?.message as Record<string, unknown> | undefined;
    const reasoningContent =
      typeof message?.reasoning_content === "string"
        ? (message.reasoning_content as string)
        : typeof message?.reasoning === "string"
          ? (message.reasoning as string)
          : undefined;

    return {
      label: variant.label,
      httpStatus: res.status,
      hasReasoningContent: Boolean(reasoningContent && reasoningContent.length > 0),
      reasoningContentPreview: reasoningContent?.slice(0, 120),
      reasoningContentLength: reasoningContent?.length ?? 0,
      finishReason: choice?.finish_reason,
      usage: json?.usage,
      contentPreview:
        typeof message?.content === "string"
          ? (message.content as string).slice(0, 80)
          : undefined,
      elapsedMs,
    };
  } catch (err) {
    return {
      label: variant.label,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  }
}

export async function POST(request: Request) {
  const expected = process.env.AUDIT_ROUTE_SECRET;
  if (!expected || request.headers.get("x-audit-secret") !== expected) {
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

  const plan = (await request.json()) as Record<string, ProbeVariant[]>;

  const results: Record<string, unknown[]> = {};
  for (const [model, variants] of Object.entries(plan)) {
    results[model] = [];
    for (const variant of variants) {
      results[model].push(await runProbe(baseURL, apiKey, model, variant));
    }
  }

  return NextResponse.json({ results });
}
