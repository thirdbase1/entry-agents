import type { NextRequest } from "next/server";
import { isUserAdmin } from "@/lib/db/users";
import { getSessionFromReq } from "@/lib/session/server";

// Lets the /settings/gateway dashboard auto-connect with zero manual entry
// for admins, mirroring the entry-gateway /admin page's own auto-inject
// behavior. Gated behind isUserAdmin (not just "logged in") because the
// value returned here is the real GATEWAY_API_KEY -- unlike the gateway's
// own /admin route (which is only reachable if you already know its URL),
// this route lives inside the regular signed-in app, so any logged-in
// non-admin user could otherwise pull the admin key just by hitting it.
export async function GET(req: NextRequest) {
  const session = await getSessionFromReq(req);
  if (!session?.user?.id) {
    return Response.json({ baseUrl: null, apiKey: null }, { status: 401 });
  }

  const admin = await isUserAdmin(session.user.id);
  if (!admin) {
    return Response.json({ baseUrl: null, apiKey: null }, { status: 403 });
  }

  // GATEWAY_BASE_URL is configured as the OpenAI-compatible base (used by
  // chat.ts / models-with-context.ts, which append /chat/completions,
  // /models, etc. under an implicit "/v1"), e.g.
  // "https://entry-gateway-six.vercel.app/v1". The dashboard instead calls
  // root-level admin routes directly (/health, /metrics) alongside /v1
  // ones (/v1/models, /v1/debug/routes), so it needs the bare origin with
  // no "/v1" suffix -- strip it here rather than making every caller of
  // GATEWAY_BASE_URL agree on a convention.
  const rawBaseUrl = process.env.GATEWAY_BASE_URL || null;
  const baseUrl = rawBaseUrl
    ? rawBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")
    : null;
  const apiKey = process.env.GATEWAY_API_KEY || null;
  return Response.json({ baseUrl, apiKey });
}
