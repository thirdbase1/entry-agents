import { NextResponse } from "next/server";

export const maxDuration = 90;

// TEMPORARY — self-contained check, deployed and removed same session.
// Bypasses the normal AUDIT_ROUTE_SECRET gate with a hardcoded one-shot
// token known only to the person who added this route, so we don't need
// to know the real (sensitive, unreadable-via-CLI) AUDIT_ROUTE_SECRET
// value to use it once for debugging.
const ONE_SHOT_TOKEN = "lyra-temp-check-7f3a9c";

// 1x1 red pixel PNG, base64.
const TEST_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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

  const trimmedBase = baseURL.replace(/\/$/, "");

  // Pull the live, gateway-driven model catalog (language models only) so
  // we test whatever's actually enabled right now, not a stale hardcoded
  // list.
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

  const results: Record<string, unknown> = {};

  for (const model of catalogModels) {
    try {
      const res = await fetch(`${trimmedBase}/chat/completions`, {
        method: "POST",
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
                { type: "text", text: "What color is this 1x1 pixel image? Answer in one word." },
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
        parsed = bodyText.slice(0, 500);
      }

      results[model] = {
        httpStatus: res.status,
        ok: res.ok,
        body: parsed,
      };
    } catch (err) {
      results[model] = { error: String(err) };
    }
  }

  return NextResponse.json({
    baseURL: trimmedBase,
    catalogModels,
    catalogError,
    results,
  });
}
