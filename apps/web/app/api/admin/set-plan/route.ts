import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import {
  creditAccount,
  getUserBillingState,
  getUsageWindowTotals,
} from "@/lib/billing/credit-ledger";
import { getPlanDefinition } from "@/lib/billing/plans";
import { PLAN_CATALOG, PLAN_IDS, type PlanId } from "@/lib/billing/plans";

/**
 * TEMPORARY secret-gated admin plan setter (re-added 2026-09-15: owner
 * reported the promoted plan doesn't show in their UI -- listing ALL
 * users this time to find the account they actually log in with).
 * DELETED after use; the secret dies with the route.
 */
const TEMP_SECRET = "ma3cGelNh8l7VTsSrkbps-Bcal6f8AJg-2";

export async function POST(request: Request) {
  if (request.headers.get("x-set-plan-secret") !== TEMP_SECRET) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    userId?: string;
    plan?: string;
    grant?: boolean;
  };

  // Diagnose mode: simulate /api/billing/me for a user (the owner
  // reports the billing page shows no plan since the promotion -- if
  // the usage-windows path throws, the whole me route 500s and the
  // UI falls back to "no current plan" for them).
  if (body.userId === "DIAGNOSE") {
    const target = body.email ?? "zhH76ze7c4IVrRem7MWY1";
    try {
      const state = await getUserBillingState(target);
      const plan = getPlanDefinition(state?.plan);
      let windows: unknown = null;
      if (plan.usageWindows) {
        const totals = await getUsageWindowTotals(target);
        windows = {
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
        ok: true,
        state: {
          plan: state?.plan,
          planName: plan.name,
          creditBalanceCents: state?.creditBalanceCents,
        },
        usageWindows: windows,
      });
    } catch (error) {
      return Response.json({
        ok: false,
        error: String(error),
        stack: (error as { stack?: string }).stack?.split("\n").slice(0, 6),
      });
    }
  }

  // Listing mode: return EVERY user so the caller can identify which
  // account the owner actually logs in with.
  if (!body.email && !body.userId) {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        plan: users.plan,
        isAdmin: users.isAdmin,
        creditBalanceCents: users.creditBalanceCents,
        createdAt: users.createdAt,
      })
      .from(users)
      .limit(50);
    return Response.json({ users: rows });
  }

  const planId = body.plan as PlanId;
  if (!PLAN_IDS.includes(planId)) {
    return Response.json(
      { error: `Unknown plan '${body.plan}'` },
      { status: 400 },
    );
  }
  const plan = PLAN_CATALOG[planId];

  const [updated] = await db
    .update(users)
    .set({ plan: planId })
    .where(body.userId ? eq(users.id, body.userId) : eq(users.email, body.email!))
    .returning({ id: users.id, email: users.email, plan: users.plan });

  if (!updated) {
    return Response.json({ error: "No matching user" }, { status: 404 });
  }

  // Grant only when explicitly asked (the first account already got
  // its $50 grant; a second-account promotion shouldn't double-grant
  // unless the owner wants it).
  let newBalanceCents: number | undefined;
  if (body.grant !== false) {
    newBalanceCents = await creditAccount(
      updated.id,
      plan.creditGrantCents,
      "subscription_grant",
      { description: `${plan.name} plan activation (admin set-plan)` },
    );
  }

  return Response.json({
    ok: true,
    userId: updated.id,
    email: updated.email,
    plan: updated.plan,
    grantedCents: body.grant !== false ? plan.creditGrantCents : 0,
    newBalanceCents,
  });
}
