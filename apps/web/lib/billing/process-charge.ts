import "server-only";

import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { paystackWebhookEvents } from "@/lib/db/schema";
import {
  applyTopup,
  grantSubscriptionRenewal,
  setPaystackCustomerCode,
  findUserIdByPaystackCustomerCode,
} from "@/lib/billing/credit-ledger";
import { isPlanId, PLAN_CATALOG } from "@/lib/billing/plans";

export interface ChargeOutcome {
  reference: string;
  customerCode: string | null;
  metadataUserId: string | null;
  metadataKind: string | null;
  metadataPlanId: string | null;
  metadataUsdAmountCents: number | null;
  planCode: string | null;
  /** Fallback credit amount if metadataUsdAmountCents is missing (should only happen for out-of-band/legacy charges). */
  fallbackAmountCents: number;
}

/**
 * Shared successful-charge handler used by both the Paystack webhook
 * (app/api/billing/webhook/route.ts, the source of truth) and the
 * checkout callback page (app/billing/callback/page.tsx, for instant
 * user-facing feedback instead of waiting on the async webhook).
 * Idempotent via paystack_webhook_events's unique paystackEventId --
 * whichever of the two fires first wins, the other is a no-op.
 */
export async function processChargeSuccess(
  outcome: ChargeOutcome,
): Promise<{ credited: boolean; alreadyProcessed: boolean }> {
  const eventKey = `charge.success:${outcome.reference}`;

  try {
    await db.insert(paystackWebhookEvents).values({
      id: nanoid(),
      paystackEventId: eventKey,
      eventType: "charge.success",
      payload: outcome as unknown as Record<string, unknown>,
    });
  } catch {
    // Unique constraint violation -- already processed by the other path.
    return { credited: false, alreadyProcessed: true };
  }

  if (!outcome.customerCode) {
    return { credited: false, alreadyProcessed: false };
  }

  const userId =
    outcome.metadataUserId ??
    (await findUserIdByPaystackCustomerCode(outcome.customerCode));

  if (!userId) {
    console.warn(
      "[billing] charge.success: no matching user for customer",
      outcome.customerCode,
    );
    return { credited: false, alreadyProcessed: false };
  }

  await setPaystackCustomerCode(userId, outcome.customerCode);

  if (outcome.metadataKind === "topup") {
    const usdAmountCents =
      outcome.metadataUsdAmountCents ?? outcome.fallbackAmountCents;
    await applyTopup(userId, usdAmountCents, outcome.reference);
    return { credited: true, alreadyProcessed: false };
  }

  const planId =
    outcome.metadataPlanId && isPlanId(outcome.metadataPlanId)
      ? outcome.metadataPlanId
      : Object.values(PLAN_CATALOG).find(
          (p) => p.paystackPlanCode === outcome.planCode,
        )?.id;

  if (!planId) {
    console.warn("[billing] charge.success with unresolved planId", {
      reference: outcome.reference,
      planCode: outcome.planCode,
    });
    return { credited: false, alreadyProcessed: false };
  }

  await grantSubscriptionRenewal(userId, planId, outcome.reference);
  return { credited: true, alreadyProcessed: false };
}
