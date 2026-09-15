import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { creditAccount } from "@/lib/billing/credit-ledger";
import { PLAN_CATALOG, PLAN_IDS, type PlanId } from "@/lib/billing/plans";

/**
 * TEMPORARY secret-gated admin plan setter (added 2026-09-15, owner
 * request to upgrade the admin account to the Entry plan directly --
 * same pattern as the 2026-08-28 temp admin route). DELETED after use;
 * the secret dies with the route and grants nothing once it's gone.
 *
 * POST with header x-set-plan-secret and body:
 *  - {} -> lists admin users (id, email, plan, balance) so the target
 *    account can be identified.
 *  - { email, plan } -> sets that user's plan and grants the plan's
 *    creditGrantCents as a subscription_grant (like a renewal would).
 */
const TEMP_SECRET = "ma3cGelNh8l7VTsSrkbps-Bcal6f8AJg";

export async function POST(request: Request) {
  if (request.headers.get("x-set-plan-secret") !== TEMP_SECRET) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    plan?: string;
  };

  // Listing mode: return the admin accounts so the caller can pick one.
  if (!body.email) {
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        plan: users.plan,
        creditBalanceCents: users.creditBalanceCents,
      })
      .from(users)
      .where(eq(users.isAdmin, true))
      .limit(20);
    return Response.json({ admins: rows });
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
    .where(eq(users.email, body.email))
    .returning({ id: users.id, plan: users.plan });

  if (!updated) {
    return Response.json(
      { error: `No user with email ${body.email}` },
      { status: 404 },
    );
  }

  const balance = await creditAccount(
    updated.id,
    plan.creditGrantCents,
    "subscription_grant",
    { description: `${plan.name} plan activation (admin set-plan)` },
  );

  return Response.json({
    ok: true,
    userId: updated.id,
    plan: updated.plan,
    grantedCents: plan.creditGrantCents,
    newBalanceCents: balance,
  });
}
