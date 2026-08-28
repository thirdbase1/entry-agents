import type { SandboxHooks } from "../interface.ts";

export interface VercelSandboxConfig {
  /**
   * Optional persistent sandbox name.
   * When provided, repeated creates are expected to target the same durable sandbox.
   */
  name?: string;
  /**
   * Optional GitHub repository source to clone into the sandbox.
   * If not provided, the sandbox starts empty.
   */
  source?: {
    /** GitHub repository URL (e.g., "https://github.com/owner/repo") */
    url: string;
    /** Branch to clone (defaults to "main") */
    branch?: string;
    /** Deprecated: do not embed GitHub tokens in sandbox remotes. */
    token?: string;
    /**
     * Create and checkout a new branch after cloning.
     * Useful for isolating agent changes from the main branch.
     */
    newBranch?: string;
  };
  /**
   * Optional snapshot ID to restore this sandbox from.
   * Used only for legacy snapshot-backed session migration.
   */
  restoreSnapshotId?: string;
  /**
   * Git user configuration for commits.
   * Required if you want the agent to make commits.
   */
  gitUser?: {
    /** Name for git commits (e.g., "AI Agent") */
    name: string;
    /** Email for git commits (e.g., "agent@example.com") */
    email: string;
  };
  /**
   * Environment variables to make available to all commands in the sandbox.
   * Useful for API keys and other secrets that must exist inside the sandbox.
   */
  env?: Record<string, string>;
  /** GitHub token used only during setup clone/fetch, then cleared. */
  githubToken?: string;
  /**
   * Number of vCPUs (1-8). Each vCPU provides 2048 MB of memory.
   * @default 4
   */
  vcpus?: number;
  /**
   * Sandbox timeout in milliseconds.
   * @default 300_000 (5 minutes)
   */
  timeout?: number;
  /**
   * Runtime environment.
   * @default "node22"
   */
  runtime?: "node22" | "node24" | "python3.13";
  /**
   * Ports to expose from the sandbox.
   */
  ports?: number[];
  /**
   * Optional snapshot ID to use as the base image for new sandboxes.
   * When provided, the sandbox is created from this snapshot first.
   */
  baseSnapshotId?: string;
  /**
   * Whether the sandbox should automatically persist filesystem state between sessions.
   * @default true
   */
  persistent?: boolean;
  /**
   * Default expiration for automatically created snapshots in milliseconds.
   * Use `0` to retain snapshots indefinitely.
   */
  snapshotExpiration?: number;
  /**
   * Retention policy that keeps only the N most recent auto-snapshots of
   * this sandbox, deleting older ones immediately as new ones are created.
   * Re-enabled 2026-08-28 alongside flipping `persistent` back to `true`
   * by default: this is the correct fix for the unbounded Snapshot Storage
   * growth that caused the 2026-08-25 persistent-default-to-false flip
   * (every stop created a brand new snapshot without ever cleaning up the
   * prior one for that same session -- see docs/agents/lessons-learned.md,
   * incidents 2026-08-18 through 2026-08-24). `{ count: 1, deleteEvicted:
   * true }` caps worst case storage at one live snapshot per active named
   * sandbox instead of accumulating forever, while keeping real
   * resume-from-stop working -- unlike `persistent: false`, which discards
   * the filesystem entirely on stop and can never resume it (confirmed via
   * Vercel's own docs: "Non-persistent: Cannot be resumed; create a new
   * sandbox").
   * @default { count: 1, deleteEvicted: true } when persistent
   */
  keepLastSnapshots?: {
    count: number;
    expiration?: number;
    deleteEvicted?: boolean;
  };
  /**
   * When true, do not run `git init` or an initial empty commit in the workspace.
   * Use when building a new base snapshot so `/vercel/sandbox` stays empty for a
   * later `git clone ... .` (a leftover `.git` breaks clone into that directory).
   */
  skipGitWorkspaceBootstrap?: boolean;
  /**
   * Lifecycle hooks for setup and teardown.
   * afterStart is called after the sandbox is created and configured.
   * beforeStop is called before the sandbox is stopped.
   */
  hooks?: SandboxHooks;
}

/**
 * Configuration for reconnecting to an existing persistent sandbox.
 */
export interface VercelSandboxConnectConfig {
  /** The persistent sandbox name to reconnect to */
  sandboxName: string;
  /** Environment variables to make available to commands */
  env?: Record<string, string>;
  /** GitHub token used only during setup clone/fetch, then cleared. */
  githubToken?: string;
  /** Lifecycle hooks for setup and teardown */
  hooks?: SandboxHooks;
  /**
   * Remaining timeout in milliseconds for the current session.
   * When omitted, it is derived from the live session metadata when possible.
   */
  remainingTimeout?: number;
  /** Ports that were declared at creation time (for preview URL display) */
  ports?: number[];
  /** Whether a stopped sandbox should be explicitly resumed */
  resume?: boolean;
}
