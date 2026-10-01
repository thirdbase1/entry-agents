"use server";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getServerSession } from "@/lib/session/get-server-session";

/**
 * Phase 10 — Desktop device sign-in approval.
 *
 * The signed-in Entry web user approves a code shown in Entry Desktop.
 * On approval, the row in `desktop_device_codes` (infrastructure table,
 * created idempotently — NOT a product schema change) is bound to the
 * user's current auth session token. The desktop client later polls
 * Project-B (which shares this same production database) to receive the
 * token. The web browser never sends the token to the desktop directly;
 * the desktop must present the matching device_code.
 */
export async function ensureDeviceTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS desktop_device_codes (
      device_code TEXT PRIMARY KEY,
      code TEXT UNIQUE,
      session_token TEXT,
      user_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      approved_at TIMESTAMPTZ
    )`);
}

export type ApproveResult =
  | { ok: true }
  | { error: "unauthorized" | "invalid_code" | "not_found" | "expired" };

export async function approveDesktopDevice(code: string): Promise<ApproveResult> {
  const session = await getServerSession();
  if (!session?.user?.id) return { error: "unauthorized" };

  if (!/^\d{6}$/.test(code)) return { error: "invalid_code" };
  await ensureDeviceTable();

  const rows = await db.execute(sql`
    SELECT device_code, status, expires_at
    FROM desktop_device_codes
    WHERE code = ${code}
    LIMIT 1`);

  const row = (rows as unknown as { device_code: string; status: string; expires_at: Date | string }[])[0];
  if (!row) return { error: "not_found" };
  if (new Date(row.expires_at).getTime() < Date.now()) return { error: "expired" };

  // Bind the approving user's live Better Auth session token to the device row.
  const tokenRes = await db.execute(sql`
    SELECT token FROM auth_sessions
    WHERE user_id = ${session.user.id}
    ORDER BY expires_at DESC
    LIMIT 1`);
  const tokenRow = (tokenRes as unknown as { token: string }[])[0];
  if (!tokenRow?.token) return { error: "unauthorized" };

  if (row.status === "approved") return { ok: true };

  await db.execute(sql`
    UPDATE desktop_device_codes
    SET status = 'approved', session_token = ${tokenRow.token}, user_id = ${session.user.id}, approved_at = now()
    WHERE device_code = ${row.device_code}`);

  return { ok: true };
}
