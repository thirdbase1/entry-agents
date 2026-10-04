import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/lib/sql";

export const runtime = "nodejs";

/**
 * Phase 10 — Desktop sign-in infrastructure (device flow).
 *
 * Additive infrastructure table: pending desktop sign-in attempts. This is
 * NOT a product schema and NOT a second database — it lives in the same
 * production Postgres as every other Entry table, and it is created
 * idempotently on first use (same pattern the retired desktop backend used).
 * No Entry product table is altered by it.
 */
export async function ensureDeviceTable(): Promise<void> {
  const sql = getSql();
  await sql`
    CREATE TABLE IF NOT EXISTS desktop_device_codes (
      device_code TEXT PRIMARY KEY,
      code TEXT UNIQUE,
      session_token TEXT,
      user_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      approved_at TIMESTAMPTZ
    )`;
}
