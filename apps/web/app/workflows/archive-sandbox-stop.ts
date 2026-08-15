import { connectSandbox } from "@open-agents/sandbox";
import { getSessionById, updateSession } from "@/lib/db/sessions";
import {
  canOperateOnSandbox,
  clearSandboxState,
  isSandboxNotFoundError,
} from "@/lib/sandbox/utils";

/**
 * Durable replacement for the old fire-and-forget `after()` callback that
 * used to do this work inline inside the archive request handler (see
 * lib/sandbox/archive-session.ts). That approach silently dropped the
 * sandbox-stop step at least once in production: a session ended up with
 * status "archived" but sandboxState never cleared and lifecycleState
 * stuck at "active" forever, because the callback never ran (not even its
 * own catch block fired -- lifecycleError stayed null). Since there's no
 * durable record of that background work, nothing could ever retry it and
 * the session was permanently stuck 409-ing on every unarchive attempt.
 *
 * Routing this through the Workflow SDK instead means the platform
 * persists the run and can resume/retry it even if the invoking function
 * is torn down mid-flight (e.g. a deploy landing at the wrong moment),
 * instead of the work vanishing with no trace.
 */
async function finalizeArchivedSandboxStep(
  sessionId: string,
  logPrefix: string,
): Promise<{
  action: "stopped" | "already-clear" | "skipped";
  reason?: string;
}> {
  "use step";

  const session = await getSessionById(sessionId);
  if (!session || session.status !== "archived") {
    return { action: "skipped", reason: "not-archived" };
  }
  if (!canOperateOnSandbox(session.sandboxState)) {
    return { action: "already-clear" };
  }

  try {
    const sandbox = await connectSandbox(session.sandboxState);
    await sandbox.stop();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isSandboxNotFoundError(message)) {
      // Genuinely transient (network blip, cold sandbox API, etc). Record
      // what happened but re-throw so the workflow step is retried by the
      // platform instead of us silently giving up after one attempt.
      await updateSession(sessionId, {
        lifecycleError: `${logPrefix} Archive finalization attempt failed: ${message}`,
      });
      throw error;
    }
    // Sandbox is already gone (e.g. it auto-expired before we got to it) --
    // that's fine, there's nothing left to stop, just clear our records.
  }

  const latest = await getSessionById(sessionId);
  if (!latest || latest.status !== "archived") {
    return { action: "skipped", reason: "no-longer-archived" };
  }

  await updateSession(sessionId, {
    snapshotUrl: null,
    snapshotCreatedAt: null,
    sandboxState: clearSandboxState(latest.sandboxState),
    lifecycleState: "archived",
    sandboxExpiresAt: null,
    hibernateAfter: null,
    lifecycleError: null,
  });

  return { action: "stopped" };
}

export async function archiveSandboxStopWorkflow(
  sessionId: string,
  logPrefix: string,
) {
  "use workflow";
  return finalizeArchivedSandboxStep(sessionId, logPrefix);
}
