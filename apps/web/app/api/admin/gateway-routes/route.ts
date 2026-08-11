import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/session/get-server-session";
import { isUserAdmin } from "@/lib/db/users";

// TEMPORARY audit-only route -- calls entry-gateway's own
// /v1/debug/routes using the server's already-configured GATEWAY_API_KEY
// so we can inspect current route/pricing config without ever needing to
// decrypt the sensitive MODEL_ROUTES_JSON env var directly. Delete this
// file once the pricing audit is done.
export async function GET() {
  const session = await getServerSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const admin = await isUserAdmin(session.user.id);
  if (!admin) {
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
