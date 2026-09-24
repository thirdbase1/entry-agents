import "server-only";

import { connectSandbox, getSandboxProvider, isKnownSandboxType, type SandboxState } from "@open-agents/sandbox";
import {
  getChatsBySessionId,
  getSessionById,
  updateSession,
} from "@/lib/db/sessions";
import {
  SANDBOX_INACTIVITY_TIMEOUT_MS,
  SANDBOX_MIGRATION_LEAD_MS,
} from "./config";
import {
  canOperateOnSandbox,
  clearSandboxState,
  getPersistentSandboxName,
} from "./utils";

export type SandboxLifecycleState =
  | "provisioning"
  | "active"
  | "hibernating"
  | "hibernated"
  | "restoring"
  | "migrating"
  | "archived"
  | "failed";

export type SandboxLifecycleReason =
  | "sandbox-created"
  | "timeout-extended"
  | "snapshot-restored"
  | "reconnect"
  | "manual-stop"
  | "status-check-overdue";

export interface SandboxLifecycleEvaluationResult {
  action: "skipped" | "hibernated" | "migration-needed" | "failed";
  reason?: string;
}

interface LifecycleTimingSource {
  hibernateAfter: Date | null;
  lastActivityAt: Date | null;
  sandboxExpiresAt: Date | null;
  updatedAt: Date;
}

type LifecycleUpdate = Parameters<typeof updateSession>[1];

export function getNextLifecycleVersion(
  currentVersion: number | null | undefined,
): number {
  return (currentVersion ?? 0) + 1;
}

export function getSandboxExpiresAtMs(
  sandboxState: SandboxState | null | undefined,
): number | undefined {
  if (!sandboxState || !("expiresAt" in sandboxState)) {
    return undefined;
  }
  return typeof sandboxState.expiresAt === "number"
    ? sandboxState.expiresAt
    : undefined;
}

/**
 * True once a session's sandbox is close enough to its hard
 * session-duration cap that the lifecycle workflow should proactively
 * migrate it to a fresh sandbox rather than just skip evaluation --
 * unlike the inactivity-hibernate path, doing nothing here guarantees a
 * hard kill instead, so an active stream must trigger a migration
 * instead of a no-op "active-workflow" skip. See
 * lib/sandbox/migration.ts (performSandboxMigration).
 */
export function isSandboxMigrationDue(
  sandboxState: SandboxState | null | undefined,
): boolean {
  if (!sandboxState) {
    return false;
  }

  // Capability-gated, not vendor-gated: only providers whose filesystem is
  // destroyed by a stop need the pack/restore migration dance. Boat
  // snapshots on stop and resumes with the workspace intact, so migration
  // would be pure churn there (and would needlessly drop running work).
  const provider = getSandboxProvider(String(sandboxState.type));
  if (!provider || !provider.capabilities.workspaceMigration) {
    return false;
  }

  const expiresAtMs = getSandboxExpiresAtMs(sandboxState);
  if (expiresAtMs === undefined) {
    return false;
  }
  return Date.now() >= expiresAtMs - SANDBOX_MIGRATION_LEAD_MS;
}

export function getSandboxExpiresAtDate(
  sandboxState: SandboxState | null | undefined,
): Date | null {
  const expiresAtMs = getSandboxExpiresAtMs(sandboxState);
  return expiresAtMs === undefined ? null : new Date(expiresAtMs);
}

export function buildLifecycleActivityUpdate(
  activityAt: Date = new Date(),
  lifecycleState: Extract<
    SandboxLifecycleState,
    "active" | "restoring"
  > = "active",
): Pick<
  LifecycleUpdate,
  "lifecycleState" | "lifecycleError" | "lastActivityAt" | "hibernateAfter"
> {
  return {
    lifecycleState,
    lifecycleError: null,
    lastActivityAt: activityAt,
    hibernateAfter: new Date(
      activityAt.getTime() + SANDBOX_INACTIVITY_TIMEOUT_MS,
    ),
  };
}

