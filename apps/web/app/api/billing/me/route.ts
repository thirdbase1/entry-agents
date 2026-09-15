import { getServerSession } from "@/lib/session/get-server-session";
import {
  getUserBillingState,
  getUsageWindowTotals,
} from "@/lib/billing/credit-ledger";
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

  // Entry Windows (2026-09-15): plans with rolling usage windows (only
  // the Entry plan today) also get their live window usage returned so
  // the billing page can render the window status card. Everything
  // else gets null -- windows are exclusive to this plan.
  let usageWindows: {
    fiveHour: { usedCents: number; limitCents: number };
    weekly: { usedCents: number; limitCents: number };
    monthly: { usedCents: number; limitCents: number };
  } | null = null;
  if (plan.usageWindows) {
    const totals = await getUsageWindowTotals(session.user.id);
    usageWindows = {
      fiveHour: {
        usedCents: totals.last5HoursCents,
        limitCents: plan.usageWindows.fiveHourLimitCents,
      },
      weekly: {
        usedCents: totals.last7DaysCents,
        limitCents: plan.usageWindows.weeklyLimitCents,
      },
      monthly: {
        usedCents: totals.last30DaysCents,
        limitCents: plan.usageWindows.monthlyLimitCents,
      },
    };
  }

  return Response.json({
    plan: state.plan,
    planName: plan.name,
    creditBalanceCents: state.creditBalanceCents,
    creditGrantCents: plan.creditGrantCents,
    usageWindows,
  });
}
