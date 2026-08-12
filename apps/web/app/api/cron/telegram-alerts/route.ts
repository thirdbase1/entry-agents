import { NextResponse } from "next/server";
import { getAdminModelAlerts } from "@/lib/db/admin-activity";
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
 * Vercel automatically sends `Authorization: Bearer ${CRON_SECRET}` on
 * cron-triggered requests when CRON_SECRET is set -- reject anything else
 * so this can't be used as an open, unauthenticated way to spam the
 * Telegram chat.
 */
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get("authorization");
    if (authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const alerts = await getAdminModelAlerts();
    await checkAndNotifyTelegramAlerts(alerts);
    return NextResponse.json({ ok: true, alertCount: alerts.length });
  } catch (err) {
    console.error("[cron/telegram-alerts] failed:", err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
