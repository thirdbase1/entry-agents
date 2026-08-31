import { Sandbox as VercelSandboxSDK } from "@vercel/sandbox";
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

// The @vercel/sandbox SDK's APIError deliberately keeps `.message` generic
// ("Status code 402 is not ok") and puts the actual response body on
// separate `.text` / `.json` properties instead (see
// api-client/api-error.js in the SDK). Found 2026-08-24: this meant
// isSnapshotStorageQuotaExceededError below NEVER matched in production
// -- it only ever looked at `.message`, so real quota-exceeded 402s
// bubbled up as a bare "Status code 402 is not ok" with no "snapshot"
// substring anywhere, silently skipping the non-persistent fallback and
// hard-failing every chat sandbox provision instead. Now folds in
// `.text`/`.json` (duck-typed, not an SDK import) so detection sees the
// real body content too.
export function toErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [error.message];

  const withBody = error as Error & { text?: unknown; json?: unknown };
  if (typeof withBody.text === "string") {
    parts.push(withBody.text);
  }
  if (withBody.json !== undefined) {
    try {
      parts.push(JSON.stringify(withBody.json));
    } catch {
      // Non-serializable json payload -- ignore, .message/.text already captured above.
    }
  }

  return parts.join(" | ");
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

// Found 2026-08-28 debugging a real production incident: a session's
// sandbox goes STOPPED (not deleted) -- e.g. from the non-persistent
// default flip on 2026-08-25, non-persistent sandboxes appear not to
// support the resume:true path at all. connectNamedSandbox's initial
// VercelSandbox.connect(..., { resume }) call then fails with a
// "sandbox is stopped"-shaped error, which isSandboxNotFoundError
// (correctly, for the 410/expired-snapshot case it was designed for)
// treats as "permanently gone" and falls through to createIfMissing's
// create() fallback. But a STOPPED sandbox is not actually gone from
// Vercel's side -- create() with the same name then hard-400s with
// "A sandbox with the name '<name>' already exists for this project.
// Use GET /sandboxes/:name to resume it or delete it first," and every
// subsequent retry repeats the exact same failure forever (confirmed:
// this session failed 5 provisioning attempts within one minute, all
// identical). Detects that specific collision so the caller can delete
// the stale stopped sandbox object and retry create() once, instead of
// wedging the session permanently.
export function isSandboxAlreadyExistsError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("status code 400") &&
    message.includes("already exists") &&
    message.includes("sandbox")
  );
}

// Found 2026-08-29 debugging a real production incident: a session
// provisioned in the persistent-default era (before the 2026-08-25 flip
// to persistent:false) stores a real `snapshotId` in its DB-persisted
// sandbox state. That field is only ever cleared going forward by
// VercelSandbox.getState() (which deliberately never re-emits it -- see
// sandbox.ts), so it self-heals on the *first* successful reconnect --
// but if the underlying Vercel snapshot is gone by the time that
// reconnect is attempted (e.g. deleted by the scheduled Entry Sandbox
// Snapshot Cleanup workflow, which removes anything older than 2 days),
// every attempt to restore from it 400s with "Cannot resume sandbox: no
// snapshot available" before ever reaching a successful getState() call
// -- so the poisoned snapshotId never gets cleared, and the session
// fails identically forever (confirmed: 4 distinct workflow runs for
// the same session, all with the same error, within minutes). Detects
// that specific case so the caller can retry once without the stale
// restoreSnapshotId, falling back to a genuinely fresh sandbox (git
// clone from source) instead of wedging the session permanently.
export function isSnapshotResumeUnavailableError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("status code 400") &&
    message.includes("resume") &&
    message.includes("snapshot")
  );
}

// Statuses that mean the sandbox is genuinely, terminally dead -- safe to
// delete without losing anything in-flight. Deliberately narrower than
// sandbox.ts's own isStoppedSessionStatus (which also includes "stopping"
// and "snapshotting" for its own "can I still connect to this" purpose):
// a sandbox mid-stop or mid-snapshot is still doing real work, and this
// per-session provisioning claim-lock (see claimSessionSandboxProvisioningRunId)
// should mean we never race a live attempt in the first place -- but if
// that assumption is ever wrong (a bypassed lock, a name reused across a
// bug elsewhere), deleting a "running"/"pending" sandbox out from under
// an actual in-progress session would destroy real, live work. Fail loud
// (rethrow the original "already exists" error) instead of guessing.
const SAFE_TO_DELETE_STATUSES = new Set(["stopped", "aborted", "failed"]);

// Exported separately (pure, no SDK call) so this specific safety
// decision -- which statuses are safe to delete without risking live
// in-progress work -- is unit-testable on its own.
export function isSafeToDeleteSandboxStatus(
  status: string | undefined,
): boolean {
  return SAFE_TO_DELETE_STATUSES.has(status ?? "");
}

class UnsafeToDeleteSandboxError extends Error {
  constructor(name: string, status: string | undefined) {
    super(
      `Refusing to delete sandbox "${name}" -- its status is "${status}", ` +
        "not a terminal stopped/aborted/failed state. This means the " +
        '"already exists" collision is NOT a stale-stopped-sandbox case; ' +
        "deleting it could destroy a real in-progress session.",
    );
    this.name = "UnsafeToDeleteSandboxError";
  }
}

