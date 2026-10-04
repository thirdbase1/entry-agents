import type { Sandbox, SandboxHooks } from "./interface.ts";
import type { SandboxStatus, DriveMountConfig } from "./types.ts";
import { requireSandboxProvider } from "./registry.ts";
import type { SandboxState } from "./state.ts";

// Re-export SandboxStatus from types for convenience
export type { SandboxStatus };
export type { SandboxState } from "./state.ts";
export type { DriveMountConfig };

/**
 * Base connect options for all sandbox types.
 *
 * These are *advisory*: each provider interprets the subset it supports
 * and ignores the rest (Modal honours `drives`/`ports`/`timeout` and has
 * no snapshot-resume, the local adapter honours almost nothing). Callers
 * therefore pass one shape and stay provider-agnostic; anything
 * provider-specific is owned by the adapter, keyed off its capabilities in
 * registry-types.ts.
 */
export interface ConnectOptions {
  /** Environment variables available to sandbox commands */
  env?: Record<string, string>;
  /**
   * Extra filesystem roots the LocalSandbox may touch beyond its rootDir.
   * Provider-specific by design (only LocalSandbox honours it — see
   * LocalSandboxConnectOptions): remote providers ignore extra host roots.
   * Forwarded to the provider's own connect options by the local adapter.
   */
  allowedRoots?: string[];
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
  /**
   * Optional persistent drives. Honoured on BOTH paths: newly created
   * sandboxes get them via `create({ mounts })`, and re-connected ones
   * get them via `update({ mounts })`. Callers should pass this
   * unconditionally so an existing session that never acquired a drive
   * picks one up on its next connection. Ignored by providers whose
   * capabilities report `drives: false`.
   */
  drives?: DriveMountConfig;
  /** Whether to resume a stopped persistent sandbox session */
  resume?: boolean;
  /** Whether to create the named sandbox when it does not already exist */
  createIfMissing?: boolean;
  /** Whether new sandboxes should persist filesystem state between sessions */
  persistent?: boolean;
  /** Default expiration for automatic persistent-sandbox snapshots */
  snapshotExpiration?: number;
  /**
   * Skip git init in an empty workspace (e.g. when refreshing a base
   * snapshot).
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

/**
 * Connect to a sandbox. Dispatch is entirely registry-driven: the
 * `state.type` discriminator selects the provider, and an unregistered
 * type throws `UnsupportedSandboxProviderError` rather than falling back
 * to another provider.
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

  const provider = requireSandboxProvider(String(state.type));
  return provider.connect(state, options);
}
