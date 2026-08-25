import type { Dirent } from "fs";

/**
 * The type of sandbox environment.
 */
export type SandboxType = "cloud";

/**
 * Result of a successful snapshot operation.
 * Uses native Vercel snapshot IDs instead of blob URLs.
 */
export interface SnapshotResult {
  /** Native Vercel snapshot ID */
  snapshotId: string;
}

/**
 * Lifecycle hook that receives the sandbox instance.
 * Use these to run arbitrary setup or teardown code.
 */
export type SandboxHook = (sandbox: Sandbox) => Promise<void>;

/**
 * Configuration for sandbox lifecycle hooks.
 */
export interface SandboxHooks {
  /**
   * Called after the sandbox starts and is ready.
   * Use for setup tasks like configuring credentials, installing dependencies, etc.
   */
  afterStart?: SandboxHook;

  /**
   * Called before the sandbox stops.
   * Use for teardown tasks like committing uncommitted changes, cleanup, etc.
   */
  beforeStop?: SandboxHook;

  /**
   * Called when the sandbox is about to timeout (before beforeStop).
   * Use to differentiate timeout-triggered stops from manual stops.
   */
  onTimeout?: SandboxHook;

  /**
   * Called after timeout is successfully extended.
   * @param sandbox - The sandbox instance
   * @param additionalMs - How much time was added
   */
  onTimeoutExtended?: (sandbox: Sandbox, additionalMs: number) => Promise<void>;

  /**
   * Called right after a non-detached command starts, before it's
   * awaited to completion. Lets the caller persist {cmdId, command, cwd}
   * somewhere durable (e.g. the session record in the DB) so an
   * external process -- like the sandbox-lifecycle workflow deciding to
   * migrate this session to a fresh sandbox near the session's max
   * duration -- can find and kill this exact command by id, even though
   * it started in a totally different process invocation.
   */
  onCommandStart?: (info: ActiveCommandInfo) => Promise<void>;

  /**
   * Called once a command that previously fired onCommandStart finishes
   * (success, failure, or killed) so the caller can clear the
   * durably-persisted active-command record.
   */
  onCommandEnd?: (cmdId: string) => Promise<void>;
}

/**
 * Metadata for a currently-running command, durable enough to persist
 * outside the process that started it and use to kill + later re-issue
 * the same command elsewhere.
 */
export interface ActiveCommandInfo {
  cmdId: string;
  command: string;
  cwd: string;
  startedAt: number;
}

/**
 * File stats returned by sandbox.stat()
 * Mirrors the subset of fs.Stats used by the tools
 */
export interface SandboxStats {
  isDirectory(): boolean;
  isFile(): boolean;
  size: number;
  mtimeMs: number;
}

/**
 * Result of shell command execution
 */
export interface ExecResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /**
   * True when this command was force-killed by killCommand() (e.g. for a
   * sandbox migration) rather than failing/timing out on its own. Callers
   * that see this should NOT treat it as a real tool failure -- the
   * command's caller is expected to retry it once the migration finishes.
   */
  killedExternally?: boolean;
}

/**
 * Sandbox interface for file system and shell operations.
 */
export interface Sandbox {
  /**
   * Identifier for the sandbox implementation type.
   * Used to conditionally adjust agent behavior.
   */
  readonly type: SandboxType;

  /**
   * The working directory for this sandbox.
   */
  readonly workingDirectory: string;

  /**
   * Environment variables available to commands in the sandbox.
   */
  readonly env?: Record<string, string>;

  /**
   * The current git branch in the sandbox (if applicable).
   */
  readonly currentBranch?: string;

  /**
   * Lifecycle hooks for this sandbox.
   */
  readonly hooks?: SandboxHooks;

  /**
   * Environment-specific details for the agent system prompt.
   */
  readonly environmentDetails?: string;

  /**
   * The base host/domain for this sandbox.
   */
  readonly host?: string;

  /**
   * Timestamp (ms since epoch) when this sandbox will be proactively stopped.
   */
  readonly expiresAt?: number;

  /**
   * The initial configured proactive timeout duration in milliseconds.
   */
  readonly timeout?: number;

  readFile(path: string, encoding: "utf-8"): Promise<string>;
  readFileBuffer(path: string): Promise<Buffer>;
  writeFile(path: string, content: string, encoding: "utf-8"): Promise<void>;
  /**
   * Write raw binary content (e.g. a decoded image) to a file in the
   * sandbox. Symmetric with readFileBuffer -- writeFile is text-only
   * (it always encodes `content` as UTF-8), so binary payloads must go
   * through this method instead of being smuggled through writeFile as
   * a base64 *string* (which would just write the literal base64 text).
   */
  writeFileBuffer(path: string, content: Buffer): Promise<void>;
  stat(path: string): Promise<SandboxStats>;
  access(path: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult>;

  /**
   * Execute a shell command in detached mode (returns immediately).
   */
  execDetached?(command: string, cwd: string): Promise<{ commandId: string }>;

  /**
   * Temporarily update GitHub credential brokering for trusted broker work.
   * Callers must clear the token as soon as the trusted operation completes.
   */
  setGitHubAuthToken?(token?: string): Promise<void>;

  /**
   * Temporarily update Vercel CLI credential brokering for trusted broker
   * work (same network-egress-layer injection as setGitHubAuthToken --
   * the real token never enters the sandbox's process env, filesystem,
   * or command history). Callers must clear the token as soon as the
   * trusted operation completes.
   */
  setVercelAuthToken?(token?: string): Promise<void>;

  /**
   * Get the public URL for an exposed port.
   */
  domain?(port: number): string;

  /**
   * Stop and clean up the sandbox.
   */
  stop(): Promise<void>;

  /**
   * Extend the sandbox timeout by the specified duration.
   */
  extendTimeout?(additionalMs: number): Promise<{ expiresAt: number }>;

  /**
   * Force-kill a running command by id, from any process -- doesn't
   * require holding the original Command object, only the id persisted
   * via the onCommandStart hook. Used by the sandbox-migration flow to
   * stop an in-flight tool call before packaging up the workspace.
   */
  killCommand?(cmdId: string): Promise<void>;

  /**
   * Package the current workspace into a transferable payload (git
   * bundle + uncommitted diff + untracked files when it's a git repo,
   * otherwise a full directory tar minus regenerable junk) so it can be
   * restored into a brand-new sandbox via restoreWorkspacePayload().
   */
  packWorkspacePayload?(): Promise<import("./migrate.ts").WorkspacePayload>;

  /**
   * Restore a payload produced by packWorkspacePayload() into this
   * (fresh) sandbox's workspace.
   */
  restoreWorkspacePayload?(
    payload: import("./migrate.ts").WorkspacePayload,
  ): Promise<void>;

  /**
   * Create a native Vercel snapshot of the sandbox filesystem.
   */
  snapshot?(): Promise<SnapshotResult>;

  /**
   * Get the current state of the sandbox for persistence/restoration.
   */
  getState?(): unknown;
}
