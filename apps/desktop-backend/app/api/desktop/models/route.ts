import { NextRequest, NextResponse } from "next/server";
import { requireDesktopUser, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * GET /api/desktop/models — proxy the public gateway model catalog for the
 * desktop picker. Session required; no secrets involved (the upstream
 * catalog is the same public list the web picker reads).
 */
export async function GET(req: NextRequest) {
  const user = await requireDesktopUser(req);
  if (!user) return unauthorized();

  const upstream = await fetch(
    `${(process.env.GATEWAY_BASE_URL ?? "").replace(/\/$/, "")}/v1/models`,
    {
      next: { revalidate: 300 },
      headers: process.env.GATEWAY_API_KEY
        ? { Authorization: `Bearer ${process.env.GATEWAY_API_KEY}` }
        : undefined,
    },
  ).catch(() => null);

  if (!upstream?.ok) {
    return NextResponse.json({ error: "Catalog unavailable" }, { status: 502 });
  }
  const data = (await upstream.json()) as { data?: unknown[]; models?: unknown[] };
  return NextResponse.json({ models: data.data ?? data.models ?? [] });
}
