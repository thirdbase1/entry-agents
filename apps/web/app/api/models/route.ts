import { filterModelsForSession } from "@/lib/model-access";
import { fetchAvailableLanguageModelsWithContext } from "@/lib/models-with-context";
import { getServerSession } from "@/lib/session/get-server-session";
import { getFreeTierGateStatus } from "@/lib/db/platform-settings";
import { isUserAdmin } from "@/lib/db/users";

const CACHE_CONTROL = "private, no-store";

export async function GET(req: Request) {
  try {
    const [session, models] = await Promise.all([
      getServerSession(),
      fetchAvailableLanguageModelsWithContext(),
    ]);

    // Surfaced so the selector/composer can show the block proactively
    // instead of only erroring once a turn is actually sent -- the real
    // enforcement lives server-side in resolveChatModelRuntime and
    // startStopMonitor (app/workflows/chat.ts); this is UX only. Admins
    // always get `null` here so their UI never changes.
    const isAdminUser = session?.user?.id
      ? await isUserAdmin(session.user.id).catch(() => false)
      : false;
    const freeTierGate = isAdminUser ? null : await getFreeTierGateStatus();

    return Response.json(
      {
        models: filterModelsForSession(models, session, req.url),
        freeTierGate:
          freeTierGate && !freeTierGate.enabled
            ? { enabled: false, reason: freeTierGate.reason }
            : null,
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
