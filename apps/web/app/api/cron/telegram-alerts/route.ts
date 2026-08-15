import { NextResponse } from "next/server";
import { getAdminModelAlerts } from "@/lib/db/admin-activity";
import { getStuckArchivedSessions } from "@/lib/db/sessions";
import { kickArchiveSandboxStopWorkflow } from "@/lib/sandbox/archive-sandbox-kick";
import { checkAndNotifyTelegramAlerts } from "@/lib/telegram-alerts";

export const dynamic = "force-dynamic";

/**
 * Once-daily Vercel Cron backstop for model-health Telegram alerts (see
 * vercel.json -- Hobby plan caps cron frequency at once/day). The admin
 * dashboard's client-side poll (lib/admin/actions.ts -> getAdminAlerts())
 * already delivers near-real-time alerts whenever someone has the
 * dashboard open; this route just guarantees at least one check per day
 * even if nobody does.
 *
 * Also re-kicks the durable archive-sandbox-stop workflow for any session
 * stuck half-archived (see getStuckArchivedSessions) -- a backstop for the
 * "Manila" incident where that background job apparently never ran at
 * all. The workflow itself is durable, but if `start()` was never even
 * called successfully (or the run silently vanished before the platform
 * ever picked it up), nothing else would notice, so this sweep exists to
 * catch and retry that specific gap. Reusing this existing daily cron
 * slot instead of adding a new one since Hobby plan cron jobs are capped
 * at once/day each.
 */
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let stuckSessionsRekicked = 0;
  try {
    const stuckSessions = await getStuckArchivedSessions();
    for (const stuck of stuckSessions) {
      kickArchiveSandboxStopWorkflow(stuck.id, "[Cron reconciliation]");
      stuckSessionsRekicked += 1;
    }
    if (stuckSessions.length > 0) {
      console.warn(
        `[cron/telegram-alerts] Re-kicked archive-sandbox-stop for ${stuckSessions.length} stuck session(s): ${stuckSessions
          .map((s) => s.id)
          .join(", ")}`,
      );
    }
  } catch (err) {
    console.error(
      "[cron/telegram-alerts] stuck-session reconciliation failed:",
      err,
    );
  }

  try {
    const alerts = await getAdminModelAlerts();
    await checkAndNotifyTelegramAlerts(alerts);
    return NextResponse.json({
      ok: true,
      alertCount: alerts.length,
      stuckSessionsRekicked,
    });
  } catch (err) {
    console.error("[cron/telegram-alerts] failed:", err);
    return NextResponse.json({ ok: false, stuckSessionsRekicked }, { status: 500 });
  }
}
