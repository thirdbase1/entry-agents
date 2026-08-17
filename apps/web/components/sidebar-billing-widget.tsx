"use client";

import Link from "next/link";
import { Sparkles, Zap } from "lucide-react";
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
const PLAN_STYLES: Record<
  string,
  { badge: string; icon: typeof Sparkles }
> = {
  free: {
    badge: "bg-muted text-muted-foreground",
    icon: Zap,
  },
  plus: {
    badge: "bg-blue-500/15 text-blue-400",
    icon: Zap,
  },
  pro: {
    badge: "bg-violet-500/15 text-violet-400",
    icon: Sparkles,
  },
  max: {
    badge:
      "bg-gradient-to-r from-amber-400/20 via-orange-400/20 to-pink-500/20 text-amber-400",
    icon: Sparkles,
  },
};

/**
 * Compact credit-balance pill shown in the sidebar's "Sessions" header,
 * next to the new-session button. Replaces the old card-style widget
 * that sat above the profile footer (2026-08-16, owner feedback: didn't
 * like the card+bar treatment there). Just the number, in a small
 * rounded pill using the repo's own muted/border/foreground tokens --
 * no progress bar, no plan name (that moved next to the username in the
 * profile footer, see SidebarPlanBadge below). Still links to
 * /billing/plans as the upgrade/top-up entry point.
 */
export function SidebarBalancePill() {
  const { data, isLoading } = useSWR<BillingMeResponse>(
    "/api/billing/me",
    fetcher,
    { refreshInterval: 60_000 },
  );

  if (isLoading || !data) {
    return (
      <div className="h-6 w-14 animate-pulse rounded-full bg-muted" />
    );
  }

  return (
    <Link
      href="/billing/plans"
      className="flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs font-semibold tabular-nums text-foreground transition-colors hover:bg-muted/70"
    >
      <Zap className="h-3 w-3 text-primary" />
      {formatUsd(data.creditBalanceCents)}
    </Link>
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
  const Icon = style.icon;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        style.badge,
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {data.planName}
    </span>
  );
}
