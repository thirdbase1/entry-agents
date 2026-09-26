import "server-only";

import { createHmac, timingSafeEqual } from "crypto";

/**
 * Bachs client (https://docs.bachs.io).
 *
 * Replaces the Paystack client outright. Three things differ enough from
 * Paystack that they are worth stating once, here, rather than discovering
 * them per-call-site:
 *
 * 1. Money is a decimal string at the currency's precision ("10.00")
 *    paired with an ISO 4217 code -- never minor units. Every conversion
 *    from our internal USD cents goes through usdCentsToDecimalString().
 * 2. There is no "initialize transaction". You create a checkout session,
 *    get a hosted checkout_url back, and the customer completes it there.
 *    Fulfilment comes from the webhook, never the redirect.
 * 3. The key prefix decides the deployment: sk_sandbox_ routes to the
 *    sandbox and sk_live_ to production. We still pick the base URL from
 *    the prefix so a live key pointed at the sandbox host fails loudly
 *    instead of silently mixing environments.
 */

const SANDBOX_BASE_URL = "https://sandbox-api.bachs.io";
const PRODUCTION_BASE_URL = "https://api.bachs.io";

/** Default replay window for webhook signatures, per Bachs' docs. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

function getApiKey(): string {
  const key = process.env.BACHS_API_KEY;
  if (!key) {
    throw new Error(
      "BACHS_API_KEY is not configured -- set it in Vercel project env vars from the Bachs Developer Portal (API Keys).",
    );
  }
  return key;
}

function baseUrlFor(apiKey: string): string {
  return apiKey.startsWith("sk_sandbox_")
    ? SANDBOX_BASE_URL
    : PRODUCTION_BASE_URL;
}

/**
 * Bachs does not wrap responses in a status envelope the way Paystack
 * does -- a 200 body IS the resource. Errors come back as an error object
 * with a message, which we surface verbatim so a failed checkout names
 * the real cause (bad scope, validation, currency not enabled) instead of
 * a generic "request failed".
 */
