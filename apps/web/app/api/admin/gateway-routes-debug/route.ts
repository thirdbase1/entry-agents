import { NextResponse } from "next/server";

export const maxDuration = 30;

// TEMPORARY diagnostic route -- proxies entry-gateway's adminAuth-gated
// GET /v1/debug/routes using entry-agents' own GATEWAY_API_KEY (which
// entry-gateway's adminAuth also accepts, since it falls back to the
// regular keys() set when the caller isn't in ADMIN_API_KEYS). This
// exists because MODEL_ROUTES_JSON / EXTRA_MODEL_ROUTES_JSON /
// EXTRA_MODEL_ROUTES_JSON_2 are all Vercel "sensitive" env vars on the
// entry-gateway project -- permanently unreadable via the
// dashboard/API -- so the only way to see what's actually configured
// for a given model is to ask the running gateway itself. Built while
// investigating why ling-3.0 benchmark tasks failed instantly with
// "No openai-chat route is configured for ling-3.0." Gated by the same
// AUDIT_ROUTE_SECRET(_LIVE) pattern as the other admin diagnostic
// routes. Delete once the ling-3.0 investigation is resolved.
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

  const upstream = await fetch(
    `${baseURL.replace(/\/v1$/, "")}/v1/debug/routes`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );
  const body = await upstream.text();
  return new NextResponse(body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
