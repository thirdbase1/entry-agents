import { getServerSession } from "@/lib/session/get-server-session";
import { getUserBillingState } from "@/lib/billing/credit-ledger";
import { getPlanDefinition } from "@/lib/billing/plans";

/**
 * Lightweight "what plan am I on / how much credit do I have left" read,
 * used by the sidebar balance widget. Separate from /api/billing/verify
 * (which is tied to a specific Paystack transaction reference right
 * after checkout) -- this one is just a plain GET for whenever the UI
 * needs the current numbers.
 */
export async function GET() {
  const session = await getServerSession();
  if (!session?.user?.id) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const state = await getUserBillingState(session.user.id);
  if (!state) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  const plan = getPlanDefinition(state.plan);

  return Response.json({
    plan: state.plan,
    planName: plan.name,
    creditBalanceCents: state.creditBalanceCents,
    creditGrantCents: plan.creditGrantCents,
  });
}