async function bachsRequest<T>(
  path: string,
  init?: RequestInit & { apiKey?: string },
): Promise<T> {
  const apiKey = init?.apiKey ?? getApiKey();

  const res = await fetch(`${baseUrlFor(apiKey)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const message = extractErrorMessage(body) ?? `status ${res.status}`;
    throw new Error(`Bachs error on ${init?.method ?? "GET"} ${path}: ${message}`);
  }

  return body as T;
}

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      const nestedMessage = nested.message ?? nested.detail ?? nested.code;
      if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
        return nestedMessage;
      }
    }
  }
  return null;
}

/** Our ledger stores USD cents; Bachs wants "10.00". */
export function usdCentsToDecimalString(cents: number): string {
  if (!Number.isFinite(cents)) {
    throw new Error(`usdCentsToDecimalString received ${cents}`);
  }
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(Math.round(cents));
  const whole = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, "0");
  return `${sign}${whole}.${fraction}`;
}

export interface CreateCheckoutSessionParams {
  /** Our own order id (Paystack-style reference). Unique per org, max 128 chars. */
  reference: string;
  email: string;
  /** USD cents from PLAN_CATALOG / the top-up picker. */
  amountCents: number;
  successUrl: string;
  cancelUrl: string;
  /** Max 20 pairs / 10 KB. Echoed back on the webhook and copied onto subscriptions. */
  metadata?: Record<string, string>;
  /**
   * For recurring purchases: the Bachs product id (prod_...) whose
   * billing_cycle makes this checkout create the subscription. When set,
   * `amountCents` is only used to assert we are charging the catalog price.
   */
  productId?: string;
}

export interface CreateCheckoutSessionResult {
  checkoutId: string;
  checkoutUrl: string;
  status: string;
  expiresAt: string | null;
}

export async function createCheckoutSession(
  params: CreateCheckoutSessionParams,
): Promise<CreateCheckoutSessionResult> {
  const pricing = {
    currency: "USD",
    amount: usdCentsToDecimalString(params.amountCents),
  };

  const body = params.productId
    ? {
        product_cart: [{ product_id: params.productId, quantity: 1 }],
        reference: params.reference,
        customer: { email: params.email },
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        ...(params.metadata ? { metadata: params.metadata } : {}),
      }
    : {
        pricing,
        reference: params.reference,
        customer: { email: params.email },
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        ...(params.metadata ? { metadata: params.metadata } : {}),
      };

  const data = await bachsRequest<{
    checkout_id: string;
    checkout_url: string;
    status: string;
    expires_at?: string | null;
  }>("/v1/checkout-sessions", {
    method: "POST",
    body: JSON.stringify(body),
  });

  return {
    checkoutId: data.checkout_id,
    checkoutUrl: data.checkout_url,
    status: data.status,
    expiresAt: data.expires_at ?? null,
  };
}

export interface CheckoutSessionSnapshot {
  checkoutId: string;
  /** open | completed | expired | cancelled */
  status: string;
  /** Decimal string in `currency`. */
  amount: string;
  currency: string;
  /** The reference WE supplied at creation (topup_ or sub_ prefixed), or null. */
  reference: string | null;
  metadata: Record<string, unknown> | null;
  /** Customer record id (cust_...). Null until an identity exists. */
  customerId: string | null;
  customerEmail: string | null;
  /** Lowercase payment state from `charge.status` -- note the webhook's
   *  data.status is UPPERCASE; do not compare the two directly. */
  chargeStatus: string | null;
  paymentStatus: string | null;
  subscriptionId: string | null;
}

/**
 * Server-side confirmation after the browser redirects back. The redirect
 * can be lost or forged, so callers must still treat the webhook as the
 * source of truth -- this exists only to render an immediate result.
 */
export async function getCheckoutSession(
  checkoutId: string,
): Promise<CheckoutSessionSnapshot> {
  const data = await bachsRequest<{
    checkout_id: string;
    status: string;
    amount: string;
    currency: string;
    reference: string | null;
    metadata: Record<string, unknown> | null;
    customer: { id: string | null; email: string | null } | null;
    customer_details: { email: string | null } | null;
    payment_status: string | null;
    charge: { status: string | null; subscription_id?: string | null } | null;
  }>(`/v1/checkout-sessions/${encodeURIComponent(checkoutId)}`);

  return {
    checkoutId: data.checkout_id,
    status: data.status,
    amount: data.amount,
    currency: data.currency,
    reference: data.reference ?? null,
    metadata: data.metadata ?? null,
    customerId: data.customer?.id ?? null,
    customerEmail: data.customer?.email ?? data.customer_details?.email ?? null,
    chargeStatus: data.charge?.status ?? null,
    paymentStatus: data.payment_status ?? null,
    subscriptionId: data.charge?.subscription_id ?? null,
  };
}

export interface VerifyBachsSignatureParams {
  rawBody: string;
  /** X-Bachs-Timestamp: unix seconds. */
  timestampHeader: string | null;
  /** X-Bachs-Signature-V2: `t={ts},v1={sig}[,v1={sig}...]`. Preferred. */
  signatureV2Header: string | null;
  /** X-Bachs-Signature: bare hex digest. Fallback for older deliveries. */
  signatureHeader?: string | null;
  /** Defaults to BACHS_WEBHOOK_SECRET. */
  secret?: string;
  toleranceSeconds?: number;
  /** Injectable clock so tests do not depend on wall time. */
  nowSeconds?: number;
}

/**
 * Verifies a Bachs webhook delivery.
 *
 * Signed message is `{timestamp}.{rawBody}` over HMAC-SHA256 -- note this
 * is NOT Paystack's bare-body HMAC-SHA512, and the timestamp must be part
 * of the digest or every delivery fails.
 *
 * V2 repeats `v1=` once per currently-valid secret, so rotation keeps two
 * signatures live for 24h. We accept if ANY of them matches; comparing
 * only the first would reject traffic mid-rotation.
 */
export function verifyBachsSignature(
  params: VerifyBachsSignatureParams,
): boolean {
  const secret = params.secret ?? process.env.BACHS_WEBHOOK_SECRET;
  if (!secret) return false;

  const tolerance = params.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);

  let timestamp: number | null = null;
  const candidates: string[] = [];

  if (params.signatureV2Header) {
    const parts = params.signatureV2Header.split(",");
    for (const part of parts) {
      const separator = part.indexOf("=");
      if (separator < 0) continue;
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (key === "t") {
        timestamp = Number.parseInt(value, 10);
      } else if (key === "v1" && value) {
        candidates.push(value);
      }
    }
  }

  if (timestamp === null && params.timestampHeader) {
    const parsed = Number.parseInt(params.timestampHeader, 10);
    if (Number.isFinite(parsed)) timestamp = parsed;
  }

  if (timestamp === null || !Number.isFinite(timestamp)) return false;

  // Replay protection: a captured delivery older than the window is refused.
  if (Math.abs(now - timestamp) > tolerance) return false;

  if (candidates.length === 0 && params.signatureHeader) {
    const bare = params.signatureHeader.trim();
    if (bare) candidates.push(bare);
  }
  if (candidates.length === 0) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${params.rawBody}`, "utf8")
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");
  return candidates.some((candidate) => {
    const provided = Buffer.from(candidate, "utf8");
    return (
      expectedBuffer.length === provided.length &&
      timingSafeEqual(expectedBuffer, provided)
    );
  });
}
