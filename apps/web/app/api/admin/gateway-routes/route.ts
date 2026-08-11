import { NextResponse } from "next/server";

// TEMPORARY audit-only route -- calls entry-gateway's own
// /v1/debug/routes using the server's already-configured GATEWAY_API_KEY
// so we can inspect current route/pricing config without ever needing to
// decrypt the sensitive MODEL_ROUTES_JSON env var directly. Gated by a
// one-off AUDIT_ROUTE_SECRET header (not session auth) since this is
// called from tooling, not the browser. Delete this file (and the env
// var) once the pricing audit is done.
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

  const response = await fetch(
    `${baseURL.replace(/\/$/, "")}/debug/routes`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  const body = await response.text();
  return new NextResponse(body, {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}
