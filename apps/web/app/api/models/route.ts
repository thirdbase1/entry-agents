import { filterModelsForSession } from "@/lib/model-access";
import { fetchAvailableLanguageModelsWithContext } from "@/lib/models-with-context";
import { getServerSession } from "@/lib/session/get-server-session";
import { getFreeTierGateStatus } from "@/lib/db/platform-settings";
import { isUserAdmin } from "@/lib/db/users";
import { getUserBillingState } from "@/lib/billing/credit-ledger";
import { getPlanDefinition, FREE_PLAN_MODEL_ID } from "@/lib/billing/plans";

const CACHE_CONTROL = "private, no-store";

export interface CreditGateStatus {
  blocked: boolean;
  reason: string | null;
  /** "free" once the one-time trial credit is spent; "paid" once a
   * paid plan's balance hits zero mid-cycle. Lets the client show a
   * different CTA (upgrade vs. top up) without re-deriving it. */
  kind: "free" | "paid" | null;
}

export async function GET(req: Request) {
  try {
    const [session, models] = await Promise.all([
      getServerSession(),
      fetchAvailableLanguageModelsWithContext(),
    ]);

    // Surfaced so the selector/composer can show the block proactively
    // instead of only erroring once a turn is actually sent -- the real
    // enforcement lives server-side in resolveChatModelRuntime and
    // startStopMonitor / runAgentStep (app/workflows/chat.ts); this is
    // UX only. Admins always get `null` for both gates so their UI
    // never changes.
    const isAdminUser = session?.user?.id
      ? await isUserAdmin(session.user.id).catch(() => false)
      : false;
    const freeTierGate = isAdminUser ? null : await getFreeTierGateStatus();

    let creditGate: CreditGateStatus | null = null;
    let userPlan: { id: string; modelAccess: "luna-only" | "all" } | null =
      null;
    if (session?.user?.id && !isAdminUser) {
      const billingState = await getUserBillingState(session.user.id).catch(
        () => null,
      );
      const plan = getPlanDefinition(billingState?.plan);
      const balanceCents = billingState?.creditBalanceCents ?? 0;
      userPlan = { id: plan.id, modelAccess: plan.modelAccess };
      if (balanceCents <= 0) {
        creditGate = {
          blocked: true,
          reason:
            plan.modelAccess === "luna-only"
              ? "Free tier ended — upgrade your account to use Entry"
              : "You're out of credit — top up to keep chatting",
          kind: plan.modelAccess === "luna-only" ? "free" : "paid",
        };
      }
    }

    return Response.json(
      {
        models: filterModelsForSession(models, session, req.url),
        freeTierGate:
          freeTierGate && !freeTierGate.enabled
            ? { enabled: false, reason: freeTierGate.reason }
            : null,
        creditGate,
        userPlan,
        freePlanModelId: FREE_PLAN_MODEL_ID,
      },
      {
        headers: {
          "Cache-Control": CACHE_CONTROL,
        },
      },
    );
  } catch (error) {
    console.error("Failed to fetch available models:", error);
    return Response.json(
      { error: "Failed to fetch available models" },
      { status: 500 },
    );
  }
}
