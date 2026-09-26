import { nanoid } from "nanoid";
import { getServerSession } from "@/lib/session/get-server-session";
import { createCheckoutSession } from "@/lib/billing/bachs";
import { PLAN_CATALOG, isPlanId } from "@/lib/billing/plans";

interface CheckoutRequest {
  /** One of "plus" | "goat" | "pro" | "max" for a subscription checkout. */
  planId?: string;
  /** For a one-off wallet top-up instead of a subscription. $1 = $1, so this is the exact credit granted. */
  topupAmountCents?: number;
}

/**
 * Starts a Bachs hosted checkout.
 *
 * The whole NGN/USD bridge that used to live here is gone: Bachs prices
 * in USD and, with adaptive_pricing enabled on the account (confirmed via
 * GET /v1/accounts/me), converts to whatever currency the customer pays
 * in. So the amount we quote and the amount we credit are the same number
 * -- there is no FX drift window to close with metadata any more, and
 * usdAmountCents now exists only as a belt-and-braces copy of the amount.
 *
 * Fulfilment still comes from the webhook; the redirect only paints the
 * result. See lib/billing/bachs.ts for the contract details.
 */
export async function POST(req: Request) {
  const session = await getServerSession();
  if (!session?.user?.id || !session.user.email) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as CheckoutRequest;
  const origin = new URL(req.url).origin;
  const successUrl = `${origin}/billing/callback`;
  const cancelUrl = `${origin}/pricing`;

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
      const result = await createCheckoutSession({
        reference,
        email: session.user.email,
        amountCents: body.topupAmountCents,
        successUrl,
        cancelUrl,
        metadata: {
          userId: session.user.id,
          kind: "topup",
          usdAmountCents: String(body.topupAmountCents),
        },
      });

      return Response.json({
        checkoutId: result.checkoutId,
        checkoutUrl: result.checkoutUrl,
        reference,
        usdAmountCents: body.topupAmountCents,
        currency: "USD",
      });
    }

    if (!isPlanId(body.planId) || body.planId === "free") {
      return Response.json(
        { error: "planId must be one of plus, goat, pro, max" },
        { status: 400 },
      );
    }

    const plan = PLAN_CATALOG[body.planId];

    // A subscription MUST ride a recurring product: Bachs has no
    // create-subscription endpoint, and a cart containing a product with a
    // billing_cycle is what turns the checkout into a subscription
    // checkout. Without a product id we would silently charge a one-off
    // amount and leave the user on Free -- so refuse loudly instead.
    if (!plan.bachsProductId) {
      return Response.json(
        {
          error: `Plan "${plan.id}" has no Bachs product configured. Create a recurring product for it in the Bachs dashboard and set bachsProductId in lib/billing/plans.ts.`,
        },
        { status: 500 },
      );
    }

    const reference = `sub_${plan.id}_${session.user.id}_${nanoid()}`;
    const result = await createCheckoutSession({
      reference,
      email: session.user.email,
      amountCents: plan.priceUsdCents,
      productId: plan.bachsProductId,
      successUrl,
      cancelUrl,
      metadata: {
        userId: session.user.id,
        kind: "subscription",
        planId: plan.id,
        usdAmountCents: String(plan.priceUsdCents),
      },
    });

    return Response.json({
      checkoutId: result.checkoutId,
      checkoutUrl: result.checkoutUrl,
      reference,
      usdAmountCents: plan.priceUsdCents,
      currency: "USD",
    });
  } catch (error) {
    console.error("[billing] checkout creation failed:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Checkout failed",
      },
      { status: 500 },
    );
  }
}
