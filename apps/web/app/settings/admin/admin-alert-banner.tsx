"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { getAdminAlerts } from "@/lib/admin/actions";
import type { AdminModelAlertRow } from "@/lib/db/admin-activity";

const POLL_INTERVAL_MS = 60_000;

/**
 * Sticky red banner that fires when any model's error rate has crossed
 * the alert threshold in the last 24h (see MODEL_ALERT_* constants in
 * lib/db/admin-activity.ts). Polls every minute so a regression shows up
 * without a manual refresh. There's no outbound notification channel
 * wired up yet (email is currently broken -- see SendByte incident
 * notes), so this in-app banner is the alert surface for now.
 */
export function AdminAlertBanner() {
  const [alerts, setAlerts] = useState<AdminModelAlertRow[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const rows = await getAdminAlerts();
        if (!cancelled) setAlerts(rows);
      } catch {
        // Silently skip -- the rest of the dashboard already surfaces
        // load errors per-section; this banner just stays empty.
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (alerts.length === 0) {
    return null;
  }

  return (
    <div className="flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        <p className="font-medium">
          {alerts.length === 1
            ? "1 model is failing above threshold"
            : `${alerts.length} models are failing above threshold`}
        </p>
        <ul className="space-y-0.5 text-destructive/90">
          {alerts.map((alert) => (
            <li key={alert.modelId}>
              <span className="font-medium">{alert.modelId}</span> —{" "}
              {alert.errorRatePct.toFixed(1)}% error rate ({alert.failedRuns}/
              {alert.totalRuns} runs, last {alert.windowHours}h)
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
