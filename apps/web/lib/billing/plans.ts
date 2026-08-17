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
 * - Plus/Pro/Max: paid, full access to every model in the live catalog
 *   (including all FreeModel-sourced GPT-5.6 + Claude models once those
 *   routes are enabled on the gateway). They differ only by price and
 *   how much credit each renewal grants -- a flat 2x bonus on every
 *   tier ("pay $X, get $2X to spend"). If a paid user's balance hits
 *   zero mid-cycle, they are hard-blocked exactly like the free plan
 *   (composer locked, "You're out of credit") until they top up
 *   ($1 = $1) or the next renewal grants fresh credit. Soft-cutoff
 *   (silently downgrading to a cheap fallback model instead of
 *   blocking) was REMOVED per owner instruction on 2026-08-17.
 */

export type PlanId = "free" | "plus" | "pro" | "max";

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
  pro: {
    id: "pro",
    name: "Pro",
    priceUsdCents: 1500, // $15/mo
    creditGrantCents: 3000, // $30 credit (2x)
    modelAccess: "all",
    paystackPlanCode: null,
  },
  max: {
    id: "max",
    name: "Max",
    priceUsdCents: 3500, // $35/mo
    creditGrantCents: 7000, // $70 credit (2x)
    modelAccess: "all",
    paystackPlanCode: null,
  },
};

export const PLAN_IDS = Object.keys(PLAN_CATALOG) as PlanId[];

/** The only model a Free-plan user may select. Gateway route id (see entry-gateway EXTRA_MODEL_ROUTES_JSON_2). */
export const FREE_PLAN_MODEL_ID = "gpt-5.6-luna";

export function getPlanDefinition(planId: string | null | undefined): PlanDefinition {
  if (planId && planId in PLAN_CATALOG) {
    return PLAN_CATALOG[planId as PlanId];
  }
  return PLAN_CATALOG.free;
}

export function isPlanId(value: string | null | undefined): value is PlanId {
  return !!value && value in PLAN_CATALOG;
}
