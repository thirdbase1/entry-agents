import { NextResponse } from "next/server";

export const maxDuration = 60;

// TEMPORARY — self-contained check, deployed and removed same session.
const ONE_SHOT_TOKEN = "lyra-temp-check-7f3a9c";

// 1x1 red pixel PNG, base64.
const TEST_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function probeModel(trimmedBase: string, apiKey: string, model: string) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${trimmedBase}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "What color is this 1x1 pixel image? Answer in one word.",
              },
              { type: "image_url", image_url: { url: TEST_IMAGE_DATA_URL } },
            ],
          },
        ],
        max_tokens: 30,
      }),
    });
    const bodyText = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = bodyText.slice(0, 300);
    }
    return [
      model,
      { httpStatus: res.status, ok: res.ok, body: parsed },
    ] as const;
  } catch (err) {
    return [model, { error: String(err) }] as const;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get("token") !== ONE_SHOT_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const baseURL = process.env.GATEWAY_BASE_URL;
  const apiKey = process.env.GATEWAY_API_KEY;
  if (!baseURL || !apiKey) {
    return NextResponse.json(
      {
        error: "GATEWAY_BASE_URL / GATEWAY_API_KEY not set",
        baseURL: baseURL ?? null,
      },
      { status: 500 },
    );
  }

  const trimmedBase = baseURL.replace(/\/$/, "");

  let catalogModels: string[] = [];
  let catalogError: string | null = null;
  try {
    const res = await fetch(`${trimmedBase}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const json = (await res.json()) as {
      data?: { id: string; modelType?: string | null }[];
    };
    catalogModels = (json.data ?? [])
      .filter((m) => (m.modelType ?? "language") === "language")
      .map((m) => m.id);
  } catch (err) {
    catalogError = String(err);
  }

  const entries = await Promise.all(
    catalogModels.map((model) => probeModel(trimmedBase, apiKey, model)),
  );
  const results = Object.fromEntries(entries);

  return NextResponse.json({
    baseURL: trimmedBase,
    catalogModels,
    catalogError,
    results,
  });
}
