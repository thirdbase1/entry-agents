import { getServerSession } from "@/lib/session/get-server-session";
import { getCheckoutSession } from "@/lib/billing/bachs";
import { processChargeSuccess } from "@/lib/billing/process-charge";
import { getUserBillingState } from "@/lib/billing/credit-ledger";

/**
 * Called by the checkout callback page right after Bachs redirects the
 * user back (?checkout_id= appended to success_url), so they see an
 * immediate result instead of waiting on the async webhook -- which is
 * still the source of truth and will no-op via the shared idempotency
 * claim if it has already landed.
 */
export async function GET(req: Request) {
  const session = await getServerSession();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const checkoutId = new URL(req.url).searchParams.get("checkout_id");
  if (!checkoutId) {
    return Response.json({ error: "Missing checkout_id" }, { status: 400 });
  }

  try {
    const checkout = await getCheckoutSession(checkoutId);
    const metadata = checkout.metadata ?? {};

    // SECURITY (2026-08-27, pentest finding): never reveal anything about
    // a transaction the caller does not own. Anyone holding another
    // user's checkout id could otherwise probe this endpoint to learn
    // whether that payment succeeded. Crediting itself was never at risk
    // (processChargeSuccess only ever credits metadata.userId from
    // Bachs' own session), but the status leak is real. Require
    // metadata.userId to match the caller before saying anything.
    if (metadata.userId !== session.user.id) {
      return Response.json({ error: "Not authorized for this checkout" }, { status: 403 });
    }

    // `completed` is the terminal paid state on the session object;
    // charge.status is lowercase here (succeeded) while the webhook's
    // data.status is UPPERCASE (SUCCEEDED), so never compare them.
    if (checkout.status !== "completed") {
      return Response.json({
        status: checkout.status,
        credited: false,
      });
    }

    await processChargeSuccess({
      reference: checkout.reference ?? checkout.checkoutId,
      customerId: checkout.customerId,
      metadataUserId:
        typeof metadata.userId === "string" ? metadata.userId : null,
      metadataKind: typeof metadata.kind === "string" ? metadata.kind : null,
      metadataPlanId:
        typeof metadata.planId === "string" ? metadata.planId : null,
      metadataUsdAmountCents:
        typeof metadata.usdAmountCents === "string" &&
        Number.isFinite(Number(metadata.usdAmountCents))
          ? Number(metadata.usdAmountCents)
          : null,
      productId: null,
      // Decimal string in checkout.currency. Only consulted when
      // metadata.usdAmountCents is missing, and only meaningful when the
      // session was priced in USD -- a non-USD amount must never be read
      // as USD cents (that is how the old Paystack path over-credited).
      fallbackAmountCents: usdDecimalToCents(
        checkout.amount,
        checkout.currency,
      ),
    });

    const billingState = await getUserBillingState(session.user.id);

    return Response.json({
      status: "success",
      creditBalanceCents: billingState?.creditBalanceCents ?? null,
      plan: billingState?.plan ?? null,
    });
  } catch (error) {
    console.error("[billing/verify] Failed to verify checkout:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Verify failed" },
      { status: 500 },
    );
  }
}

/** "10.50" USD -> 1050. Null when the amount is not USD (never treat NGN as cents). */
function usdDecimalToCents(amount: string, currency: string): number | null {
  if (currency !== "USD") return null;
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}
