import "server-only";

import { createHmac, timingSafeEqual } from "crypto";

const PAYSTACK_BASE_URL = "https://api.paystack.co";

function getSecretKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    throw new Error(
      "PAYSTACK_SECRET_KEY is not configured -- set it in Vercel project env vars from your Paystack dashboard (Settings > API Keys & Webhooks).",
    );
  }
  return key;
}

async function paystackRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const body = await res.json().catch(() => null);

  if (!res.ok || !body?.status) {
    const message =
      body?.message ?? `Paystack request failed with status ${res.status}`;
    throw new Error(`Paystack error: ${message}`);
  }

  return body.data as T;
}

export interface InitializeTransactionParams {
  email: string;
  amountCents: number;
  /** USD is the price unit Entry quotes in -- Paystack settles per the account's supported currency. */
  currency?: string;
  reference: string;
  callbackUrl?: string;
  /** Arbitrary bag surfaced back on the webhook (e.g. { userId, kind: "topup" | "subscription", planId }). */
  metadata?: Record<string, unknown>;
  /** Pass to charge against a Paystack recurring Plan instead of a one-off amount. */
  planCode?: string;
}

export interface InitializeTransactionResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

/**
 * Starts a Paystack Standard Checkout transaction. Works for both
 * one-off top-ups (amountCents only) and the first charge of a
 * subscription (planCode set -- Paystack auto-creates the recurring
 * subscription off the card used at this checkout).
 */
export async function initializeTransaction(
  params: InitializeTransactionParams,
): Promise<InitializeTransactionResult> {
  const data = await paystackRequest<{
    authorization_url: string;
    access_code: string;
    reference: string;
  }>("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: params.email,
      // Paystack's smallest-unit amount is in the account's settlement
      // currency's subunit. Amount here is USD cents from our plan
      // catalog, passed straight through -- Paystack accounts configured
      // for USD settlement expect amount in cents already.
      amount: params.amountCents,
      currency: params.currency ?? "USD",
      reference: params.reference,
      callback_url: params.callbackUrl,
      metadata: params.metadata,
      ...(params.planCode ? { plan: params.planCode } : {}),
    }),
  });

  return {
    authorizationUrl: data.authorization_url,
    accessCode: data.access_code,
    reference: data.reference,
  };
}

export interface VerifyTransactionResult {
  status: "success" | "failed" | "abandoned" | string;
  reference: string;
  amountCents: number;
  currency: string;
  customerEmail: string;
  customerCode: string | null;
  metadata: Record<string, unknown> | null;
  planCode: string | null;
  subscriptionCode: string | null;
}

export async function verifyTransaction(
  reference: string,
): Promise<VerifyTransactionResult> {
  const data = await paystackRequest<{
    status: string;
    reference: string;
    amount: number;
    currency: string;
    customer: { email: string; customer_code: string };
    metadata: Record<string, unknown> | null;
    plan: string | null;
    plan_object?: { plan_code?: string };
    subscription_code?: string | null;
  }>(`/transaction/verify/${encodeURIComponent(reference)}`);

  return {
    status: data.status as VerifyTransactionResult["status"],
    reference: data.reference,
    amountCents: data.amount,
    currency: data.currency,
    customerEmail: data.customer?.email,
    customerCode: data.customer?.customer_code ?? null,
    metadata: data.metadata ?? null,
    planCode: data.plan_object?.plan_code ?? data.plan ?? null,
    subscriptionCode: data.subscription_code ?? null,
  };
}

/**
 * Creates the four recurring Paystack Plans from PLAN_CATALOG if they
 * don't already have a paystackPlanCode. Run this once (e.g. via an
 * admin-only route or a one-off script) after PAYSTACK_SECRET_KEY is
 * set -- then hardcode the returned plan_code values into
 * lib/billing/plans.ts's PLAN_CATALOG so future checkouts don't need to
 * re-create plans.
 */
export async function createPaystackPlan(params: {
  name: string;
  amountCents: number;
  interval: "monthly";
}): Promise<{ planCode: string }> {
  const data = await paystackRequest<{ plan_code: string }>("/plan", {
    method: "POST",
    body: JSON.stringify({
      name: params.name,
      amount: params.amountCents,
      interval: params.interval,
      currency: "USD",
    }),
  });
  return { planCode: data.plan_code };
}

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader) {
    return false;
  }
  const digest = createHmac("sha512", getSecretKey())
    .update(rawBody)
    .digest("hex");

  const expected = Buffer.from(digest);
  const provided = Buffer.from(signatureHeader);
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}
