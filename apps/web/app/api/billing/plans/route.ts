import { PLAN_CATALOG, PLAN_IDS } from "@/lib/billing/plans";

/**
 * Public (no auth) -- just pricing info for the /pricing page.
 *
 * USD only. The NGN/USD rate that used to be served here existed purely
 * because the Paystack account could only charge in NGN; Bachs prices in
 * USD and converts to the customer's local currency at checkout
 * (adaptive_pricing is on for this account), so there is no rate for the
 * client to display or for us to be wrong about.
 */
export async function GET() {
  const plans = PLAN_IDS.map((id) => {
    const plan = PLAN_CATALOG[id];
    return {
      id: plan.id,
      name: plan.name,
      priceUsdCents: plan.priceUsdCents,
      creditGrantCents: plan.creditGrantCents,
      modelAccess: plan.modelAccess,
    };
  });

  return Response.json({ plans });
}
