import type { BoatState } from "./boat/state.ts";
import type { LocalState } from "./local/state.ts";
import type { VercelState } from "./vercel/state.ts";

/**
 * Unified sandbox state type. Use the `type` discriminator to determine
 * which sandbox implementation to use. Persisted verbatim in
 * `sessions.sandbox_state` (jsonb), so the discriminator is the durable
 * record of which provider owns a session.
 *
 * "vercel" -- remote Vercel Sandbox container.
 *
 * "boat" -- remote Boat persistent Linux VM (docs.boat.dev).
 *
 * "local" -- plain local directory + child_process, no remote
 * provisioning. Only used by local dev/test tooling and the harness
 * benchmark runner (apps/web/scripts/run-benchmarks.ts) -- never for
 * real user sessions. See local/state.ts.
 */
export type SandboxState =
  | ({ type: "vercel" } & VercelState)
  | ({ type: "boat" } & BoatState)
  | ({ type: "local" } & LocalState);
