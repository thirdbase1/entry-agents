import "server-only";

import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { creditTransactions, users } from "@/lib/db/schema";
import { getPlanDefinition, type PlanId } from "./plans";

export interface UserBillingState {
  plan: PlanId;
  creditBalanceCents: number;
  billingCycleAnchor: Date | null;
  paystackCustomerCode: string | null;
  paystackSubscriptionCode: string | null;
}

export async function getUserBillingState(
  userId: string,
): Promise<UserBillingState | null> {
  const [row] = await db
    .select({
      plan: users.plan,
      creditBalanceCents: users.creditBalanceCents,
      billingCycleAnchor: users.billingCycleAnchor,
      paystackCustomerCode: users.paystackCustomerCode,
      paystackSubscriptionCode: users.paystackSubscriptionCode,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!row) {
    return null;
  }

  return {
    plan: (row.plan as PlanId) ?? "free",
    creditBalanceCents: row.creditBalanceCents,
    billingCycleAnchor: row.billingCycleAnchor,
    paystackCustomerCode: row.paystackCustomerCode,
    paystackSubscriptionCode: row.paystackSubscriptionCode,
  };
}

export type CreditTransactionType =
  | "signup_trial"
  | "subscription_grant"
  | "topup"
  | "usage_debit"
  | "refund"
  | "admin_adjustment";

interface LedgerEntryOptions {
  description?: string;
  modelId?: string;
  paystackReference?: string;
}

/**
 * Atomically adjusts a user's creditBalanceCents and writes a matching
 * ledger row. `amountCents` may be positive (grant/topup/refund) or
 * negative (usage_debit). Returns the resulting balance.
 */
async function applyLedgerEntry(
  userId: string,
  amountCents: number,
  type: CreditTransactionType,
  opts: LedgerEntryOptions = {},
): Promise<number> {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({
        creditBalanceCents: sql`${users.creditBalanceCents} + ${amountCents}`,
      })
      .where(eq(users.id, userId))
      .returning({ creditBalanceCents: users.creditBalanceCents });

    if (!updated) {
      throw new Error(`applyLedgerEntry: user ${userId} not found`);
    }

    await tx.insert(creditTransactions).values({
      id: nanoid(),
      userId,
      type,
      amountCents,
      balanceAfterCents: updated.creditBalanceCents,
      description: opts.description ?? null,
      modelId: opts.modelId ?? null,
      paystackReference: opts.paystackReference ?? null,
    });

    return updated.creditBalanceCents;
  });
}

export async function creditAccount(
  userId: string,
  amountCents: number,
  type: Exclude<CreditTransactionType, "usage_debit">,
  opts: LedgerEntryOptions = {},
): Promise<number> {
  if (amountCents <= 0) {
    throw new Error("creditAccount: amountCents must be positive");
  }
  return applyLedgerEntry(userId, amountCents, type, opts);
}

/**
 * Admin-only manual decrease -- e.g. clawing back unused credit when an
 * admin downgrades a comped account. `amountCents` must be positive (the
 * function negates it internally) and is capped at the user's current
 * balance so this can never push a user into negative credit -- if the
 * requested amount is more than they have, it just zeroes the balance.
 * Returns the resulting balance.
 */
export async function debitAccountAdmin(
  userId: string,
  amountCents: number,
  opts: LedgerEntryOptions = {},
): Promise<number> {
  if (amountCents <= 0) {
    throw new Error("debitAccountAdmin: amountCents must be positive");
  }

  const state = await getUserBillingState(userId);
  if (!state) {
    throw new Error(`debitAccountAdmin: user ${userId} not found`);
  }

  const cappedAmountCents = Math.min(amountCents, state.creditBalanceCents);
  if (cappedAmountCents <= 0) {
    return state.creditBalanceCents;
  }

  return applyLedgerEntry(userId, -cappedAmountCents, "admin_adjustment", opts);
}

/** Debits usage cost from a user's balance. Never blocks/throws on insufficient balance -- the balance is simply allowed to go negative; enforcement (hard-block for free, soft-cutoff for paid) happens at turn-start, not here. */
export async function debitUsage(
  userId: string,
  costCents: number,
  opts: LedgerEntryOptions = {},
): Promise<number> {
  if (costCents <= 0) {
    return (await getUserBillingState(userId))?.creditBalanceCents ?? 0;
  }
  return applyLedgerEntry(userId, -costCents, "usage_debit", opts);
}

/** Applies a plan's renewal credit grant and resets the billing cycle anchor to now. */
export async function grantSubscriptionRenewal(
  userId: string,
  planId: PlanId,
  paystackReference?: string,
): Promise<number> {
  const plan = getPlanDefinition(planId);
  const balance = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({
        plan: planId,
        billingCycleAnchor: new Date(),
        creditBalanceCents: sql`${users.creditBalanceCents} + ${plan.creditGrantCents}`,
      })
      .where(eq(users.id, userId))
      .returning({ creditBalanceCents: users.creditBalanceCents });

    if (!updated) {
      throw new Error(`grantSubscriptionRenewal: user ${userId} not found`);
    }

    await tx.insert(creditTransactions).values({
      id: nanoid(),
      userId,
      type: "subscription_grant",
      amountCents: plan.creditGrantCents,
      balanceAfterCents: updated.creditBalanceCents,
      description: `${plan.name} plan renewal`,
      paystackReference: paystackReference ?? null,
    });

    return updated.creditBalanceCents;
  });

  return balance;
}

/** $1 = $1 one-off top-up, independent of plan. */
export async function applyTopup(
  userId: string,
  amountCents: number,
  paystackReference: string,
): Promise<number> {
  return creditAccount(userId, amountCents, "topup", {
    description: "Wallet top-up",
    paystackReference,
  });
}

export async function setPaystackCustomerCode(
  userId: string,
  customerCode: string,
): Promise<void> {
  await db
    .update(users)
    .set({ paystackCustomerCode: customerCode })
    .where(eq(users.id, userId));
}

export async function setPaystackSubscriptionCode(
  userId: string,
  subscriptionCode: string,
): Promise<void> {
  await db
    .update(users)
    .set({ paystackSubscriptionCode: subscriptionCode })
    .where(eq(users.id, userId));
}

export async function findUserIdByPaystackCustomerCode(
  customerCode: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.paystackCustomerCode, customerCode));
  return row?.id ?? null;
}
