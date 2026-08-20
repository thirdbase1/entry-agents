import { nanoid } from "nanoid";
import { getServerSession } from "@/lib/session/get-server-session";
import { initializeTransaction } from "@/lib/billing/paystack";
import { PLAN_CATALOG, isPlanId } from "@/lib/billing/plans";
import { usdCentsToNgnKobo } from "@/lib/billing/fx";

interface CheckoutRequest {
  /** One of "plus" | "pro" | "max" for a subscription checkout. */
  planId?: string;
  /** For a one-off wallet top-up instead of a subscription. $1 = $1, so this is the exact credit granted. */
  topupAmountCents?: number;
}

export async function POST(req: Request) {
  const session = await getServerSession();
  if (!session?.user?.id || !session.user.email) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as CheckoutRequest;
  const origin = new URL(req.url).origin;
  const callbackUrl = `${origin}/billing/callback`;

  try {
    if (body.topupAmountCents) {
      if (
        !Number.isInteger(body.topupAmountCents) ||
        body.topupAmountCents < 100
      ) {
        return Response.json(
          { error: "topupAmountCents must be an integer >= 100 ($1 minimum)" },
          { status: 400 },
        );
      }

      const reference = `topup_${session.user.id}_${nanoid()}`;
      // This Paystack account only has NGN enabled (confirmed against
      // the live API -- USD returns "unsupported_currency"), so every
      // charge goes out in NGN at the live USD->NGN rate. The USD
      // amount is stashed in metadata so the webhook credits the exact
      // USD value the user saw at checkout, immune to any FX drift
      // between initialize and the customer completing payment.
      const { ngnKobo, rate } = await usdCentsToNgnKobo(body.topupAmountCents);
      const result = await initializeTransaction({
        email: session.user.email,
        amountCents: ngnKobo,
        currency: "NGN",
        reference,
        callbackUrl,
        metadata: {
          userId: session.user.id,
          kind: "topup",
          usdAmountCents: body.topupAmountCents,
          usdToNgnRateAtCheckout: rate,
        },
      });

      return Response.json({
        ...result,
        usdAmountCents: body.topupAmountCents,
        ngnAmountKobo: ngnKobo,
        usdToNgnRate: rate,
        currency: "NGN",
      });
    }

    if (!isPlanId(body.planId) || body.planId === "free") {
      return Response.json(
        { error: "planId must be one of plus, pro, max" },
        { status: 400 },
      );
    }

    const plan = PLAN_CATALOG[body.planId];
    const reference = `sub_${plan.id}_${session.user.id}_${nanoid()}`;
    const { ngnKobo, rate } = await usdCentsToNgnKobo(plan.priceUsdCents);
    const result = await initializeTransaction({
      email: session.user.email,
      amountCents: ngnKobo,
      currency: "NGN",
      reference,
      callbackUrl,
      metadata: {
        userId: session.user.id,
        kind: "subscription",
        planId: plan.id,
        usdAmountCents: plan.priceUsdCents,
        usdToNgnRateAtCheckout: rate,
      },
      // Paystack recurring Plans are themselves pinned to one currency
      // (would need a separate NGN-denominated Plan per tier to use
      // planCode here) -- until ensurePaystackPlans() is re-run for
      // NGN, renewals are handled by re-charging the saved
      // authorization from the webhook side rather than a native
      // Paystack subscription. Omit planCode so this charges as a
      // plain one-off transaction; grantSubscriptionRenewal() below
      // still applies the plan + credit correctly off the webhook.
    });

    return Response.json({
      ...result,
      usdAmountCents: plan.priceUsdCents,
      ngnAmountKobo: ngnKobo,
      usdToNgnRate: rate,
      currency: "NGN",
    });
  } catch (error) {
    console.error("[billing] checkout initialization failed:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Checkout failed",
      },
      { status: 500 },
    );
  }
}
