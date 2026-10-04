import type { SandboxState } from "@open-agents/sandbox";
import { isKnownSandboxType } from "@open-agents/sandbox/registry.js";
import { SANDBOX_EXPIRES_BUFFER_MS } from "./config";

/**
 * Modal's state shape. Declared structurally (not imported from
 * @open-agents/sandbox, whose Modal types are server-only) because this
 * module is pulled into client bundles too.
 */
export type ModalSandboxState = {
  type: "modal";
  sandboxId?: string;
  volumeName?: string;
  expiresAt?: number;
  source?: { repo: string; branch?: string; newBranch?: string };
};

/**
 * Lives here (rather than in provisioning.ts, where it originated) so
 * both provisioning.ts and migration.ts can import it without creating
 * an import cycle -- provisioning.ts -> lifecycle-kick.ts ->
 * sandbox-lifecycle.ts -> migration.ts already forms a cycle back to
 * provisioning.ts, so migration.ts can never import from provisioning.ts.
 * This module has no upward dependencies, so it's a safe shared home.
 *
 * Provider-neutral: any state whose `type` is registered in the sandbox
 * registry is a valid sandbox state. Unknown types are NOT -- that is what
 * makes a malformed/unsupported provider fail loudly instead of being
 * treated as a usable state and silently routed to the default provider.
 */
export function isSandboxState(value: unknown): value is SandboxState {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    isKnownSandboxType(value.type)
  );
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function getSandboxExpiresAt(state: unknown): number | undefined {
  if (!state || typeof state !== "object") {
    return undefined;
  }

  const expiresAt = (state as { expiresAt?: unknown }).expiresAt;
  return typeof expiresAt === "number" ? expiresAt : undefined;
}

export function getSessionSandboxName(sessionId: string): string {
  return `session_${sessionId}`;
}

export function getResumableSandboxName(state: unknown): string | null {
  // Modal's resumable handle is the Volume, not the sandbox: a sandbox id
  // is only ever a handle on a live container, while the volume holds the
  // workspace across container lifetimes.
  return getModalVolumeName(state);
}

/** Modal's durable workspace volume name, when the state is Modal's. */
export function getModalVolumeName(state: unknown): string | null {
  if (!state || typeof state !== "object") {
    return null;
  }
  if ((state as { type?: unknown }).type !== "modal") {
    return null;
  }
  const volumeName = (state as { volumeName?: unknown }).volumeName;
  return hasNonEmptyString(volumeName) ? volumeName : null;
}

export function hasResumableSandboxState(state: unknown): boolean {
  return getResumableSandboxName(state) !== null;
}

export function hasPausedSandboxState(state: unknown): boolean {
  return hasResumableSandboxState(state) && !hasRuntimeSandboxState(state);
}

/**
 * Type guard to check if a sandbox is active and ready to accept operations.
 */
export function isSandboxActive(
  state: SandboxState | null | undefined,
): state is SandboxState {
  if (!state) return false;

  const expiresAt = getSandboxExpiresAt(state);
  if (expiresAt === undefined) {
    return false;
  }

  if (Date.now() >= expiresAt - SANDBOX_EXPIRES_BUFFER_MS) {
    return false;
  }

  return hasRuntimeState(state);
}

/**
 * Check if we can perform operations on a live sandbox session (stop, extend, etc.).
 */
export function canOperateOnSandbox(
  state: SandboxState | null | undefined,
): state is SandboxState {
  if (!state) return false;
  return hasRuntimeState(state);
}

/**
 * Check if an unknown value represents sandbox state with live runtime data.
 */
export function hasRuntimeSandboxState(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;

  const expiresAt = getSandboxExpiresAt(state);
  if (expiresAt === undefined) {
    return false;
  }

  return hasResumableSandboxState(state);
}

export function isSandboxNotFoundError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("status code 404") ||
    normalized.includes("sandbox not found") ||
    // Modal's first-party SDK throws a bare `NotFoundError` whose message
    // names the resource id, e.g. "Sandbox sb-... not found".
    normalized.includes("notfounderror")
  );
}

/**
 * Check if an error message indicates the sandbox VM is permanently unavailable.
 *
 * Deliberately not vendor-branded: Modal's SDK failures are matched by
 * their documented error messages, so every error flows through the same
 * clear-state-and-reprovision path with no `type === "..."` branch.
 */
export function isSandboxUnavailableError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("expected a stream of command data") ||
    normalized.includes("status code 410") ||
    normalized.includes("status code 404") ||
    normalized.includes("sandbox is stopped") ||
    normalized.includes("sandbox not found") ||
    normalized.includes("sandbox probe failed") ||
    // Aligns with packages/sandbox's isSnapshotResumeUnavailableError
    // (found 2026-08-30): a 400 "Cannot resume sandbox: no snapshot
    // available" means the stored snapshotId is dead, so callers should
    // clear the poisoned state instead of retrying it forever.
    (normalized.includes("status code 400") &&
      normalized.includes("resume") &&
      normalized.includes("snapshot")) ||
    // Modal's spellings for a sandbox that is no longer usable: the
    // container was reaped (its 24h cap or idle timeout elapsed) or it
    // never existed. Both mean "provision a fresh one on the same
    // volume", which is Modal's normal re-provision path.
    normalized.includes("sandbox is not running") ||
    normalized.includes("sandbox_timed_out") ||
    normalized.includes("has already finished") ||
    normalized.includes("sandbox has been terminated")
  );
}

function hasRuntimeState(state: SandboxState): boolean {
  const expiresAt = getSandboxExpiresAt(state);
  if (expiresAt === undefined) {
    return false;
  }

  return hasResumableSandboxState(state);
}

/**
 * Clear sandbox runtime state while preserving durable resume state when available.
 *
 * For Modal the "durable resume state" is the Volume: dropping it would
 * orphan the session's workspace, so it is carried through even on a hard
 * 404 (which would otherwise lose the resume handle).
 */
export function clearSandboxState(
  state: SandboxState | null | undefined,
): SandboxState | null {
  if (!state) return null;

  // Only Modal has durable resume state to preserve; a local sandbox
  // has none, so it clears down to its bare discriminator.
  const volumeName = getModalVolumeName(state);
  if (volumeName) {
    return {
      type: state.type,
      volumeName,
      ...((state as ModalSandboxState).source
        ? { source: (state as ModalSandboxState).source }
        : {}),
    } as SandboxState;
  }

  return { type: state.type } as SandboxState;
}

/**
 * Clear both runtime state and any saved resume handle.
 */
export function clearSandboxResumeState(
  state: SandboxState | null | undefined,
): SandboxState | null {
  if (!state) return null;

  return { type: state.type } as SandboxState;
}

/**
 * Clear sandbox state after an unavailable-sandbox error.
 * Hard 404s wipe the saved resume handle; other unavailable errors preserve it.
 */
export function clearUnavailableSandboxState(
  state: SandboxState | null | undefined,
  message: string,
): SandboxState | null {
  return isSandboxNotFoundError(message)
    ? clearSandboxResumeState(state)
    : clearSandboxState(state);
}
