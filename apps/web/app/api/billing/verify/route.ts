import { getServerSession } from "@/lib/session/get-server-session";
import { verifyTransaction } from "@/lib/billing/paystack";
import { processChargeSuccess } from "@/lib/billing/process-charge";
import { getUserBillingState } from "@/lib/billing/credit-ledger";

/**
 * Called by the checkout callback page right after Paystack redirects
 * the user back, so they see an immediate result instead of waiting on
 * the async webhook (which is still the source of truth and will
 * no-op here via the shared idempotency claim if it's already landed).
 */
export async function GET(req: Request) {
  const session = await getServerSession();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const reference = new URL(req.url).searchParams.get("reference");
  if (!reference) {
    return Response.json({ error: "Missing reference" }, { status: 400 });
  }

  try {
    const verified = await verifyTransaction(reference);
    const metadata = verified.metadata ?? {};

    // SECURITY FIX (2026-08-27, pentest finding): this route trusted
    // whatever `reference` string the client passed with no check that
    // it actually belongs to the caller's own transaction -- any
    // authenticated user who obtained (guessed, leaked callback URL,
    // shared support ticket, etc.) another user's Paystack reference
    // could probe this endpoint to learn whether that other person's
    // payment succeeded or failed. Crediting itself was never at risk
    // (processChargeSuccess only ever credits metadata.userId from
    // Paystack's own verified transaction, never the caller's session),
    // but the status leak is real. Require metadata.userId to match the
    // caller before revealing anything about this transaction.
    if (metadata.userId !== session.user.id) {
      return Response.json(
        { error: "Not authorized for this reference" },
        {
          status: 403,
        },
      );
    }

    if (verified.status !== "success") {
      return Response.json({
        status: verified.status,
        credited: false,
      });
    }
    await processChargeSuccess({
      reference: verified.reference,
      customerCode: verified.customerCode,
      metadataUserId:
        typeof metadata.userId === "string" ? metadata.userId : null,
      metadataKind: typeof metadata.kind === "string" ? metadata.kind : null,
      metadataPlanId:
        typeof metadata.planId === "string" ? metadata.planId : null,
      metadataUsdAmountCents:
        typeof metadata.usdAmountCents === "number"
          ? metadata.usdAmountCents
          : null,
      planCode: verified.planCode,
      fallbackAmountCents: verified.amountCents,
    });

    const billingState = await getUserBillingState(session.user.id);

    return Response.json({
      status: "success",
      creditBalanceCents: billingState?.creditBalanceCents ?? null,
      plan: billingState?.plan ?? null,
    });
  } catch (error) {
    console.error("[billing/verify] Failed to verify transaction:", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Verify failed" },
      { status: 500 },
    );
  }
}
