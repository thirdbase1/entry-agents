import { NextRequest, NextResponse } from "next/server";
import { requireDesktopUser, unauthorized } from "@/lib/auth";
import { db, users, creditTransactions } from "@/lib/db";
import { and, eq, gte, sql } from "drizzle-orm";

export const runtime = "nodejs";

/**
 * GET /api/desktop/usage — live usage/billing state for the signed-in
 * desktop user: plan, credit balance, and (for the "Entry" plan, id
 * "goat" — the only plan with rolling usage windows) the 5h/weekly/monthly
 * window totals. Reads the SAME tables the web billing page uses.
 *
 * (POST on this path records per-turn token usage — untouched.)
 */

interface WindowTotals {
  last5HoursCents: number;
  last7DaysCents: number;
  last30DaysCents: number;
}

async function getUsageWindowTotals(userId: string): Promise<WindowTotals> {
  const sums = await db
    .select({
      last5: sql<number>`coalesce(sum(case when ${creditTransactions.createdAt} > now() - interval '5 hours' then abs(${creditTransactions.amountCents}) else 0 end), 0)`,
      last7: sql<number>`coalesce(sum(case when ${creditTransactions.createdAt} > now() - interval '7 days' then abs(${creditTransactions.amountCents}) else 0 end), 0)`,
      last30: sql<number>`coalesce(sum(case when ${creditTransactions.createdAt} > now() - interval '30 days' then abs(${creditTransactions.amountCents}) else 0 end), 0)`,
    })
    .from(creditTransactions)
    .where(
      and(
        eq(creditTransactions.userId, userId),
        eq(creditTransactions.type, "usage_debit"),
        gte(
          creditTransactions.createdAt,
          sql`now() - interval '30 days'`,
        ),
      ),
    );
  const s = sums[0];
  return {
    last5HoursCents: Number(s?.last5 ?? 0),
    last7DaysCents: Number(s?.last7 ?? 0),
    last30DaysCents: Number(s?.last30 ?? 0),
  };
}

export async function GET(req: NextRequest) {
  const user = await requireDesktopUser(req);
  if (!user) return unauthorized();

  const rows = await db
    .select({
      plan: users.plan,
      creditBalanceCents: users.creditBalanceCents,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const u = rows[0];
  if (!u) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Plan display names (goat is publicly named "Entry").
  const planNames: Record<string, string> = {
    free: "Free",
    plus: "Plus",
    goat: "Entry",
    pro: "Pro",
    max: "Max",
  };
  // Rolling windows exist only on the goat/"Entry" plan: $10/5h, $25/week,
  // $50/month (20% / 50% / 100% of the $50 grant).
  const windows = { fiveHour: 1000, weekly: 2500, monthly: 5000 };
  const hasWindows = u.plan === "goat";

  let usageWindows = null;
  if (hasWindows) {
    const totals = await getUsageWindowTotals(user.id);
    usageWindows = {
      fiveHour: {
        usedCents: totals.last5HoursCents,
        limitCents: windows.fiveHour,
      },
      weekly: { usedCents: totals.last7DaysCents, limitCents: windows.weekly },
      monthly: {
        usedCents: totals.last30DaysCents,
        limitCents: windows.monthly,
      },
    };
  }

  return NextResponse.json({
    plan: u.plan,
    planName: planNames[u.plan] ?? u.plan,
    creditBalanceCents: u.creditBalanceCents,
    usageWindows,
  });
}
