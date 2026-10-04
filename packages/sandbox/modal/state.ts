/**
 * Modal Sandbox state.
 *
 * Modal sandboxes are gVisor-isolated containers that boot in seconds.
 * The workspace lives on a Modal **Volume** (a persistent distributed
 * filesystem mounted into the sandbox) rather than on the sandbox's own
 * root filesystem, which is why this state carries a `volumeName` and
 * deliberately has NO snapshot/restore field: with the workspace on a
 * volume there is nothing to migrate across sandbox lifetimes.
 *
 * `sandboxId` is the handle for a *running* sandbox -- Modal's
 * `sandboxes.fromId()` reconnects to one that is still alive, and a
 * missing/terminated id is the signal to provision a fresh sandbox that
 * remounts the same volume (see connect.ts).
 */

/** Attachable workspace storage that outlives an individual sandbox. */
export interface ModalVolumeState {
  /** Modal Volume name (stable across sandbox lifetimes). */
  name: string;
}

export interface ModalState {
  /**
   * Where to clone from (omit for an empty workspace).
   * Kept provider-neutral so the web layer keeps working unchanged.
   */
  source?: import("../types.ts").Source;
  /**
   * Handle for a currently-running sandbox, when we have one.
   * Absent (or stale) means "provision a fresh sandbox on the volume".
   */
  sandboxId?: string;
  /**
   * Persistent workspace volume. When set, the workspace survives
   * sandbox expiry and migration is a no-op -- a new sandbox simply
   * remounts it.
   */
  volumeName?: string;
  /** Timestamp (ms) when the current sandbox session expires. */
  expiresAt?: number;
}