export function buildActiveLifecycleUpdate(
  sandboxState: SandboxState | null | undefined,
  options?: {
    activityAt?: Date;
    lifecycleState?: Extract<SandboxLifecycleState, "active" | "restoring">;
  },
): LifecycleUpdate {
  const activityAt = options?.activityAt ?? new Date();

  return {
    ...buildLifecycleActivityUpdate(
      activityAt,
      options?.lifecycleState ?? "active",
    ),
    sandboxExpiresAt: getSandboxExpiresAtDate(sandboxState),
  };
}

export function buildHibernatedLifecycleUpdate(): LifecycleUpdate {
  return {
    lifecycleState: "hibernated",
    sandboxExpiresAt: null,
    hibernateAfter: null,
    lifecycleRunId: null,
    lifecycleError: null,
  };
}

function getInactivityDueAtMs(source: LifecycleTimingSource): number {
  if (source.hibernateAfter) {
    return source.hibernateAfter.getTime();
  }

  const lastActivityMs =
    source.lastActivityAt?.getTime() ?? source.updatedAt.getTime();
  return lastActivityMs + SANDBOX_INACTIVITY_TIMEOUT_MS;
}

function getExpiryDueAtMs(source: LifecycleTimingSource): number | null {
  if (!source.sandboxExpiresAt) {
    return null;
  }
  // Uses the migration lead time (minutes), not the 10s
  // SANDBOX_EXPIRES_BUFFER_MS used elsewhere to mean "basically already
  // expired" -- this value only controls when the lifecycle workflow
  // wakes up to *evaluate*, and it needs enough runway before the hard
  // cap to actually pack+restore a migration if a stream is active.
  return source.sandboxExpiresAt.getTime() - SANDBOX_MIGRATION_LEAD_MS;
}

// Changed 2026-08-28: previously took the MIN of this and the real
// hard-cap-based `expiryDueAtMs`, which meant an idle sandbox got
// proactively hibernated (and, since sandboxes are non-persistent,
// permanently lost -- Vercel's own docs confirm non-persistent
// sandboxes "cannot be resumed") up to
// `SANDBOX_INACTIVITY_TIMEOUT_MS - SANDBOX_MIGRATION_LEAD_MS` (~25 min
// on Hobby's 45-min cap) *before* Vercel would have force-stopped it
// anyway. Owner explicitly asked: don't stop a sandbox until it
// genuinely has to. Now the real expiry governs whenever it's known --
// an idle sandbox keeps running (and being billed for idle compute)
// until shortly before its actual hard cap, active or not, instead of
// being cut short by a separate, earlier idle timer. Trade-off accepted
// per owner: this costs more idle compute time than the old 30-min
// cutoff, in exchange for never discarding work earlier than Vercel
// itself would force. `getInactivityDueAtMs`/`hibernateAfter` remain as
// a fallback only for the rare case a session has no tracked
// `sandboxExpiresAt` yet (e.g. mid-provisioning), so the lifecycle
// workflow never sleeps forever.
export function getLifecycleDueAtMs(source: LifecycleTimingSource): number {
  const expiryDueAtMs = getExpiryDueAtMs(source);
  if (expiryDueAtMs !== null) {
    return expiryDueAtMs;
  }
  return getInactivityDueAtMs(source);
}

async function hasActiveStreamForSession(sessionId: string): Promise<boolean> {
  const chatsInSession = await getChatsBySessionId(sessionId);
  return chatsInSession.some((chat) => chat.activeStreamId !== null);
}

async function restoreActiveLifecycleState(
  sessionId: string,
  sandboxState: SandboxState,
): Promise<void> {
  await updateSession(sessionId, {
    lifecycleState: "active",
    lifecycleError: null,
    sandboxExpiresAt: getSandboxExpiresAtDate(sandboxState),
  });
}

