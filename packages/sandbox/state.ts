import type { LocalState } from "./local/state.ts";
import type { ModalState } from "./modal/state.ts";
import type { BoxdState } from "./boxd/state.ts";

/**
 * Unified sandbox state type. Use the `type` discriminator to determine
 * which sandbox implementation to use. Persisted verbatim in
 * `sessions.sandbox_state` (jsonb), so the discriminator is the durable
 * record of which provider owns a session.
 *
 * "modal" -- remote Modal sandbox (gVisor container) with the workspace
 * on a persistent Modal Volume. See modal/state.ts. This is the default
 * provider for every new session.
 *
 * "local" -- plain local directory + child_process, no remote
 * provisioning. Only used by local dev/test tooling and the harness
 * benchmark runner (apps/web/scripts/run-benchmarks.ts) -- never for
 * real user sessions. See local/state.ts.
 */
export type SandboxState =
  | ({ type: "boxd" } & BoxdState)
  | ({ type: "modal" } & ModalState)
  | ({ type: "local" } & LocalState);
