import type { Sandbox, SandboxHooks } from "./interface.ts";
import type { SandboxStatus } from "./types.ts";
import { connectVercel } from "./vercel/connect.ts";
import type { VercelState } from "./vercel/state.ts";
import { connectLocal } from "./local/sandbox.ts";
import type { LocalState } from "./local/state.ts";

// Re-export SandboxStatus from types for convenience
export type { SandboxStatus };

/**
 * Unified sandbox state type. Use the `type` discriminator to determine
 * which sandbox implementation to use.
 *
 * "vercel" -- real remote Vercel Sandbox container. Used for every real
 * user chat session (see apps/web/app/workflows/chat.ts).
 *
 * "local" -- plain local directory + child_process, no remote
 * provisioning. Only used by local dev/test tooling and the harness
 * benchmark runner (apps/web/scripts/run-benchmarks.ts) -- never for
 * real user sessions. See local/state.ts.
 */
export type SandboxState =
  | ({ type: "vercel" } & VercelState)
  | ({ type: "local" } & LocalState);

/**
 * Base connect options for all sandbox types.
 */
export interface ConnectOptions {
  /** Environment variables available to sandbox commands */
  env?: Record<string, string>;
  /** GitHub token used only during setup clone/fetch, then cleared */
  githubToken?: string;
  /** Git user for commits */
  gitUser?: { name: string; email: string };
  /** Lifecycle hooks */
  hooks?: SandboxHooks;
  /** Timeout in milliseconds for sandboxes (default: 300,000 = 5 minutes) */
  timeout?: number;
  /** Number of vCPUs for new sandboxes */
  vcpus?: number;
  /** Ports to expose from the sandbox for dev server preview URLs */
  ports?: number[];
  /** Snapshot ID used as the base image for new sandboxes */
  baseSnapshotId?: string;
  /** Whether to resume a stopped persistent sandbox session */
  resume?: boolean;
  /** Whether to create the named sandbox when it does not already exist */
  createIfMissing?: boolean;
  /** Whether new sandboxes should persist filesystem state between sessions */
  persistent?: boolean;
  /** Default expiration for automatic persistent-sandbox snapshots */
  snapshotExpiration?: number;
  /**
   * Skip git init in an empty workspace (e.g. when refreshing a Vercel base snapshot).
   */
  skipGitWorkspaceBootstrap?: boolean;
}

/**
 * Configuration for connecting to a sandbox.
 */
export type SandboxConnectConfig = {
  state: SandboxState;
  options?: ConnectOptions;
};

function isLocalState(
  state: SandboxState,
): state is { type: "local" } & LocalState {
  return state.type === "local";
}

/**
 * Connect to a sandbox based on the provided configuration.
 */
export async function connectSandbox(
  configOrState: SandboxConnectConfig | SandboxState,
  legacyOptions?: ConnectOptions,
): Promise<Sandbox> {
  const isNewApi =
    typeof configOrState === "object" &&
    "state" in configOrState &&
    typeof configOrState.state === "object" &&
    "type" in configOrState.state;

  const state = isNewApi
    ? (configOrState as SandboxConnectConfig).state
    : (configOrState as SandboxState);
  const options = isNewApi
    ? (configOrState as SandboxConnectConfig).options
    : legacyOptions;

  if (isLocalState(state)) {
    return connectLocal(state, options);
  }

  return connectVercel(state, options);
}
