import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { billingWebhookEvents } from "@/lib/db/schema";
import { verifyBachsSignature } from "@/lib/billing/bachs";
import { processChargeSuccess } from "@/lib/billing/process-charge";
import {
  setBillingSubscriptionCode,
  findUserIdByBillingCustomerCode,
  downgradeToFreeOnSubscriptionEnd,
} from "@/lib/billing/credit-ledger";

interface BachsCollectionSucceededData {
  checkout_id: string | null;
  reference: string | null;
  status: string;
  amount: string;
  currency: string;
  customer: { id: string | null; email?: string | null } | null;
  metadata: Record<string, unknown> | null;
}

interface BachsSubscriptionEventData {
  subscription_id: string;
  customer: { customer_id?: string | null } | null;
  status?: string;
}

async function claimEventOnce(
  eventKey: string,
  eventType: string,
  payload: unknown,
): Promise<boolean> {
  try {
    await db.insert(billingWebhookEvents).values({
      id: nanoid(),
      eventKey,
      eventType,
      payload,
    });
    return true;
  } catch {
    return false;
  }
}

/** Decimal string -> USD integer cents. Null for anything not USD. */
function usdDecimalToCents(amount: string | null, currency: string | null): number | null {
  if (currency !== "USD" || !amount) return null;
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

/**
 * Bachs webhook endpoint.
 *
 * Verifies X-Bachs-Signature-V2 over `{timestamp}.{rawBody}` (HMAC-SHA256)
 * with replay tolerance, then switches on `event.type`. Webhooks are the
 * source of truth for fulfilment; the callback page only paints a faster
 * result and races on the same idempotency claim.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();

  const signatureV2 = req.headers.get("x-bachs-signature-v2");
  const signatureV1 = req.headers.get("x-bachs-signature");
  const timestamp = req.headers.get("x-bachs-timestamp");

  const verified = verifyBachsSignature({
    rawBody,
    timestampHeader: timestamp,
    signatureV2Header: signatureV2,
    signatureHeader: signatureV1,
  });

  if (!verified) {
    console.error("[billing/webhook] Invalid Bachs signature");
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: { id?: string; type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Malformed JSON" }, { status: 400 });
  }

  const type = event.type;
  if (!type || !event.data) {
    return Response.json({ received: true });
  }

  try {
    switch (type) {
      case "collection.succeeded": {
        const data = event.data as unknown as BachsCollectionSucceededData;
        const metadata = data.metadata ?? {};

        const metadataUserId =
          typeof metadata.userId === "string" ? metadata.userId : null;
        const metadataKind =
          typeof metadata.kind === "string" ? metadata.kind : null;
        const metadataPlanId =
          typeof metadata.planId === "string" ? metadata.planId : null;
        // Bachs metadata values reach us as strings (we send strings);
        // accept a number too in case a future caller sends one.
        const metadataUsdAmountCents =
          typeof metadata.usdAmountCents === "number"
            ? metadata.usdAmountCents
            : typeof metadata.usdAmountCents === "string" &&
                Number.isFinite(Number(metadata.usdAmountCents))
              ? Number(metadata.usdAmountCents)
              : null;

        // processChargeSuccess does its own idempotency claim keyed off
        // our reference -- don't double-claim here, just delegate. The
        // reference is ours (`topup_*`/`sub_*`); checkout_id is the
        // provider-side fallback when the reference was never attached.
        const reference =
          data.reference ?? data.checkout_id ?? `evt_${event.id ?? "unknown"}`;

        await processChargeSuccess({
          reference,
          customerId: data.customer?.id ?? null,
          metadataUserId,
          metadataKind,
          metadataPlanId,
          metadataUsdAmountCents,
          productId: null,
          // Only a USD session can be read as USD cents. An NGN amount
          // must never land here (that is how the Paystack path would
          // have over-credited), so it resolves to null instead.
          fallbackAmountCents: usdDecimalToCents(data.amount, data.currency),
        });
        break;
      }

      case "customer.subscription.created": {
        const data = event.data as unknown as BachsSubscriptionEventData;
        const eventKey = `customer.subscription.created:${data.subscription_id}`;
        const isNew = await claimEventOnce(eventKey, type, event.data);
        if (!isNew) break;

        const customerId = data.customer?.customer_id;
        if (customerId) {
          const userId = await findUserIdByBillingCustomerCode(customerId);
          if (userId) {
            await setBillingSubscriptionCode(userId, data.subscription_id);
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        // Subscription ended -- the customer cancelled, or Bachs exhausted
        // payment recovery (owner report 2026-09-15: lapsed subscribers
        // previously kept their paid plan forever). Downgrades to Free ONLY
        // when the deleted subscription id is the one actually stored on
        // their account, so a stale deletion for an old subscription never
        // kicks off a re-subscribed user.
        const data = event.data as unknown as BachsSubscriptionEventData;
        const eventKey = `customer.subscription.deleted:${data.subscription_id}`;
        const isNew = await claimEventOnce(eventKey, type, event.data);
        if (!isNew) break;

        const customerId = data.customer?.customer_id;
        if (customerId) {
          const result = await downgradeToFreeOnSubscriptionEnd(
            customerId,
            data.subscription_id,
          );
          if (!result.downgraded && result.userId) {
            console.log(
              "[billing/webhook] subscription.deleted for user:",
              result.userId,
              "-- code mismatch or already free, no downgrade",
            );
          }
        }
        break;
      }

      default:
        // Renewal signal (invoice.paid) and everything else: acknowledged
        // with 200 so Bachs doesn't retry. Renewals still apply because
        // collection.succeeded fires alongside invoice.paid and both land
        // on processChargeSuccess. Extend here as needed.
        break;
    }
  } catch (error) {
    console.error("[billing/webhook] Failed to process event:", error);
    // Still 200 -- we've already claimed the event key in most paths, and
    // Bachs would otherwise retry indefinitely on a transient DB blip.
    // Errors here are visible in logs for manual reconciliation.
  }

  return Response.json({ received: true });
}
