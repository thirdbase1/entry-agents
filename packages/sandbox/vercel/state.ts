import type { Source } from "../types.ts";

/**
 * State configuration for creating, reconnecting, or restoring the current cloud sandbox provider.
 * Used with the unified `connectSandbox()` API.
 */
export interface VercelState {
  /** Where to clone from (omit for empty sandbox or when reconnecting/restoring) */
  source?: Source;
  /** Stable Vercel sandbox identity used to locate the current ephemeral session. */
  sandboxName?: string;
  /**
   * Whether filesystem state survives a stopped session.
   * Entry intentionally uses false: a stopped session has no workspace to resume.
   */
  persistent?: boolean;
  /**
   * Legacy runtime sandbox ID from the stable SDK.
   * Kept only as a compatibility fallback during rollout.
   */
  sandboxId?: string;
  /** Snapshot ID used only for legacy restore/migration flows */
  snapshotId?: string;
  /** Timestamp (ms) when the current runtime session expires */
  expiresAt?: number;
}
