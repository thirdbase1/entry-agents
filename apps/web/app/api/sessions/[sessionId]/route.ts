import { after } from "next/server";
import {
  deleteSession,
  getSessionById,
  updateSession,
} from "@/lib/db/sessions";
import { archiveSession } from "@/lib/sandbox/archive-session";
import { hasRuntimeSandboxState } from "@/lib/sandbox/utils";
import { getServerSession } from "@/lib/session/get-server-session";

interface UpdateSessionRequest {
  title?: string;
  status?: "running" | "completed" | "failed" | "archived";
  linesAdded?: number;
  linesRemoved?: number;
  prNumber?: number;
  prStatus?: "open" | "merged" | "closed";
  // Per-session override for the permission mode ("ask" | "autoAccept"
  // | "fullAccess" -- see packages/agent/open-agent.ts and
  // tools/{bash,read,write,fetch}.ts for what each mode gates). null
  // clears the override so the session falls back to the user's
  // default preference.
  permissionModeOverride?: "ask" | "autoAccept" | "fullAccess" | null;
  // Per-session overrides for auto-commit-and-push and auto-create-PR
  // (see apps/web/app/workflows/chat.ts buildChatRunOptions, which reads
  // these live from the session record on every turn). null clears the
  // override so the session falls back to the user's default preference.
  autoCommitPushOverride?: boolean | null;
  autoCreatePrOverride?: boolean | null;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { sessionId } = await params;
  const existingSession = await getSessionById(sessionId);

  if (!existingSession) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  if (existingSession.userId !== session.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  return Response.json({ session: existingSession });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { sessionId } = await params;
  const existingSession = await getSessionById(sessionId);

  if (!existingSession) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  if (existingSession.userId !== session.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: UpdateSessionRequest;
  try {
    body = (await req.json()) as UpdateSessionRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const shouldStopSandboxAfterArchive =
    body.status === "archived" && existingSession.status !== "archived";

  const shouldUnarchive =
    body.status === "running" && existingSession.status === "archived";

  if (
    shouldUnarchive &&
    !existingSession.snapshotUrl &&
    hasRuntimeSandboxState(existingSession.sandboxState)
  ) {
    return Response.json(
      {
        error:
          "Sandbox is still being paused for this archived session. Please try unarchiving again in a few seconds.",
      },
      { status: 409 },
    );
  }

  const updatePayload: UpdateSessionRequest &
    Partial<{
      lifecycleState: "archived" | null;
      lifecycleError: null;
      sandboxExpiresAt: null;
      hibernateAfter: null;
    }> = { ...body };

  if (shouldUnarchive) {
    // Reset lifecycle state so the session can be resumed normally.
    // If there is saved sandbox state, the client will surface Resume again.
    updatePayload.lifecycleState = null;
    updatePayload.lifecycleError = null;
  }

  const updatedSession = shouldStopSandboxAfterArchive
    ? (
        await archiveSession(sessionId, {
          currentSession: existingSession,
          update: updatePayload,
          logPrefix: "[Sessions]",
          scheduleBackgroundWork: after,
        })
      ).session
    : await updateSession(sessionId, updatePayload);

  if (!updatedSession) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  return Response.json({ session: updatedSession });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { sessionId } = await params;
  const existingSession = await getSessionById(sessionId);

  if (!existingSession) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  if (existingSession.userId !== session.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await deleteSession(sessionId);
  return Response.json({ success: true });
}
