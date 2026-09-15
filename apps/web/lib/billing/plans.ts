/**
 * The four subscription plans Entry offers, backed by Paystack for
 * checkout/renewal (see lib/billing/paystack.ts) and a per-user credit
 * ledger (see lib/billing/credit-ledger.ts) for enforcement.
 *
 * Design (owner-confirmed 2026-08-16):
 * - Free: $0, one-time $1 trial credit, restricted to a single model
 *   (FREE_PLAN_MODEL_ID -- GPT-5.6 Luna). When the trial credit hits
 *   zero, the user is hard-blocked (composer blurred, "Free tier ended,
 *   upgrade your account to use Entry") -- see resolveChatModelRuntime in
 *   app/workflows/chat.ts, which reuses the existing free-tier-gate error
 *   marker/UI for this.
 * - GOAT (added 2026-09-15, owner request; publicly NAMED "Entry" since
 *   same-day owner request -- the id stays "goat" forever): the Command
 *   Code GOAT-plan
 *   model integrated into Entry -- a $10/mo tier that grants $50 of
 *   credit per renewal (a 5x bonus, deliberately breaking the flat 2x
 *   rule the other tiers use; it's the volume bait tier that gets users
 *   to upgrade from Plus). Still a single spendable balance: no
 *   Command-Code-style 5h/weekly sub-windows -- Entry's existing
 *   per-turn spend cap and hard stop-at-zero already bound worst-case
 *   exposure to the same class as the Max tier.
 * - Plus/GOAT("Entry")/Pro/Max: paid, full access to every model in the live catalog
 *   (including all FreeModel-sourced GPT-5.6 + Claude models once those
 *   routes are enabled on the gateway). They differ only by price and
 *   how much credit each renewal grants. Retuned 2026-09-15 (owner
 *   approved): GOAT's bonus broke the old flat-2x rule -- the ladder
 *   is now Plus $5->$10 (2x), GOAT $10->$50 (5x), Pro $20->$100 (5x),
 *   Max $40->$180 (4.5x), strictly increasing in absolute credit. If a paid user's balance hits
 *   zero mid-cycle, they are hard-blocked exactly like the free plan
 *   (composer locked, "You're out of credit") until they top up
 *   ($1 = $1) or the next renewal grants fresh credit. Soft-cutoff
 *   (silently downgrading to a cheap fallback model instead of
 *   blocking) was REMOVED per owner instruction on 2026-08-17.
 */

export type PlanId = "free" | "plus" | "goat" | "pro" | "max";

/**
 * Rolling usage windows -- exclusive to the "Entry" plan, id goat
 * (owner request 2026-09-15).
 * A plan with usageWindows can spend at most
 * fiveHourLimitCents in any trailing 5-hour stretch, weeklyLimitCents in
 * any trailing 7 days, and monthlyLimitCents in any trailing 30 days --
 * enforced at the pre-turn billing gate in resolveChatModelRuntime by
 * summing usage_debit rows from credit_transactions (one indexed
 * aggregate query). The monthly window equals the plan's grant, so a
 * fresh cycle always starts clean; the 5h/weekly windows pace the spend
 * at 20%/50% of the grant.
 */
export interface PlanUsageWindows {
  /** Max spend in any trailing 5-hour window, USD cents. */
  fiveHourLimitCents: number;
  /** Max spend in any trailing 7-day window, USD cents. */
  weeklyLimitCents: number;
  /** Max spend in any trailing 30-day window, USD cents. */
  monthlyLimitCents: number;
}

export type ExceededUsageWindow = "fiveHour" | "weekly" | "monthly" | null;

/**
 * Sums of trailing usage_debit spend, produced by
 * getUsageWindowTotals() in credit-ledger.ts.
 */
export interface UsageWindowTotals {
  /** Total usage_debit spend in the trailing 5 hours, USD cents. */
  last5HoursCents: number;
  /** Total usage_debit spend in the trailing 7 days, USD cents. */
  last7DaysCents: number;
  /** Total usage_debit spend in the trailing 30 days, USD cents. */
  last30DaysCents: number;
}

/**
 * Pure decision helper for the pre-turn gate: returns which (if any)
 * rolling window is already at its limit, nearest-reset window first so
 * the error message matches the soonest refill.
 */
