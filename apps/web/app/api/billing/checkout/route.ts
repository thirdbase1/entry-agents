import { nanoid } from "nanoid";
import { getServerSession } from "@/lib/session/get-server-session";
import { initializeTransaction } from "@/lib/billing/paystack";
import { PLAN_CATALOG, isPlanId } from "@/lib/billing/plans";

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
      const result = await initializeTransaction({
        email: session.user.email,
        amountCents: body.topupAmountCents,
        reference,
        callbackUrl,
        metadata: {
          userId: session.user.id,
          kind: "topup",
        },
      });

      return Response.json(result);
    }

    if (!isPlanId(body.planId) || body.planId === "free") {
      return Response.json(
        { error: "planId must be one of plus, pro, max" },
        { status: 400 },
      );
    }

    const plan = PLAN_CATALOG[body.planId];
    const reference = `sub_${plan.id}_${session.user.id}_${nanoid()}`;
    const result = await initializeTransaction({
      email: session.user.email,
      amountCents: plan.priceUsdCents,
      reference,
      callbackUrl,
      metadata: {
        userId: session.user.id,
        kind: "subscription",
        planId: plan.id,
      },
      ...(plan.paystackPlanCode ? { planCode: plan.paystackPlanCode } : {}),
    });

    return Response.json(result);
  } catch (error) {
    console.error("[billing] checkout initialization failed:", error);
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Checkout failed",
      },
      { status: 500 },
    );
  }
}
