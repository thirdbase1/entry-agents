import type { Source } from "../types.ts";

/**
 * Persisted state for a Boat sandbox (docs.boat.dev).
 *
 * Deliberately reuses the `sandboxId` field name rather than Vercel's
 * `sandboxName`: Boat's identity is its `bx_*` id, there is no
 * caller-chosen name required to reconnect, and the shared
 * `getResumableSandboxName()` helper already falls back from
 * `sandboxName` to `sandboxId`, so app-level resume/hibernate logic works
 * unchanged for both providers.
 */
export interface BoatState {
  /** Where to clone from (omit for an empty workspace or when reconnecting) */
  source?: Source;
  /** Boat sandbox id, e.g. `bx_f7k2q9hd`. The durable resume handle. */
  sandboxId?: string;
  /**
   * Subdomain Boat assigns the sandbox; used to derive hosted preview
   * URLs (`https://<subdomain>-<port>.on.boat.dev`). Recovered from
   * `GET /sandboxes/{id}` when absent from a persisted row.
   */
  subdomain?: string;
  /** Timestamp (ms) when the sandbox auto-stops (`ttlSeconds` deadline). */
  expiresAt?: number;
  /** Latest completed snapshot id known for this sandbox. */
  snapshotId?: string;
}
