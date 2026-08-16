import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { paystackWebhookEvents } from "@/lib/db/schema";
import { verifyWebhookSignature } from "@/lib/billing/paystack";
import { processChargeSuccess } from "@/lib/billing/process-charge";
import { setPaystackSubscriptionCode, findUserIdByPaystackCustomerCode } from "@/lib/billing/credit-ledger";

interface PaystackChargeSuccessData {
  reference: string;
  amount: number;
  customer: { customer_code: string; email: string };
  metadata: Record<string, unknown> | null;
  plan_object?: { plan_code?: string };
  plan?: string | { plan_code?: string } | null;
}

interface PaystackSubscriptionCreateData {
  subscription_code: string;
  customer: { customer_code: string };
  plan: { plan_code: string };
}

async function claimEventOnce(
  eventKey: string,
  eventType: string,
  payload: unknown,
): Promise<boolean> {
  try {
    await db.insert(paystackWebhookEvents).values({
      id: nanoid(),
      paystackEventId: eventKey,
      eventType,
      payload,
    });
    return true;
  } catch {
    return false;
  }
}

function resolvePlanCodeFromChargeData(
  data: PaystackChargeSuccessData,
): string | null {
  if (data.plan_object?.plan_code) {
    return data.plan_object.plan_code;
  }
  if (typeof data.plan === "string") {
    return data.plan;
  }
  return data.plan?.plan_code ?? null;
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-paystack-signature");

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.error("[billing/webhook] Invalid Paystack signature");
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const event = JSON.parse(rawBody) as {
    event: string;
    data: Record<string, unknown>;
  };

  try {
    switch (event.event) {
      case "charge.success": {
        const data = event.data as unknown as PaystackChargeSuccessData;
        // processChargeSuccess does its own idempotency claim keyed off
        // reference -- don't double-claim here, just delegate.
        const metadataUserId =
          typeof data.metadata?.userId === "string"
            ? data.metadata.userId
            : null;
        const metadataKind =
          typeof data.metadata?.kind === "string" ? data.metadata.kind : null;
        const metadataPlanId =
          typeof data.metadata?.planId === "string"
            ? data.metadata.planId
            : null;
        const metadataUsdAmountCents =
          typeof data.metadata?.usdAmountCents === "number"
            ? data.metadata.usdAmountCents
            : null;

        await processChargeSuccess({
          reference: data.reference,
          customerCode: data.customer?.customer_code ?? null,
          metadataUserId,
          metadataKind,
          metadataPlanId,
          metadataUsdAmountCents,
          planCode: resolvePlanCodeFromChargeData(data),
          fallbackAmountCents: data.amount,
        });
        break;
      }

      case "subscription.create": {
        const data = event.data as unknown as PaystackSubscriptionCreateData;
        const eventKey = `subscription.create:${data.subscription_code}`;
        const isNew = await claimEventOnce(eventKey, event.event, event.data);
        if (!isNew) {
          break;
        }

        const userId = await findUserIdByPaystackCustomerCode(
          data.customer.customer_code,
        );
        if (userId) {
          await setPaystackSubscriptionCode(userId, data.subscription_code);
        }
        break;
      }

      default:
        // Not-yet-handled event types (subscription.disable,
        // invoice.payment_failed, etc.) -- acknowledge with 200 so
        // Paystack doesn't retry; extend here as needed.
        break;
    }
  } catch (error) {
    console.error("[billing/webhook] Failed to process event:", error);
    // Still 200 -- we've already claimed the event id in most paths,
    // and Paystack will otherwise retry indefinitely on a transient DB
    // blip. Errors here are visible in logs for manual reconciliation.
  }

  return Response.json({ received: true });
}
