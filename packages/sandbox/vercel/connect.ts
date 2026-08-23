import type { Sandbox, SandboxHooks } from "../interface.ts";
import type { VercelSandboxConfig } from "./config.ts";
import { VercelSandbox } from "./sandbox.ts";
import type { VercelState } from "./state.ts";

interface ConnectOptions {
  env?: Record<string, string>;
  githubToken?: string;
  gitUser?: { name: string; email: string };
  hooks?: SandboxHooks;
  timeout?: number;
  vcpus?: number;
  ports?: number[];
  baseSnapshotId?: string;
  resume?: boolean;
  createIfMissing?: boolean;
  persistent?: boolean;
  snapshotExpiration?: number;
  skipGitWorkspaceBootstrap?: boolean;
}

function getRemainingTimeout(
  expiresAt: number | undefined,
): number | undefined {
  if (!expiresAt) {
    return undefined;
  }

  const remaining = expiresAt - Date.now();
  return remaining > 10_000 ? remaining : undefined;
}

function getSandboxName(state: VercelState): string | undefined {
  if (typeof state.sandboxName === "string" && state.sandboxName.length > 0) {
    return state.sandboxName;
  }

  if (typeof state.sandboxId === "string" && state.sandboxId.length > 0) {
    return state.sandboxId;
  }

  return undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

// Treats the sandbox as permanently gone -- triggers the createIfMissing
// fresh-recreate fallback in connectNamedSandbox below. Must stay aligned
// with apps/web/lib/sandbox/utils.ts's isSandboxUnavailableError (the
// broader app-level check used for state-clearing decisions elsewhere).
// Found 2026-08-23: a named sandbox whose underlying resume snapshot had
// expired/been cleaned up surfaces as "Status code 410 is not ok" from the
// Vercel Sandbox SDK, NOT 404 -- this previously fell through the
// createIfMissing check entirely (only matched 404/"not found"), so the
// error was rethrown instead of triggering a fresh git-clone recreate,
// hard-crashing the provisioning workflow (3 real runs failed this way in
// production before the fix).
export function isSandboxNotFoundError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("status code 404") ||
    message.includes("status code 410") ||
    message.includes("not found") ||
    message.includes("sandbox is stopped") ||
    message.includes("sandbox probe failed") ||
    message.includes("expected a stream of command data")
  );
}

// Vercel Hobby's Snapshot Storage quota (15GB) is billed per cycle: once
// exceeded once within a cycle, creating a PERSISTENT (auto-snapshotting)
// sandbox is blocked with HTTP 402 until the next monthly reset --
// deleting existing snapshots afterward does NOT clear this, confirmed
// 2026-08-23 by reproducing the real error body directly against
// Vercel's API: {"code":"payment_required","message":"Hobby plan usage
// limit exceeded for Snapshots Storage. Limit will be reset on
// <next-month>. Please upgrade to a Pro plan to continue using Vercel
// Sandbox, or delete unused snapshots."}. Non-persistent sandbox creation
// is unaffected. Gates the persistent -> non-persistent degrade-and-retry
// fallback below so chat keeps working (without cross-session resume)
// instead of hard-failing provisioning for the rest of the billing cycle.
export function isSnapshotStorageQuotaExceededError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("snapshots storage") ||
    (message.includes("status code 402") && message.includes("snapshot"))
  );
}

function buildCreateConfig(
  state: VercelState,
  options?: ConnectOptions,
): VercelSandboxConfig {
  const sandboxName = getSandboxName(state);

  return {
    ...(sandboxName ? { name: sandboxName } : {}),
    ...(state.source
      ? {
          source: {
            url: state.source.repo,
            branch: state.source.branch,
            newBranch: state.source.newBranch,
          },
        }
      : {}),
    ...(state.snapshotId ? { restoreSnapshotId: state.snapshotId } : {}),
    env: options?.env,
    githubToken: options?.githubToken,
    gitUser: options?.gitUser,
    hooks: options?.hooks,
    ...(options?.timeout !== undefined && { timeout: options.timeout }),
    ...(options?.vcpus !== undefined && { vcpus: options.vcpus }),
    ...(options?.ports && { ports: options.ports }),
    ...(options?.baseSnapshotId && {
      baseSnapshotId: options.baseSnapshotId,
    }),
    ...(options?.persistent !== undefined && {
      persistent: options.persistent,
    }),
    ...(options?.snapshotExpiration !== undefined && {
      snapshotExpiration: options.snapshotExpiration,
    }),
    ...(options?.skipGitWorkspaceBootstrap && {
      skipGitWorkspaceBootstrap: true,
    }),
  };
}

async function createSandboxWithQuotaFallback(
  config: VercelSandboxConfig,
): Promise<Sandbox> {
  try {
    return await VercelSandbox.create(config);
  } catch (error) {
    if (config.persistent === false || !isSnapshotStorageQuotaExceededError(error)) {
      throw error;
    }

    console.warn(
      "[sandbox] Hobby plan Snapshot Storage quota exceeded -- creating a " +
        "non-persistent sandbox instead (no cross-session resume until " +
        "the billing cycle resets or the plan is upgraded).",
      error,
    );
    return await VercelSandbox.create({ ...config, persistent: false });
  }
}

async function connectNamedSandbox(
  state: VercelState,
  options?: ConnectOptions,
): Promise<Sandbox> {
  const sandboxName = getSandboxName(state);
  if (!sandboxName) {
    throw new Error("Persistent sandbox name is required");
  }

  const remainingTimeout = getRemainingTimeout(state.expiresAt);

  try {
    return await VercelSandbox.connect(sandboxName, {
      env: options?.env,
      githubToken: options?.githubToken,
      hooks: options?.hooks,
      remainingTimeout,
      ports: options?.ports,
      resume: options?.resume,
    });
  } catch (error) {
    if (!options?.createIfMissing || !isSandboxNotFoundError(error)) {
      throw error;
    }
  }

  return createSandboxWithQuotaFallback(buildCreateConfig(state, options));
}

/**
 * Connect to the Vercel-backed cloud sandbox based on the provided state.
 *
 * - If `sandboxName` is present, reconnects to the named persistent sandbox
 * - If `snapshotId` is present without `sandboxName`, restores from a legacy snapshot
 * - If `source` is present, creates a new sandbox and prepares the repo
 * - Otherwise, creates an empty sandbox
 */
export async function connectVercel(
  state: VercelState,
  options?: ConnectOptions,
): Promise<Sandbox> {
  const sandboxName = getSandboxName(state);

  if (sandboxName) {
    return connectNamedSandbox(state, options);
  }

  return createSandboxWithQuotaFallback(buildCreateConfig(state, options));
}
