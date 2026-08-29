import { sleep } from "workflow";
import {
  SANDBOX_LIFECYCLE_MIN_SLEEP_MS,
  SANDBOX_MIGRATION_MAX_ATTEMPTS,
} from "@/lib/sandbox/config";
import { getMigrationRetryBackoffMs } from "@/lib/sandbox/migration-backoff";
import type {
  SandboxLifecycleEvaluationResult,
  SandboxLifecycleReason,
} from "@/lib/sandbox/lifecycle";
import type { SandboxMigrationResult } from "@/lib/sandbox/migration";
import { canOperateOnSandbox } from "@/lib/sandbox/utils";

// NOTE ON IMPORTS IN THIS FILE (fixed 2026-08-29): everything below
// that touches the database (getSessionById/updateSession,
// evaluateSandboxLifecycle, getLifecycleDueAtMs, performSandboxMigration)
// is loaded via dynamic import() *inside* the "use step" functions that
// use it, never as a top-level static import -- a static import of any
// module that transitively imports "@/lib/db/sessions" (which pulls in
// "postgres" via lib/db/client.ts) leaks Node.js-dependent code into
// this file's restricted "use workflow" bundle even when every actual
// call site is safely inside a step. This was a real, already-live
// latent bug (the getSessionById/updateSession top-level import here
// predates today) that a build cache hit had been silently masking;
// only surfaced once an unrelated change in this file forced a fresh
// build. `canOperateOnSandbox` and `getMigrationRetryBackoffMs` stay as
// static imports because their modules (lib/sandbox/utils.ts,
// lib/sandbox/migration-backoff.ts) are deliberately dependency-free.
// See docs/agents/lessons-learned.md 2026-08-29 entry, and the
// 2026-08-26 chat.ts entry for the same class of fix
// (checkIsRepeatFailureStep).

interface LifecycleWakeDecision {
  shouldContinue: boolean;
  wakeAtMs?: number;
  reason?: string;
}

async function claimLifecycleLease(
  sessionId: string,
  runId: string,
): Promise<boolean> {
  const { getSessionById, updateSession } = await import("@/lib/db/sessions");

  const current = await getSessionById(sessionId);
  if (!current) {
    return false;
  }

  if (current.lifecycleRunId && current.lifecycleRunId !== runId) {
    return false;
  }

  if (current.lifecycleRunId !== runId) {
    await updateSession(sessionId, { lifecycleRunId: runId });
  }

  const verified = await getSessionById(sessionId);
  return verified?.lifecycleRunId === runId;
}

async function computeLifecycleWakeDecision(
  sessionId: string,
  runId: string,
): Promise<LifecycleWakeDecision> {
  "use step";

  const { getSessionById } = await import("@/lib/db/sessions");
  const { getLifecycleDueAtMs } = await import("@/lib/sandbox/lifecycle");

  const session = await getSessionById(sessionId);
  if (!session) {
    return { shouldContinue: false, reason: "session-not-found" };
  }
  if (session.status === "archived" || session.lifecycleState === "archived") {
    return { shouldContinue: false, reason: "session-archived" };
  }

  const state = session.sandboxState;
  if (!canOperateOnSandbox(state) || state.type !== "vercel") {
    return { shouldContinue: false, reason: "sandbox-not-operable" };
  }
  if (!(await claimLifecycleLease(sessionId, runId))) {
    return { shouldContinue: false, reason: "run-replaced" };
  }

  return {
    shouldContinue: true,
    wakeAtMs: getLifecycleDueAtMs(session),
  };
}

async function runLifecycleEvaluation(
  sessionId: string,
  reason: SandboxLifecycleReason,
): Promise<SandboxLifecycleEvaluationResult> {
  "use step";
  const { evaluateSandboxLifecycle } = await import("@/lib/sandbox/lifecycle");
  return evaluateSandboxLifecycle(sessionId, reason);
}

async function runSandboxMigrationStep(
  sessionId: string,
): Promise<SandboxMigrationResult> {
  "use step";
  const { performSandboxMigration } = await import("@/lib/sandbox/migration");
  return performSandboxMigration(sessionId);
}

async function clearLifecycleRunIdIfOwned(
  sessionId: string,
  runId: string,
): Promise<void> {
  "use step";

  const { getSessionById, updateSession } = await import("@/lib/db/sessions");

  const session = await getSessionById(sessionId);
  if (!session || session.lifecycleRunId !== runId) {
    return;
  }

  await updateSession(sessionId, { lifecycleRunId: null });
}

export async function sandboxLifecycleWorkflow(
  sessionId: string,
  reason: SandboxLifecycleReason,
  runId: string,
) {
  "use workflow";
  while (true) {
    const decision = await computeLifecycleWakeDecision(sessionId, runId);
    if (!decision.shouldContinue || decision.wakeAtMs === undefined) {
      await clearLifecycleRunIdIfOwned(sessionId, runId);
      return { skipped: true, reason: decision.reason ?? "no-decision" };
    }

    const now = Date.now();
    const wakeAtMs = Math.max(
      decision.wakeAtMs,
      now + SANDBOX_LIFECYCLE_MIN_SLEEP_MS,
    );
    await sleep(new Date(wakeAtMs));

    const evaluation = await runLifecycleEvaluation(sessionId, reason);

    if (evaluation.action === "migration-needed") {
      const migrationResult = await runSandboxMigrationStep(sessionId);

      // Fixed 2026-08-29: a failed migration used to just fall through
      // to the same MIN_SLEEP (5s) tick as a normal recheck -- an
      // expensive pack+create+restore sequence hot-retrying every 5
      // seconds forever with no backoff and no limit whenever it kept
      // failing. Now: back off exponentially, and give up after
      // SANDBOX_MIGRATION_MAX_ATTEMPTS so a persistently broken
      // migration can't hammer Vercel's sandbox APIs or burn workflow
      // steps indefinitely -- the sandbox will have hit its real hard
      // cap by then anyway, and the session is left in the existing
      // "failed" lifecycle state (surfaced in the UI) instead.
      if (migrationResult.action === "failed") {
        const failureCount = migrationResult.failureCount ?? 1;
        if (failureCount >= SANDBOX_MIGRATION_MAX_ATTEMPTS) {
          await clearLifecycleRunIdIfOwned(sessionId, runId);
          return { skipped: false, evaluation: migrationResult };
        }
        await sleep(
          new Date(Date.now() + getMigrationRetryBackoffMs(failureCount)),
        );
      }

      // On success the session now has a brand-new sandboxExpiresAt
      // far in the future; on failure (below the retry cap) the
      // near-expiry condition just gets re-evaluated after the backoff
      // sleep above.
      continue;
    }

    if (
      evaluation.action === "skipped" &&
      (evaluation.reason === "not-due-yet" ||
        evaluation.reason === "active-workflow" ||
        evaluation.reason === "snapshot-already-in-progress")
    ) {
      continue;
    }

    await clearLifecycleRunIdIfOwned(sessionId, runId);
    return { skipped: false, evaluation };
  }
}
