/**
 * Deliberately dependency-free (no "@/lib/db/*" imports, directly or
 * transitively) so it's safe to statically import into
 * apps/web/app/workflows/sandbox-lifecycle.ts's top-level "use
 * workflow" function without pulling Node.js-dependent code (e.g.
 * "postgres" via lib/db/client.ts) into the restricted workflow
 * bundle. Split out of lib/sandbox/lifecycle.ts on 2026-08-29 for
 * exactly this reason -- that module's other exports (evaluateSandboxLifecycle,
 * getLifecycleDueAtMs) do statically import "@/lib/db/sessions", and
 * merely re-exporting one dependency-free function from the same file
 * as those still pulls the whole module's top-level imports into any
 * static importer. See docs/agents/lessons-learned.md 2026-08-29 entry.
 */

import {
  SANDBOX_MIGRATION_RETRY_BASE_MS,
  SANDBOX_MIGRATION_RETRY_MAX_MS,
} from "./config";

/**
 * Exponential backoff for a failed sandbox migration attempt, capped
 * at SANDBOX_MIGRATION_RETRY_MAX_MS. failureCount is 1 on the first
 * failure (see performSandboxMigration's SandboxMigrationResult), so
 * this starts at the base delay rather than doubling it immediately.
 */
export function getMigrationRetryBackoffMs(failureCount: number): number {
  const exponent = Math.max(failureCount - 1, 0);
  return Math.min(
    SANDBOX_MIGRATION_RETRY_BASE_MS * 2 ** exponent,
    SANDBOX_MIGRATION_RETRY_MAX_MS,
  );
}
