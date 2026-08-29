/**
 * Sandbox timeout configuration.
 * All timeout values are in milliseconds.
 */

import { isHobbyResourceProfile } from "../deployment/resource-profile.ts";

/** SDK safety buffer reserved for sandbox before-stop hooks (30 seconds) */
const VERCEL_SANDBOX_TIMEOUT_BUFFER_MS = 30 * 1000;

/** Standard timeout for new cloud sandboxes (5 hours minus hook buffer) */
const STANDARD_SANDBOX_TIMEOUT_MS =
  5 * 60 * 60 * 1000 - VERCEL_SANDBOX_TIMEOUT_BUFFER_MS;

/**
 * Hobby-compatible timeout for new cloud sandboxes -- Hobby's documented
 * max session duration is 45 minutes (confirmed 2026-08-23 via Vercel's
 * Sandbox pricing/quotas doc: "Max Session Duration: Hobby 45 minutes").
 * Use the full 45 minutes minus the hook buffer instead of the previous
 * more conservative 40, since every extra minute matters while the team
 * is stuck on Hobby.
 */
const HOBBY_SANDBOX_TIMEOUT_MS =
  45 * 60 * 1000 - VERCEL_SANDBOX_TIMEOUT_BUFFER_MS;

/** Default timeout for new cloud sandboxes */
export const DEFAULT_SANDBOX_TIMEOUT_MS = isHobbyResourceProfile()
  ? HOBBY_SANDBOX_TIMEOUT_MS
  : STANDARD_SANDBOX_TIMEOUT_MS;

/** Default vCPU count for new cloud sandboxes */
export const DEFAULT_SANDBOX_VCPUS = isHobbyResourceProfile() ? 1 : 4;

/** Manual extension duration for explicit fallback flows (20 minutes) */
export const EXTEND_TIMEOUT_DURATION_MS = 20 * 60 * 1000;

/**
 * Inactivity window used ONLY as a fallback wake time for the lifecycle
 * workflow when a session has no tracked `sandboxExpiresAt` yet (e.g.
 * mid-provisioning). No longer the primary hibernate trigger as of
 * 2026-08-28 -- see `getLifecycleDueAtMs` in lib/sandbox/lifecycle.ts.
 * Previously this fired well before the sandbox's real Hobby-plan
 * 45-min hard cap (see DEFAULT_SANDBOX_TIMEOUT_MS), proactively
 * hibernating (and, since sandboxes are non-persistent, permanently
 * discarding) an idle sandbox's filesystem up to ~25 minutes early.
 */
export const SANDBOX_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

/** Buffer for sandbox expiry checks (10 seconds) */
export const SANDBOX_EXPIRES_BUFFER_MS = 10 * 1000;

/**
 * Lead time before a sandbox's hard session-duration cap at which the
 * lifecycle workflow proactively migrates the session to a fresh
 * sandbox instead of letting Vercel hard-kill it mid-task (Hobby's cap
 * is 45 minutes -- see DEFAULT_SANDBOX_TIMEOUT_MS above). Chosen to
 * leave enough headroom for packing the workspace, creating a new
 * sandbox, and restoring it before time actually runs out. See
 * lib/sandbox/migration.ts.
 */
export const SANDBOX_MIGRATION_LEAD_MS = 5 * 60 * 1000;

/** Grace window before treating a lifecycle run as stale (2 minutes) */
export const SANDBOX_LIFECYCLE_STALE_RUN_GRACE_MS = 2 * 60 * 1000;

/** Minimum sleep between lifecycle workflow loop iterations (5 seconds) */
export const SANDBOX_LIFECYCLE_MIN_SLEEP_MS = 5 * 1000;

/**
 * Backoff base for retrying a *failed* sandbox migration (30 seconds),
 * doubled per consecutive failure and capped at
 * SANDBOX_MIGRATION_RETRY_MAX_MS. Added 2026-08-29: previously a failed
 * migration just looped back through the same SANDBOX_LIFECYCLE_MIN_SLEEP_MS
 * (5s) floor as a normal wake-and-recheck tick, meaning a migration that
 * kept failing (e.g. a transient pack/restore error, or a genuinely
 * unreachable old sandbox) hot-retried an expensive pack+create+restore
 * sequence every 5 seconds with no backoff and no limit -- hammering
 * Vercel's sandbox APIs and burning workflow steps indefinitely. See
 * lib/sandbox/migration.ts + apps/web/app/workflows/sandbox-lifecycle.ts.
 */
export const SANDBOX_MIGRATION_RETRY_BASE_MS = 30 * 1000;

/** Cap on the exponential migration-retry backoff (2 minutes). */
export const SANDBOX_MIGRATION_RETRY_MAX_MS = 2 * 60 * 1000;

/**
 * Give up auto-retrying a migration after this many consecutive
 * failures. At that point the sandbox has almost certainly already hit
 * its real hard cap anyway (backoff schedule: 30s+60s+120s+120s+120s
 * ~= 7.5 min, already past the 5-min SANDBOX_MIGRATION_LEAD_MS
 * headroom) -- further attempts are pointless. The session is left in
 * lifecycleState "failed" (existing "Connection issue" UI already
 * handles this) instead of hot-looping forever.
 */
export const SANDBOX_MIGRATION_MAX_ATTEMPTS = 5;

/**
 * Default ports to expose from cloud sandboxes.
 * Limited to 5 ports. Covers the most common framework defaults
 * plus the built-in code editor:
 * - 3000: Next.js, Express, Remix
 * - 5173: Vite, SvelteKit
 * - 4321: Astro
 * - 8000: code-server (built-in editor)
 */
export const DEFAULT_SANDBOX_PORTS = [3000, 5173, 4321, 8000];
export const CODE_SERVER_PORT = 8000;

/** Default working directory for sandboxes, used for path display */
export const DEFAULT_WORKING_DIRECTORY = "/vercel/sandbox";

/**
 * Optional base snapshot for fresh cloud sandboxes.
 *
 * Forked deployments should provide their own snapshot ID if they want a
 * preconfigured image. When unset, sandboxes start from Vercel's standard
 * runtime so deployments are not tied to a private snapshot in another scope.
 */
export const DEFAULT_SANDBOX_BASE_SNAPSHOT_ID =
  process.env.VERCEL_SANDBOX_BASE_SNAPSHOT_ID;
