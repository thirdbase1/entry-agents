import { PLAN_CATALOG, PLAN_IDS } from "@/lib/billing/plans";
import { getUsdToNgnRate } from "@/lib/billing/fx";

/** Public (no auth) -- just pricing info, used by the /billing/plans page to show live NGN prices before checkout. */
export async function GET() {
  const rate = await getUsdToNgnRate();

  const plans = PLAN_IDS.map((id) => {
    const plan = PLAN_CATALOG[id];
    return {
      id: plan.id,
      name: plan.name,
      priceUsdCents: plan.priceUsdCents,
      creditGrantCents: plan.creditGrantCents,
      modelAccess: plan.modelAccess,
      priceNgnKobo: Math.round(plan.priceUsdCents * rate),
    };
  });

  return Response.json({ plans, usdToNgnRate: rate });
}
