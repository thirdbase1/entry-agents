import "server-only";

import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import {
  billingWebhookEvents,
  creditTransactions,
  users,
} from "@/lib/db/schema";
import {
  getPlanDefinition,
  isPlanId,
  resolvePlanForProductId,
} from "@/lib/billing/plans";
import { findUserIdByBillingCustomerCode } from "@/lib/billing/credit-ledger";

export interface ChargeOutcome {
  reference: string;
  customerId: string | null;
  metadataUserId: string | null;
  metadataKind: string | null;
  metadataPlanId: string | null;
  metadataUsdAmountCents: number | null;
  productId: string | null;
  fallbackAmountCents: number | null;
}

/** Credits a successful charge atomically with its idempotency marker. */
export async function processChargeSuccess(
  outcome: ChargeOutcome,
): Promise<{ credited: boolean; alreadyProcessed: boolean }> {
  const eventKey = `collection.succeeded:${outcome.reference}`;
  const userId =
    outcome.metadataUserId ??
    (outcome.customerId
      ? await findUserIdByBillingCustomerCode(outcome.customerId)
      : null);

  if (!userId) {
    console.warn("[billing] collection.succeeded: no matching user", {
      customerId: outcome.customerId,
      reference: outcome.reference,
    });
    return { credited: false, alreadyProcessed: false };
  }

  const isTopup = outcome.metadataKind === "topup";
  const topupCents =
    outcome.metadataUsdAmountCents ?? outcome.fallbackAmountCents;
  const planId =
    outcome.metadataPlanId && isPlanId(outcome.metadataPlanId)
      ? outcome.metadataPlanId
      : resolvePlanForProductId(outcome.productId);

  if (isTopup && (topupCents == null || topupCents <= 0)) {
    throw new Error(`Unpriced top-up charge ${outcome.reference}`);
  }
  if (!isTopup && !planId) {
    throw new Error(`Unresolved subscription plan for ${outcome.reference}`);
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: billingWebhookEvents.id })
      .from(billingWebhookEvents)
      .where(eq(billingWebhookEvents.eventKey, eventKey))
      .limit(1);
    if (existing) {
      return { credited: false, alreadyProcessed: true };
    }

    if (isTopup) {
      const [updated] = await tx
        .update(users)
        .set({
          billingCustomerCode: outcome.customerId ?? undefined,
          creditBalanceCents: sql`${users.creditBalanceCents} + ${topupCents}`,
        })
        .where(eq(users.id, userId))
        .returning({ creditBalanceCents: users.creditBalanceCents });
      if (!updated) throw new Error(`User ${userId} not found for top-up`);

      await tx.insert(creditTransactions).values({
        id: nanoid(),
        userId,
        type: "topup",
        amountCents: topupCents!,
        balanceAfterCents: updated.creditBalanceCents,
        description: "Wallet top-up",
        billingReference: outcome.reference,
      });
    } else {
      const plan = getPlanDefinition(planId!);
      const [updated] = await tx
        .update(users)
        .set({
          billingCustomerCode: outcome.customerId ?? undefined,
          plan: planId!,
          billingCycleAnchor: new Date(),
          creditBalanceCents: sql`${users.creditBalanceCents} + ${plan.creditGrantCents}`,
          planGrantBalanceCents: sql`${users.planGrantBalanceCents} + ${plan.creditGrantCents}`,
        })
        .where(eq(users.id, userId))
        .returning({ creditBalanceCents: users.creditBalanceCents });
      if (!updated)
        throw new Error(`User ${userId} not found for subscription`);

      await tx.insert(creditTransactions).values({
        id: nanoid(),
        userId,
        type: "subscription_grant",
        amountCents: plan.creditGrantCents,
        balanceAfterCents: updated.creditBalanceCents,
        description: `${plan.name} plan renewal`,
        billingReference: outcome.reference,
      });
    }

    await tx.insert(billingWebhookEvents).values({
      id: nanoid(),
      eventKey,
      eventType: "collection.succeeded",
      payload: outcome as unknown as Record<string, unknown>,
    });

    return { credited: true, alreadyProcessed: false };
  });
}
