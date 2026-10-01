import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/sql";
import { ensureDeviceTable } from "@/lib/device-codes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Desktop sign-in step 2: poll for approval.
 * Only the poller holding the exact device_code receives the session token.
 * Expired/unknown codes return 404-shaped payloads without leaking state.
 */
export async function POST(req: NextRequest) {
  await ensureDeviceTable();
  const sql = getSql();

  let body: { device_code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const deviceCode = body.device_code;
  if (typeof deviceCode !== "string" || deviceCode.length < 16 || deviceCode.length > 128) {
    return NextResponse.json({ error: "invalid_device_code" }, { status: 400 });
  }

  const rows = await sql`
    SELECT status, session_token, user_id, expires_at
    FROM desktop_device_codes
    WHERE device_code = ${deviceCode}
    LIMIT 1`;

  if (rows.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const row = rows[0] as { status: string; session_token: string | null; user_id: string | null; expires_at: Date };

  if (new Date(row.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ status: "expired" });
  }
  if (row.status !== "approved" || !row.session_token || !row.user_id) {
    return NextResponse.json({ status: "pending" });
  }

  // Token is delivered exactly once, then wiped from the code row.
  await sql`
    UPDATE desktop_device_codes
    SET session_token = NULL
    WHERE device_code = ${deviceCode}`;

  return NextResponse.json({ status: "approved", session_token: row.session_token, user_id: row.user_id });
}
