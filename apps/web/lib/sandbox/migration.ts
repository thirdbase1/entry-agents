import "server-only";

import {
  connectSandbox,
  isKnownSandboxType,
  packWorkspacePayload,
  requireSandboxProvider,
  restoreWorkspacePayload,
  type Sandbox,
} from "@open-agents/sandbox";
import {
  claimSessionSandboxMigration,
  getSessionById,
  updateSession,
} from "@/lib/db/sessions";
import {
  DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
  DEFAULT_SANDBOX_PORTS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  DEFAULT_SANDBOX_VCPUS,
  getSandboxDriveConfig,
} from "@/lib/sandbox/config";
import {
  buildActiveLifecycleUpdate,
  getNextLifecycleVersion,
  isSandboxMigrationDue,
} from "@/lib/sandbox/lifecycle";
import { canOperateOnSandbox, isSandboxState } from "@/lib/sandbox/utils";

export interface SandboxMigrationResult {
  action: "skipped" | "migrated" | "failed";
  reason?: string;
  /**
   * Consecutive failure count *after* this attempt, only present when
   * action === "failed". Lets the caller (sandboxLifecycleWorkflow)
   * apply backoff and eventually give up instead of hot-retrying every
   * SANDBOX_LIFECYCLE_MIN_SLEEP_MS forever.
   */
  failureCount?: number;
}

async function killActiveCommandBestEffort(
  sandbox: Sandbox,
  sessionId: string,
  activeSandboxCommand: { cmdId: string } | null | undefined,
): Promise<void> {
  if (!activeSandboxCommand?.cmdId || !sandbox.killCommand) {
    return;
  }
  try {
    await sandbox.killCommand(activeSandboxCommand.cmdId);
  } catch (error) {
    console.warn(
      `[sandbox-migration] Failed to kill active command for session ${sessionId} before migrating (continuing anyway):`,
      error,
    );
  }
}

/**
 * Move a session off its current (soon-to-hard-expire) sandbox onto a
 * brand-new one, carrying over the full git history plus any
 * uncommitted/untracked work via packWorkspacePayload/
 * restoreWorkspacePayload (tarball-based, no snapshot API involved --
 * see packages/sandbox/migrate.ts). Safe to call even mid-task: any
 * in-flight bash command is force-killed first so packing the workspace
 * sees a consistent filesystem.
 */
