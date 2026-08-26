import "server-only";

import { createRedisClient, isRedisConfigured } from "@/lib/redis";
import type { AdminModelAlertRow } from "@/lib/db/admin-activity";

const COOLDOWN_SECONDS = 15 * 60;
const REDIS_KEY_LAST_SENT = "telegram:model-alerts:last-sent";
const REDIS_KEY_ACTIVE = "telegram:model-alerts:active";

export async function sendTelegramMessage(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!token || !chatId) {
    return false;
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
        }),
      },
    );
    if (!res.ok) {
      console.error(
        `[telegram-alerts] sendMessage failed (${res.status}): ${await res.text()}`,
      );
    }
    return res.ok;
  } catch (err) {
    console.error("[telegram-alerts] sendMessage threw:", err);
    return false;
  }
}

function formatAlertMessage(alerts: AdminModelAlertRow[]): string {
  const lines = alerts.map(
    (a) =>
      `• <b>${a.modelId}</b> — ${a.errorRatePct.toFixed(1)}% error rate (${a.failedRuns}/${a.totalRuns} runs, last ${a.windowHours}h)`,
  );
  return `🚨 <b>Entry model health alert</b>\n${alerts.length} model${alerts.length === 1 ? "" : "s"} failing above threshold:\n\n${lines.join("\n")}`;
}

/**
 * Checks the current model-alert state and pushes a Telegram notification
 * when appropriate. Called from:
 *  1. The admin dashboard's client-side poll (lib/admin/actions.ts ->
 *     getAdminAlerts()), giving near-real-time delivery whenever an admin
 *     has the dashboard open (polls every 60s).
 *  2. A once-daily Vercel Cron backstop (app/api/cron/telegram-alerts) --
 *     Hobby plan only allows 1 cron run/day, so this alone can't be the
 *     sole notification path, but it guarantees at least a daily nudge if
 *     nobody has the dashboard open while something is failing.
 *
 * De-dupes via Redis: re-sends at most once per COOLDOWN_SECONDS while an
 * alert stays continuously active, and always sends an immediate "resolved"
 * message the moment the alert set goes back to empty. Silently no-ops if
 * TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID / Redis aren't configured --
 * this is a best-effort side channel, never a blocking dependency for the
 * dashboard itself.
 */
export async function checkAndNotifyTelegramAlerts(
  alerts: AdminModelAlertRow[],
): Promise<void> {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_ALERT_CHAT_ID) {
    return;
  }
  if (!isRedisConfigured()) {
    return;
  }

  const redis = createRedisClient("telegram-alerts");
  try {
    const wasActive = (await redis.get(REDIS_KEY_ACTIVE)) === "1";

    if (alerts.length === 0) {
      if (wasActive) {
        await sendTelegramMessage(
          "✅ Entry model health alert cleared — all models are back under the error-rate threshold.",
        );
        await redis.del(REDIS_KEY_ACTIVE);
        await redis.del(REDIS_KEY_LAST_SENT);
      }
      return;
    }

    const lastSentRaw = await redis.get(REDIS_KEY_LAST_SENT);
    const lastSent = lastSentRaw ? Number.parseInt(lastSentRaw, 10) : 0;
    const now = Date.now();

    if (!wasActive || now - lastSent > COOLDOWN_SECONDS * 1000) {
      const sent = await sendTelegramMessage(formatAlertMessage(alerts));
      if (sent) {
        await redis.set(REDIS_KEY_LAST_SENT, String(now));
      }
    }

    await redis.set(REDIS_KEY_ACTIVE, "1", "EX", 60 * 60 * 24);
  } catch (err) {
    console.error("[telegram-alerts] check/notify failed:", err);
  } finally {
    redis.disconnect();
  }
}