/**
 * One-shot lifecycle evaluator for workflow orchestration.
 *
 * This performs a single evaluation pass and exits.
 * The durable workflow loops and calls this when it wakes.
 */
export async function evaluateSandboxLifecycle(
  sessionId: string,
  reason: SandboxLifecycleReason,
): Promise<SandboxLifecycleEvaluationResult> {
  const session = await getSessionById(sessionId);
  if (!session) {
    return { action: "skipped", reason: "session-not-found" };
  }

  if (session.status === "archived" || session.lifecycleState === "archived") {
    return { action: "skipped", reason: "session-archived" };
  }

  const sandboxState = session.sandboxState;
  if (!canOperateOnSandbox(sandboxState)) {
    return { action: "skipped", reason: "sandbox-not-operable" };
  }
  if (!isKnownSandboxType(sandboxState.type)) {
    return { action: "skipped", reason: "unsupported-sandbox-type" };
  }

  const nowMs = Date.now();
  const dueAtMs = getLifecycleDueAtMs(session);

  if (nowMs < dueAtMs) {
    return { action: "skipped", reason: "not-due-yet" };
  }

  // Non-persistent Vercel sandboxes cannot be resumed after stop(). Once
  // the hard sandbox lifetime is close enough to require lifecycle action,
  // migration must happen regardless of whether the session currently has
  // an active stream. Hibernating here would destroy an idle user's
  // workspace with no way to reconstruct it.
  //
  // The migration step is deliberately outside this module to keep the
  // lifecycle evaluator dependency-light and avoid a circular import.
  if (isSandboxMigrationDue(sandboxState)) {
    return { action: "migration-needed" };
  }

  if (await hasActiveStreamForSession(sessionId)) {
    return { action: "skipped", reason: "active-workflow" };
  }

  try {
    await updateSession(sessionId, {
      lifecycleState: "hibernating",
      lifecycleError: null,
    });

    const sandbox = await connectSandbox(sandboxState);

    if (await hasActiveStreamForSession(sessionId)) {
      await restoreActiveLifecycleState(sessionId, sandboxState);
      return { action: "skipped", reason: "active-workflow" };
    }

    const refreshedSession = await getSessionById(sessionId);
    if (
      refreshedSession?.sandboxState &&
      canOperateOnSandbox(refreshedSession.sandboxState)
    ) {
      const lifecycleTimingChanged =
        refreshedSession.lastActivityAt?.getTime() !==
          session.lastActivityAt?.getTime() ||
        refreshedSession.hibernateAfter?.getTime() !==
          session.hibernateAfter?.getTime() ||
        refreshedSession.sandboxExpiresAt?.getTime() !==
          session.sandboxExpiresAt?.getTime();

      if (
        lifecycleTimingChanged &&
        Date.now() < getLifecycleDueAtMs(refreshedSession)
      ) {
        await restoreActiveLifecycleState(
          sessionId,
          refreshedSession.sandboxState,
        );
        return { action: "skipped", reason: "not-due-yet" };
      }
    }

    await sandbox.stop();

    const clearedState = clearSandboxState(sandboxState);
    await updateSession(sessionId, {
      snapshotUrl: null,
      snapshotCreatedAt: null,
      sandboxState: clearedState,
      ...buildHibernatedLifecycleUpdate(),
    });
    console.log(
      `[Lifecycle] Hibernated sandbox for session ${sessionId} (reason=${reason}, sandboxName=${getPersistentSandboxName(clearedState) ?? "none"}).`,
    );
    return { action: "hibernated" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateSession(sessionId, {
      lifecycleState: "failed",
      lifecycleRunId: null,
      lifecycleError: message,
    });
    console.error(
      `[Lifecycle] Failed to evaluate sandbox lifecycle for session ${sessionId}:`,
      error,
    );
    return { action: "failed", reason: message };
  }
}
