import { NextResponse } from "next/server";
import { cleanupStaleSessionDrives } from "@/lib/sandbox/drive-cleanup";

export const dynamic = "force-dynamic";

/**
 * Reclaims per-session workspace drives that are no longer needed.
 *
 * Drives are created lazily when a session provisions a sandbox with
 * drives enabled, one per session, and nothing else deletes them. Without
 * this route they accumulate at 8 GiB of provisioned capacity each.
 *
 * Intended for Vercel Cron (add a schedule to vercel.json) or a manual
 * owner trigger, both authenticated with CRON_SECRET as a bearer token.
 * Deliberately not public: it deletes data.
 */
export async function POST(req: Request) {
  // Fail closed, matching the other cron routes: an unset CRON_SECRET
  // means no request gets through rather than silently opening up a
  // data-deleting endpoint.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "Server misconfigured: CRON_SECRET is not set" },
      { status: 500 },
    );
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await cleanupStaleSessionDrives();
    return NextResponse.json(result);
  } catch (error) {
    console.error("drive-cleanup failed:", error);
    return NextResponse.json(
      { error: "Drive cleanup failed" },
      { status: 500 },
    );
  }
}