export async function performSandboxMigration(
  sessionId: string,
  lifecycleRunId?: string,
): Promise<SandboxMigrationResult> {
  const session = await getSessionById(sessionId);
  if (!session) {
    return { action: "skipped", reason: "session-not-found" };
  }
  if (session.status === "archived" || session.lifecycleState === "archived") {
    return { action: "skipped", reason: "session-archived" };
  }
  if (session.lifecycleState === "migrating") {
    return { action: "skipped", reason: "migration-already-in-progress" };
  }

  if (!lifecycleRunId) {
    return { action: "skipped", reason: "migration-run-not-owned" };
  }

  const sandboxState = session.sandboxState;
  if (!canOperateOnSandbox(sandboxState) || !isKnownSandboxType(sandboxState.type)) {
    return { action: "skipped", reason: "sandbox-not-operable" };
  }

  if (!isSandboxMigrationDue(sandboxState)) {
    return { action: "skipped", reason: "not-due-yet" };
  }

  // Claim the transition in one database UPDATE. The workflow lease and
  // the lifecycle state must both still belong to this run; checking first
  // and updating later would allow two workers to migrate the same sandbox.
  const claimed = await claimSessionSandboxMigration(sessionId, lifecycleRunId);
  if (!claimed) {
    return { action: "skipped", reason: "migration-run-not-owned" };
  }

  let oldSandbox: Sandbox;
  try {
    oldSandbox = await connectSandbox(sandboxState);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureCount = (session.migrationFailureCount ?? 0) + 1;
    await updateSession(sessionId, {
      lifecycleState: "failed",
      lifecycleError: `Migration failed to connect to existing sandbox: ${message}`,
      migrationFailureCount: failureCount,
    });
    return { action: "failed", reason: message, failureCount };
  }

  await killActiveCommandBestEffort(
    oldSandbox,
    sessionId,
    session.activeSandboxCommand,
  );

  try {
    const payload = await packWorkspacePayload(oldSandbox);

    // A drive can only be attached read-write to ONE sandbox at a time.
    // Creating the fresh sandbox while the old one still holds the
    // session's drive gets rejected with a 409 drive_attached, so the
    // old sandbox has to release it first. Stopping it here is safe:
    // the workspace is already captured in `payload` above, and this
    // sandbox is about to hard-expire anyway. It also means the
    // stop() failure below can no longer lose the migration.
    await oldSandbox.stop().catch((error) => {
      console.warn(
        `[sandbox-migration] Failed to stop old sandbox for session ${sessionId} before creating its replacement (continuing, the new sandbox may reject the drive mount):`,
        error,
      );
    });

    // `fresh: true` drops the persisted identity, so this must create a
    // genuinely new sandbox rather than resume/reconnect to the one
    // that's about to expire, and we're restoring the workspace from
    // the tarball rather than a fresh git clone, so the bootstrap clone
    // step is skipped too.
    //
    // The provider comes from the session's own state (never hardcoded):
    // only providers whose capabilities report `workspaceMigration` can
    // reach this point -- isSandboxMigrationDue() gates on that above.
    //
    // Deliberately AFTER oldSandbox.stop() above: the drive mount is
    // what makes this ordering load-bearing, not the sandbox creation.
    const freshProvider = requireSandboxProvider(String(sandboxState.type));
    const freshState = freshProvider.buildProvisionState({
      sessionId,
      fresh: true,
    });

    const freshSandbox = await connectSandbox(
      { state: freshState },
      {
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        vcpus: DEFAULT_SANDBOX_VCPUS,
        ports: DEFAULT_SANDBOX_PORTS,
        baseSnapshotId: DEFAULT_SANDBOX_BASE_SNAPSHOT_ID,
        persistent: false,
        createIfMissing: true,
        skipGitWorkspaceBootstrap: true,
        // Mount the same per-session drive the old sandbox used, so the
        // restore below writes into durable storage. Undefined when
        // drives are disabled; providers without drive support ignore it.
        ...(getSandboxDriveConfig(sessionId) && {
          drives: getSandboxDriveConfig(sessionId),
        }),
      },
    );

    await restoreWorkspacePayload(freshSandbox, payload);

    const rawState = freshSandbox.getState?.();
    const newSandboxState = isSandboxState(rawState) ? rawState : undefined;
    if (!newSandboxState) {
      throw new Error(
        "Fresh sandbox did not return a usable state after restore",
      );
    }

    await updateSession(sessionId, {
      sandboxState: newSandboxState,
      activeSandboxCommand: null,
      snapshotUrl: null,
      snapshotCreatedAt: null,
      lifecycleVersion: getNextLifecycleVersion(session.lifecycleVersion),
      migrationFailureCount: 0,
      ...buildActiveLifecycleUpdate(newSandboxState),
    });

    // Best-effort: if a dev server was running on the old sandbox, it
    // died with it (workspace *files* transfer via the payload above,
    // but a detached background process never does). Relaunching is
    // deliberately outside the try/catch that guards the migration
    // itself -- the workspace is already safely moved at this point,
    // so a relaunch failure here must not be reported as a migration
    // failure. See relaunchDevServerAfterMigration's own doc comment.
    try {
      const { relaunchDevServerAfterMigration } =
        await import("@/app/api/sessions/[sessionId]/dev-server/route");
      const relaunched = await relaunchDevServerAfterMigration(freshSandbox);
      if (relaunched) {
        console.log(
          `[sandbox-migration] Relaunched dev server for session ${sessionId} on the fresh sandbox (${relaunched.packagePath}:${relaunched.port}).`,
        );
      }
    } catch (error) {
      console.warn(
        `[sandbox-migration] Dev server relaunch check failed for session ${sessionId} (non-fatal, migration already succeeded):`,
        error,
      );
    }

    console.log(
      `[sandbox-migration] Migrated session ${sessionId} to a fresh sandbox ahead of its session-duration cap.`,
    );
    return { action: "migrated" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureCount = (session.migrationFailureCount ?? 0) + 1;
    await updateSession(sessionId, {
      lifecycleState: "failed",
      lifecycleError: `Sandbox migration failed: ${message}`,
      migrationFailureCount: failureCount,
    });
    console.error(
      `[sandbox-migration] Failed to migrate session ${sessionId} (consecutive failure #${failureCount}):`,
      error,
    );
    return { action: "failed", reason: message, failureCount };
  }
}
