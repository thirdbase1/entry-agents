import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { sessions } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";

export const maxDuration = 30;

// TEMPORARY diagnostic route -- surfaces the real lifecycleError detail
// for recently failed sandbox-provisioning runs. The workflow persists
// the enriched toErrorMessage() string to sessions.lifecycleError but
// then re-throws the raw (generic) error for the workflow-sdk's own
// retry/log machinery, so Vercel's runtime logs only ever show the bare
// "Status code N is not ok" -- this route is the only way to see the
// real response body without direct DB access. Gated by the same
// one-off AUDIT_ROUTE_SECRET as the other admin diagnostic routes.
// Delete once this specific incident is root-caused.

export async function GET(req: Request) {
  const auditSecret = process.env.AUDIT_ROUTE_SECRET_LIVE;
  const provided = req.headers.get("x-audit-secret");
  if (!auditSecret || provided !== auditSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select({
      id: sessions.id,
      lifecycleState: sessions.lifecycleState,
      lifecycleError: sessions.lifecycleError,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(eq(sessions.lifecycleState, "failed"))
    .orderBy(desc(sessions.updatedAt))
    .limit(10);

  return NextResponse.json({ rows });
}
