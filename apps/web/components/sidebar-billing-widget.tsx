"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { cn } from "@/lib/utils";

interface BillingMeResponse {
  plan: string;
  planName: string;
  creditBalanceCents: number;
  creditGrantCents: number;
}

function formatUsd(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  });
}

/**
 * Per-plan visual identity, shared by the balance pill and the plan
 * badge below. Free is deliberately muted (it's a trial, not something
 * to make aspirational); Plus/Pro/Max step up in saturation so upgrading
 * visibly "feels" like an upgrade. Max gets the full gradient treatment
 * as the flagship tier. All colors are theme tokens from this repo's
 * Tailwind config (bg-muted, border-border, text-foreground, etc. plus
 * the accent hues), not one-off hardcoded values.
 */
const PLAN_STYLES: Record<string, { badge: string }> = {
  free: {
    badge: "bg-muted text-muted-foreground",
  },
  plus: {
    badge: "bg-blue-500/15 text-blue-400",
  },
  pro: {
    badge: "bg-violet-500/15 text-violet-400",
  },
  max: {
    badge:
      "bg-gradient-to-r from-amber-400/20 via-orange-400/20 to-pink-500/20 text-amber-400",
  },
};

/**
 * Compact credit-balance pill shown in the sidebar's profile footer, next
 * to the settings gear button (moved here 2026-08-17, owner feedback:
 * didn't like it sitting in the "Sessions" header next to the
 * new-session button). Just the number, in a small rounded pill using
 * the repo's own muted/border/foreground tokens -- no progress bar, no
 * plan name (that's next to the username, see SidebarPlanBadge below).
 * Deliberately NOT a link to /billing/plans (owner feedback 2026-08-17:
 * clicking the balance shouldn't jump straight to the plans page) --
 * it's just a read-only glance at your current balance. The plan name
 * next to the username (SidebarPlanBadge below) and the billing page
 * reachable from settings remain the actual upgrade entry points.
 */
export function SidebarBalancePill() {
  const { data, isLoading } = useSWR<BillingMeResponse>(
    "/api/billing/me",
    fetcher,
    { refreshInterval: 60_000 },
  );

  if (isLoading || !data) {
    return (
      <div className="h-6 w-14 shrink-0 animate-pulse rounded-full bg-muted" />
    );
  }

  return (
    <div
      title="Current credit balance"
      className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-semibold tabular-nums text-foreground"
    >
      {formatUsd(data.creditBalanceCents)}
    </div>
  );
}

/**
 * Small plan-name tag rendered right next to the username in the
 * profile footer row (moved here 2026-08-16 from the old standalone
 * sidebar card, per owner request to put the tier name "near the user").
 * Renders nothing while loading or for an unknown plan key, rather than
 * a placeholder skeleton -- this sits inline with text, not as its own
 * block.
 */
export function SidebarPlanBadge() {
  const { data, isLoading } = useSWR<BillingMeResponse>(
    "/api/billing/me",
    fetcher,
    { refreshInterval: 60_000 },
  );

  if (isLoading || !data) {
    return null;
  }

  const style = PLAN_STYLES[data.plan] ?? PLAN_STYLES.free;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        style.badge,
      )}
    >
      {data.planName}
    </span>
  );
}
