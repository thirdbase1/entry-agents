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
 * Per-plan visual identity for the sidebar widget. Free is deliberately
 * muted (it's a trial, not something to make aspirational); Plus/Pro/Max
 * step up in saturation so upgrading visibly "feels" like an upgrade.
 * Max gets the full gradient treatment as the flagship tier.
 */
const PLAN_STYLES: Record<
  string,
  { ring: string; bar: string; badge: string; icon: typeof Sparkles }
> = {
  free: {
    ring: "border-border",
    bar: "bg-muted-foreground/40",
    badge: "bg-muted text-muted-foreground",
    icon: Zap,
  },
  plus: {
    ring: "border-blue-500/30",
    bar: "bg-blue-500",
    badge: "bg-blue-500/15 text-blue-400",
    icon: Zap,
  },
  pro: {
    ring: "border-violet-500/30",
    bar: "bg-violet-500",
    badge: "bg-violet-500/15 text-violet-400",
    icon: Sparkles,
  },
  max: {
    ring: "border-amber-500/40",
    bar: "bg-gradient-to-r from-amber-400 via-orange-400 to-pink-500",
    badge:
      "bg-gradient-to-r from-amber-400/20 via-orange-400/20 to-pink-500/20 text-amber-400",
    icon: Sparkles,
  },
};

/**
 * Compact plan + credit balance card shown in the main chat sidebar,
 * just above the user profile footer. Replaces the earlier settings-page
 * placement (2026-08-16, owner feedback: wanted it somewhere more
 * visible/prominent, not tucked into settings). Doubles as an
 * upgrade/top-up entry point via the /billing/plans link.
 */
export function SidebarBillingWidget() {
  const { data, isLoading } = useSWR<BillingMeResponse>(
    "/api/billing/me",
    fetcher,
    { refreshInterval: 60_000 },
  );

  if (isLoading || !data) {
    return (
      <div className="mx-3 mb-2 h-[58px] animate-pulse rounded-xl border border-border bg-muted/30" />
    );
  }

  const style = PLAN_STYLES[data.plan] ?? PLAN_STYLES.free;
  const Icon = style.icon;
  const pct =
    data.creditGrantCents > 0
      ? Math.max(
          0,
          Math.min(100, (data.creditBalanceCents / data.creditGrantCents) * 100),
        )
      : 0;

  return (
    <Link
      href="/billing/plans"
      className={cn(
        "mx-3 mb-2 block rounded-xl border bg-gradient-to-b from-muted/50 to-muted/20 px-3 py-2.5 transition-colors hover:bg-muted/40",
        style.ring,
      )}
    >
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
            style.badge,
          )}
        >
          <Icon className="h-3 w-3" />
          {data.planName}
        </span>
        <span className="text-sm font-semibold tabular-nums text-foreground">
          {formatUsd(data.creditBalanceCents)}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/15">
        <div
          className={cn("h-full rounded-full transition-all", style.bar)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </Link>
  );
}