// Deletes a stale, terminally-dead sandbox object by name so a subsequent
// create() with the same name won't 400. Verifies the sandbox is actually
// dead first (see SAFE_TO_DELETE_STATUSES above) -- refuses to delete a
// live/in-progress one. If the sandbox is already gone by the time we
// check (deleted by Vercel or another request), that's fine -- nothing to
// do, the retry's own create() call is the real signal either way.
async function deleteStaleSandboxByName(name: string): Promise<void> {
  let stale: Awaited<ReturnType<typeof VercelSandboxSDK.get>>;
  try {
    stale = await VercelSandboxSDK.get({ name, resume: false });
  } catch (getError) {
    if (isSandboxNotFoundError(getError)) {
      return;
    }
    throw getError;
  }

  if (!isSafeToDeleteSandboxStatus(stale.status)) {
    throw new UnsafeToDeleteSandboxError(name, stale.status);
  }

  await stale.delete();
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
  alreadyRetriedAfterDelete = false,
  alreadyRetriedWithoutSnapshot = false,
  alreadyRetriedWithoutName = false,
): Promise<Sandbox> {
  try {
    return await VercelSandbox.create(config);
  } catch (error) {
    if (
      config.name &&
      !alreadyRetriedAfterDelete &&
      isSandboxAlreadyExistsError(error)
    ) {
      try {
        console.warn(
          `[sandbox] create() collided with a stale stopped sandbox named ` +
            `"${config.name}" -- deleting it and retrying create() once.`,
          error,
        );
        await deleteStaleSandboxByName(config.name);
        return createSandboxWithQuotaFallback(
          config,
          true,
          alreadyRetriedWithoutSnapshot,
          alreadyRetriedWithoutName,
        );
      } catch (deleteError) {
        // Found 2026-08-30: the stale sandbox may be in a non-terminal
        // status (e.g. perpetually resumed from a now-dead snapshot), so
        // deleteStaleSandboxByName correctly refuses (UnsafeToDelete) and
        // leaves the name held. Do NOT wedge provisioning -- fall through
        // to the unnamed fallback below.
        console.warn(
          `[sandbox] could not delete stale sandbox "${config.name}" before ` +
            "create -- falling back to an unnamed sandbox instead.",
          deleteError,
        );
      }
    }

    // Found 2026-08-30: a named sandbox can be permanently un-creatable
    // when the snapshot it would resume from is gone AND the dead name is
    // still held on Vercel's side (the resume 400 clears our DB state, but
    // the Vercel-side object/name is not removed). Rather than wedge the
    // session forever on a "already exists" 400, retry once WITHOUT the
    // name -- an unnamed, non-persistent sandbox always provisions, and we
    // persist whatever real name Vercel assigns so subsequent connects work.
    if (
      config.name &&
      isSandboxAlreadyExistsError(error) &&
      !alreadyRetriedWithoutName
    ) {
      console.warn(
        `[sandbox] create() for "${config.name}" still collided after ` +
          "recovery -- creating an unnamed non-persistent sandbox instead of " +
          "wedging the session.",
        error,
      );
      const { name: _name, ...configWithoutName } = config;
      return createSandboxWithQuotaFallback(
        { ...configWithoutName, persistent: false },
        alreadyRetriedAfterDelete,
        alreadyRetriedWithoutSnapshot,
        true,
      );
    }

    if (
      config.restoreSnapshotId &&
      !alreadyRetriedWithoutSnapshot &&
      isSnapshotResumeUnavailableError(error)
    ) {
      console.warn(
        "[sandbox] restoreSnapshotId points to a snapshot Vercel no " +
          "longer has (likely cleaned up as stale) -- retrying create() " +
          "once as a genuinely fresh sandbox instead of wedging the " +
          "session.",
        error,
      );
      const {
        restoreSnapshotId: _restoreSnapshotId,
        ...configWithoutSnapshot
      } = config;
      return createSandboxWithQuotaFallback(
        configWithoutSnapshot,
        alreadyRetriedAfterDelete,
        true,
        alreadyRetriedWithoutName,
      );
    }

    if (
      config.persistent === false ||
      !isSnapshotStorageQuotaExceededError(error)
    ) {
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
    if (!options?.createIfMissing) {
      throw error;
    }

    if (isSandboxNotFoundError(error)) {
      return createSandboxWithQuotaFallback(buildCreateConfig(state, options));
    }

    // Found 2026-08-30 in production: a session carrying a stale
    // snapshotId (whose underlying Vercel snapshot was already cleaned
    // up) fails its resume attempt with 400 "Cannot resume sandbox: no
    // snapshot available" -- which matches neither isSandboxNotFoundError
    // nor the create()-time guard below, so it used to be rethrown here
    // and wedge the session forever (the shipped 2026-08-29 fix only
    // covered create()-time restore failures; this error comes from
    // VercelSandboxSDK.get() before create() is ever reached). Recover
    // like the not-found case, but drop the stale snapshotId first --
    // buildCreateConfig would otherwise map it straight back into
    // restoreSnapshotId and 400 on the same dead snapshot again.
    if (isSnapshotResumeUnavailableError(error)) {
      const { snapshotId: _staleSnapshotId, ...stateWithoutSnapshot } = state;
      return createSandboxWithQuotaFallback(
        buildCreateConfig(stateWithoutSnapshot, options),
      );
    }

    throw error;
  }
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