export function findExceededUsageWindow(
  totals: UsageWindowTotals,
  windows: PlanUsageWindows,
): ExceededUsageWindow {
  if (totals.last5HoursCents >= windows.fiveHourLimitCents) {
    return "fiveHour";
  }
  if (totals.last7DaysCents >= windows.weeklyLimitCents) {
    return "weekly";
  }
  if (totals.last30DaysCents >= windows.monthlyLimitCents) {
    return "monthly";
  }
  return null;
}

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Monthly subscription price, in USD cents. 0 for the free plan. */
  priceUsdCents: number;
  /** Credit granted on signup (free) or each successful renewal (paid), in USD cents. */
  creditGrantCents: number;
  /** "luna-only" hard-restricts to FREE_PLAN_MODEL_ID; "all" is unrestricted. */
  modelAccess: "luna-only" | "all";
  /**
   * Optional rolling usage windows (see PlanUsageWindows). Currently
   * Entry-plan-only (id "goat"): every other plan keeps simple
   * stop-at-zero balance billing; the Entry plan additionally paces
   * usage over sliding 5-hour / weekly / monthly windows -- the limit
   * style that makes it different from every other plan.
   */
  usageWindows?: PlanUsageWindows;
  /**
   * Paystack plan code, created once via lib/billing/paystack.ts's
   * ensurePaystackPlans() and then pinned here. Null until that's run
   * against a real Paystack account.
   */
  paystackPlanCode: string | null;
}

export const PLAN_CATALOG: Record<PlanId, PlanDefinition> = {
  free: {
    id: "free",
    name: "Free",
    priceUsdCents: 0,
    creditGrantCents: 100, // $1 one-time trial
    modelAccess: "luna-only",
    paystackPlanCode: null,
  },
  plus: {
    id: "plus",
    name: "Plus",
    priceUsdCents: 500, // $5/mo
    creditGrantCents: 1000, // $10 credit (2x)
    modelAccess: "all",
    paystackPlanCode: null,
  },
  goat: {
    id: "goat",
    // Owner request 2026-09-15: this plan is publicly named "Entry"
    // (the flagship plan of the app). The internal id stays "goat"
    // forever -- users.plan rows in the DB, Paystack plan codes and the
    // checkout flow all key on the id, never the display name.
    name: "Entry",
    priceUsdCents: 1000, // $10/mo
    creditGrantCents: 5000, // $50 credit (5x) -- Command Code GOAT-style
    // tier; grant tuned from $70 (7x) to $50 on owner request 2026-09-15
    modelAccess: "all",
    // Entry Windows (2026-09-15, owner request): rolling usage pacing,
    // GOAT-exclusive. 20% / 50% / 100% of the $50 grant.
    usageWindows: {
      fiveHourLimitCents: 1000, // $10 per trailing 5 hours
      weeklyLimitCents: 2500, // $25 per trailing 7 days
      monthlyLimitCents: 5000, // $50 per trailing 30 days
    },
    paystackPlanCode: null,
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceUsdCents: 2000, // $20/mo
    creditGrantCents: 10000, // $100 credit (5x) -- retuned 2026-09-15 so the
    // ladder stays ordered above GOAT ($10 buys $50); the old 2x $30 grant
    // was strictly dominated by GOAT at two-thirds of the price.
    modelAccess: "all",
    paystackPlanCode: null,
  },
  max: {
    id: "max",
    name: "Max",
    priceUsdCents: 4000, // $40/mo
    creditGrantCents: 18000, // $180 credit (4.5x) -- retuned 2026-09-15,
    // same reason as Pro: the old flat-2x grant at $35 was dominated by GOAT.
    modelAccess: "all",
    paystackPlanCode: null,
  },
};

export const PLAN_IDS = Object.keys(PLAN_CATALOG) as PlanId[];

/** The only model a Free-plan user may select. Gateway route id (see entry-gateway EXTRA_MODEL_ROUTES_JSON_2). */
export const FREE_PLAN_MODEL_ID = "gpt-5.6-luna";

/**
 * Owner-sponsored free models (2026-08-19): in addition to
 * FREE_PLAN_MODEL_ID, Free-plan users may also select any model listed
 * here WITHOUT it being forced back to Luna by the luna-only gate below.
 * These models are $0 cost for every plan (Free AND paid) -- see
 * entry-gateway's EXTRA_MODEL_ROUTES_JSON_4, which sets cost.input/output
 * to 0 for these route ids -- the owner is paying for the underlying
 * tokens directly via their own Vercel AI Gateway account balance rather
 * than through Entry's credit ledger, so no per-plan billing logic is
 * needed here beyond just not force-swapping the model away from a
 * Free-plan user who picked it.
 *
 * ling-3.0-flash-free: routed through entry-gateway to Vercel's own AI
 * Gateway (inclusionai/ling-3.0-flash), re-enabled 2026-08-19 after being
 * admin-disabled since 2026-08-15 following an outage on its old
 * OpenCode Zen upstream -- that old route is kept as an automatic
 * lower-priority fallback candidate in the gateway config, not removed.
 */
export const FREE_TIER_ALLOWED_MODEL_IDS: readonly string[] = [
  FREE_PLAN_MODEL_ID,
  "ling-3.0-flash-free",
];

export function getPlanDefinition(
  planId: string | null | undefined,
): PlanDefinition {
  if (planId && planId in PLAN_CATALOG) {
    return PLAN_CATALOG[planId as PlanId];
  }
  return PLAN_CATALOG.free;
}

export function isPlanId(value: string | null | undefined): value is PlanId {
  return !!value && value in PLAN_CATALOG;
}
