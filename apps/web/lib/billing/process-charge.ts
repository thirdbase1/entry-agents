import "server-only";

import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { billingWebhookEvents } from "@/lib/db/schema";
import {
  applyTopup,
  grantSubscriptionRenewal,
  setBillingCustomerCode,
  findUserIdByBillingCustomerCode,
} from "@/lib/billing/credit-ledger";
import { isPlanId, PLAN_CATALOG } from "@/lib/billing/plans";

export interface ChargeOutcome {
  /** Our own reference (topup_ or sub_ prefixed), carried on the checkout session. */
  reference: string;
  /** Bachs customer record id (cust_...), or null before identity exists. */
  customerId: string | null;
  metadataUserId: string | null;
  metadataKind: string | null;
  metadataPlanId: string | null;
  metadataUsdAmountCents: number | null;
  /** Bachs product id (prod_...) -- used to resolve the plan when metadata is absent. */
  productId: string | null;
  /**
   * Credit amount when metadataUsdAmountCents is missing. Callers must
   * pass null (not a raw provider amount) whenever the amount is not
   * priced in USD -- the old Paystack path fed NGN kobo into this field
   * and would have credited ~1650x too much.
   */
  fallbackAmountCents: number | null;
}

/**
 * Shared successful-charge handler used by both the Bachs webhook
 * (app/api/billing/webhook/route.ts, the source of truth) and the checkout
 * callback (app/billing/callback/page.tsx, for instant user-facing feedback
 * instead of waiting on the async webhook).
 *
 * Idempotent via billing_webhook_events' unique eventKey -- whichever of the
 * two fires first wins and the other is a no-op. Claim BEFORE doing any work
 * so a concurrent verify + webhook cannot double-credit.
 */
export async function processChargeSuccess(
  outcome: ChargeOutcome,
): Promise<{ credited: boolean; alreadyProcessed: boolean }> {
  const eventKey = `collection.succeeded:${outcome.reference}`;

  try {
    await db.insert(billingWebhookEvents).values({
      id: nanoid(),
      eventKey,
      eventType: "collection.succeeded",
      payload: outcome as unknown as Record<string, unknown>,
    });
  } catch {
    // Unique constraint violation -- already processed by the other path.
    return { credited: false, alreadyProcessed: true };
  }

  if (!outcome.customerId && !outcome.metadataUserId) {
    return { credited: false, alreadyProcessed: false };
  }

  const userId =
    outcome.metadataUserId ??
    (outcome.customerId
      ? await findUserIdByBillingCustomerCode(outcome.customerId)
      : null);

  if (!userId) {
    console.warn(
      "[billing] collection.succeeded: no matching user for customer",
      outcome.customerId,
    );
    return { credited: false, alreadyProcessed: false };
  }

  if (outcome.customerId) {
    await setBillingCustomerCode(userId, outcome.customerId);
  }

  if (outcome.metadataKind === "topup") {
    const usdAmountCents =
      outcome.metadataUsdAmountCents ?? outcome.fallbackAmountCents;
    if (usdAmountCents === null) {
      // Refuse rather than guess: an unpriced top-up must not silently
      // credit zero (or an amount we cannot justify in USD cents).
      console.error(
        "[billing] top-up with no resolvable USD amount",
        { reference: outcome.reference },
      );
      return { credited: false, alreadyProcessed: false };
    }
    await applyTopup(userId, usdAmountCents, outcome.reference);
    return { credited: true, alreadyProcessed: false };
  }

  const planId =
    outcome.metadataPlanId && isPlanId(outcome.metadataPlanId)
      ? outcome.metadataPlanId
      : Object.values(PLAN_CATALOG).find(
          (p) => p.bachsProductId === outcome.productId,
        )?.id;

  if (!planId) {
    console.warn("[billing] collection.succeeded with unresolved planId", {
      reference: outcome.reference,
      productId: outcome.productId,
    });
    return { credited: false, alreadyProcessed: false };
  }

  await grantSubscriptionRenewal(userId, planId, outcome.reference);
  return { credited: true, alreadyProcessed: false };
}
