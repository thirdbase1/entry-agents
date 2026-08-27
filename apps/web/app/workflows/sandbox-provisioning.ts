import { toErrorMessage } from "@open-agents/sandbox";
import { getWorkflowMetadata } from "workflow";
import {
  claimSessionSandboxProvisioningRunId,
  clearSessionSandboxProvisioningRunIdIfOwned,
  getSessionById,
  updateSession,
} from "@/lib/db/sessions";
import {
  provisionSessionSandbox,
  SessionArchivedDuringProvisioningError,
} from "@/lib/sandbox/provisioning";

async function runProvisioning(sessionId: string, runId: string) {
  "use step";

  const session = await getSessionById(sessionId);
  if (!session) {
    return { skipped: true, reason: "session-not-found" };
  }
  if (session.sandboxProvisioningRunId === null) {
    const claimed = await claimSessionSandboxProvisioningRunId(
      sessionId,
      runId,
    );
    if (!claimed) {
      return { skipped: true, reason: "run-replaced" };
    }
  } else if (session.sandboxProvisioningRunId !== runId) {
    return { skipped: true, reason: "run-replaced" };
  }

  try {
    const result = await provisionSessionSandbox({ sessionId });
    await clearSessionSandboxProvisioningRunIdIfOwned(sessionId, runId);
    return {
      skipped: false,
      sandboxState: result.sandboxState,
    };
  } catch (error) {
    if (error instanceof SessionArchivedDuringProvisioningError) {
      await clearSessionSandboxProvisioningRunIdIfOwned(sessionId, runId);
      return { skipped: true, reason: "session-archived" };
    }

    // Use toErrorMessage() (not bare error.message) so the persisted
    // lifecycleError carries the real API response body -- the
    // @vercel/sandbox SDK's APIError keeps .message generic ("Status
    // code 400 is not ok") and puts the actual cause on separate
    // .text/.json properties. Found 2026-08-27 while debugging a real
    // 400 that reached this catch with no diagnosable detail at all
    // (same generic-message gap as the 2026-08-24 402/quota incident,
    // just never patched for the general provisioning-failure path).
    const message = toErrorMessage(error);
    await updateSession(sessionId, {
      lifecycleState: "failed",
      lifecycleError: message,
    });
    await clearSessionSandboxProvisioningRunIdIfOwned(sessionId, runId);
    throw error;
  }
}

export async function sandboxProvisioningWorkflow(sessionId: string) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  return runProvisioning(sessionId, workflowRunId);
}
