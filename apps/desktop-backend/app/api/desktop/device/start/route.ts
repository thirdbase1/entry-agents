import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { getSql } from "@/lib/sql";
import { ensureDeviceTable } from "@/lib/device-codes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Desktop sign-in step 1: desktop client requests a short code to display.
 * User then opens the Entry web app approve page, signs in with Better Auth,
 * and approves. Desktop polls /api/desktop/device/poll until approved.
 *
 * The session token is NOT returned by this route. It is stored server-side
 * (encrypted-at-rest by the DB) and only released to the poller that holds
 * the device_code — never exposed to a browser tab.
 */
export async function POST(_req: NextRequest) {
  await ensureDeviceTable();
  const sql = getSql();

  const deviceCode = randomBytes(32).toString("base64url");
  // Short human-readable code the user types/sees on the approve page.
  const code = String(parseInt(randomBytes(3).toString("hex"), 16) % 1000000).padStart(6, "0");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await sql`
    INSERT INTO desktop_device_codes (device_code, code, expires_at)
    VALUES (${deviceCode}, ${code}, ${expiresAt})`;

  return NextResponse.json({
    device_code: deviceCode,
    code,
    expires_at: expiresAt.toISOString(),
    poll_interval_seconds: 3,
  });
}
