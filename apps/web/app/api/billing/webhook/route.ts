import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { paystackWebhookEvents } from "@/lib/db/schema";
import { verifyWebhookSignature } from "@/lib/billing/paystack";
import {
  applyTopup,
  grantSubscriptionRenewal,
  setPaystackCustomerCode,
  setPaystackSubscriptionCode,
  findUserIdByPaystackCustomerCode,
} from "@/lib/billing/credit-ledger";
import { isPlanId, PLAN_CATALOG } from "@/lib/billing/plans";

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

/**
 * Records the raw event for idempotency BEFORE processing side effects.
 * Returns false (skip processing) if this exact event was already
 * recorded -- Paystack retries webhooks on anything but a fast 2xx.
 */
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
    // Unique constraint violation on paystackEventId -- already processed.
    return false;
  }
}

function resolvePlanCodeFromChargeData(
  data: PaystackChargeSuccessData,
): string | undefined {
  if (data.plan_object?.plan_code) {
    return data.plan_object.plan_code;
  }
  if (typeof data.plan === "string") {
    return data.plan;
  }
  return data.plan?.plan_code;
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
        const eventKey = `charge.success:${data.reference}`;
        const isNew = await claimEventOnce(eventKey, event.event, event.data);
        if (!isNew) {
          break;
        }

        if (data.customer?.customer_code) {
          const metadataUserId =
            typeof data.metadata?.userId === "string"
              ? data.metadata.userId
              : null;
          const userId =
            metadataUserId ??
            (await findUserIdByPaystackCustomerCode(data.customer.customer_code));

          if (userId) {
            await setPaystackCustomerCode(userId, data.customer.customer_code);

            const kind = data.metadata?.kind;
            if (kind === "topup") {
              await applyTopup(userId, data.amount, data.reference);
            } else {
              // Subscription checkout (initial or renewal charge bound
              // to a plan) -- grant that plan's credit and set it as
              // the user's active plan.
              const planCode = resolvePlanCodeFromChargeData(data);
              const metadataPlanId =
                typeof data.metadata?.planId === "string"
                  ? data.metadata.planId
                  : null;
              const planId =
                metadataPlanId && isPlanId(metadataPlanId)
                  ? metadataPlanId
                  : Object.values(PLAN_CATALOG).find(
                      (p) => p.paystackPlanCode === planCode,
                    )?.id;

              if (planId) {
                await grantSubscriptionRenewal(userId, planId, data.reference);
              } else {
                console.warn(
                  "[billing/webhook] charge.success with unresolved planId",
                  { reference: data.reference, planCode },
                );
              }
            }
          } else {
            console.warn(
              "[billing/webhook] charge.success: no matching user for customer",
              data.customer.customer_code,
            );
          }
        }
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
    // Still 200 -- we've already claimed the event id, and Paystack will
    // otherwise retry indefinitely on a transient DB blip. Errors here
    // are visible in logs for manual reconciliation.
  }

  return Response.json({ received: true });
}
