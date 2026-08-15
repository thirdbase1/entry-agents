import "server-only";

import { start } from "workflow/api";
import { archiveSandboxStopWorkflow } from "@/app/workflows/archive-sandbox-stop";

/**
 * Kicks off the durable archive-sandbox-stop workflow in the background.
 * Falls back to running the same work inline (best-effort, same as the old
 * behavior) only if `start()` itself throws synchronously -- e.g. the
 * workflow runtime is unreachable. That inline fallback is intentionally
 * NOT durable; it exists purely so an archive request never hard-fails
 * just because the workflow platform had a blip. The durable `start()`
 * path is what actually fixes the "stuck archived forever" failure mode.
 */
export function kickArchiveSandboxStopWorkflow(
  sessionId: string,
  logPrefix: string,
): void {
  void (async () => {
    try {
      const run = await start(archiveSandboxStopWorkflow, [
        sessionId,
        logPrefix,
      ]);
      console.log(
        `${logPrefix} Started archive-sandbox-stop workflow run ${run.runId} for session ${sessionId}.`,
      );
    } catch (error) {
      console.error(
        `${logPrefix} Failed to start archive-sandbox-stop workflow for session ${sessionId}; falling back to inline stop:`,
        error,
      );
      const { finalizeArchivedSessionSandboxInline } = await import(
        "./archive-session"
      );
      await finalizeArchivedSessionSandboxInline(sessionId, logPrefix);
    }
  })();
}
