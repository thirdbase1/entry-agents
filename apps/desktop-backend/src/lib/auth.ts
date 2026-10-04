/**
 * Project-B shared auth — Phase 7.
 *
 * Desktop authenticates with `Authorization: Bearer <better-auth session
 * token>`. The token is resolved against the SAME `auth_sessions` table
 * the web app uses (identical token format, same DB, same users). No new
 * auth system: we reuse Better Auth's session storage directly because a
 * desktop session is cryptographically the same kind of session as a
 * browser session — only the transport differs.
 *
 * Secrets never leave this module: POSTGRES_URL is read server-side only,
 * and no handler ever receives anything but the resolved user id/email.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSql } from "./sql";

export interface DesktopUser {
  id: string;
  email: string;
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/** No hashing — better-auth stores session tokens verbatim
 * (internal-adapter.mjs: `token: generateId(32)`, unique index). */
/**
 * Resolve the desktop bearer token to a user via the real auth_sessions
 * table. Returns null for missing/expired/unknown tokens (fail closed).
 */
export async function requireDesktopUser(req: NextRequest): Promise<DesktopUser | null> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (token.length < 20) return null;

  const tokenHash = token;
  const sql = getSql();
  const rows = await sql`
    SELECT u.id, u.email
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ${tokenHash}
      AND s.expires_at > now()
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return { id: rows[0].id as string, email: rows[0].email as string };
}
