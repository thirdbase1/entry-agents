import type { Dirent } from "node:fs";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
  SnapshotResult,
} from "../interface.ts";
import type { WorkspacePayload } from "../migrate.ts";
import { packWorkspacePayload, restoreWorkspacePayload } from "../migrate.ts";
import type { Source } from "../types.ts";
import {
  BOAT_MAX_COMMAND_TIMEOUT_SECONDS,
  BOAT_MAX_TTL_SECONDS,
  BOAT_MIN_COMMAND_TIMEOUT_SECONDS,
  boatRequest,
  type BoatCommandResult,
  type BoatFileReadResponse,
  type BoatFileWriteResponse,
  type BoatHostResponse,
  type BoatSandboxRecord,
} from "./client.ts";
import { BOAT_DEFAULT_WORKING_DIRECTORY } from "./bootstrap.ts";
import { shellQuote } from "./shell.ts";
import type { BoatState } from "./state.ts";

export interface BoatSandboxConnectOptions {
  env?: Record<string, string>;
  hooks?: SandboxHooks;
  /** Requested sandbox lifetime in ms. Mapped to Boat's `ttlSeconds`. */
  timeout?: number;
  /** Ports to expose on public HTTPS URLs (registered best-effort). */
  ports?: number[];
  /** Machine size. Entry always creates Boat's `default` (4 vCPU / 8 GB). */
  machineType?: "small" | "default" | "large" | "xlarge";
  /** Git identity applied to commits made in the workspace. */
  gitUser?: { name: string; email: string };
  /** Absolute working directory override (defaults to /home/user/workspace). */
  workingDirectory?: string;
  /** Whether to create the sandbox when a persisted id no longer exists. */
  createIfMissing?: boolean;
  /** Skip git init in an empty workspace (mirrors the Vercel option). */
  skipGitWorkspaceBootstrap?: boolean;
}

const READY_STATES = new Set(["ready", "idle", "running"]);
const ARCHIVED_STATES = new Set(["archived"]);

/** Boat's 1-600s synchronous command window, clamped from a ms timeout. */
function toBoatTimeoutSeconds(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return BOAT_MIN_COMMAND_TIMEOUT_SECONDS;
  }

  return Math.min(
    BOAT_MAX_COMMAND_TIMEOUT_SECONDS,
    Math.max(BOAT_MIN_COMMAND_TIMEOUT_SECONDS, Math.ceil(timeoutMs / 1000)),
  );
}

function parseTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Derive the label Boat serves hosted routes from. `GET /sandboxes/{id}`
 * returns `url` (the sandbox's base address); the per-port hostname is
 * `https://<label>-<port>.on.boat.dev`.
 */
function extractSubdomain(record: BoatSandboxRecord): string | undefined {
  if (record.subdomain && record.subdomain.length > 0) {
    return record.subdomain;
  }

  if (record.url) {
    try {
      const hostname = new URL(record.url).hostname;
      const label = hostname.split(".")[0];
      if (label && label.length > 0) {
        // Strip a trailing `-{port}` should the base url already be a
        // hosted-port address.
        return label.replace(/-\d+$/, "");
      }
    } catch {
      // Not an absolute URL -- nothing reliable to extract.
    }
  }

  return undefined;
}

/**
 * Sandbox implementation backed by a Boat persistent Linux VM
 * (docs.boat.dev), implementing the same `Sandbox` interface the Vercel
 * and local implementations do. Agent tools only ever go through that
 * interface, so read/write/bash/grep/glob run against whichever provider
 * the user selected, with no provider-specific code in the tools.
 *
 * Capability differences from Vercel (see ../registry-types.ts):
 * - the filesystem persists across stop/resume, so this provider does not
 *   need workspace migration;
 * - there is no fs-metadata API, so stat/access/mkdir/readdir are emulated
 *   over the documented command endpoint;
 * - `ttlSeconds` replaces Vercel's hard 45-minute cap;
 * - credential brokering (`setGitHubAuthToken`/`setVercelAuthToken`) is not
 *   offered -- Boat injects credentials through environments.
 */
export class BoatSandbox implements Sandbox {
  readonly type = "cloud" as const;
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
  readonly hooks?: SandboxHooks;
  readonly timeout?: number;

  private readonly sandboxId: string;
  private readonly subdomain?: string;
  private readonly source?: Source;
  private readonly snapshotId?: string;
  private readonly hostedPorts = new Map<number, string>();
  private currentState: string;
  /**
   * Current git branch of the workspace.
   *
   * Populated by `refreshWorkspaceMetadata()` right after the workspace is
   * bootstrapped. Deliberately present rather than left undefined: this
   * value is returned from a `"use step"` and passed back in as step
   * arguments, and the Workflow SDK refuses to serialize `undefined`
   * across those boundaries.
   */
  currentBranch?: string;
  /**
   * Auto-stop deadline (ms). Public because it is part of the shared
   * `Sandbox` contract (`expiresAt?`); `extendTimeout` updates it in place.
   */
  expiresAt?: number;

  constructor(
    record: BoatSandboxRecord,
    options?: {
      workingDirectory?: string;
      source?: Source;
      snapshotId?: string;
      hostedPorts?: Map<number, string>;
      env?: Record<string, string>;
      hooks?: SandboxHooks;
      timeout?: number;
    },
  ) {
    this.sandboxId = record.id;
    this.subdomain = extractSubdomain(record);
    this.currentState = record.state;
    this.expiresAt = parseTimestamp(record.archiveAfter);
    this.workingDirectory =
      options?.workingDirectory ?? BOAT_DEFAULT_WORKING_DIRECTORY;
    this.env = options?.env;
    this.hooks = options?.hooks;
    this.timeout = options?.timeout;
    this.source = options?.source;
    this.snapshotId = options?.snapshotId;

    if (options?.hostedPorts) {
      for (const [port, url] of options.hostedPorts) {
        this.hostedPorts.set(port, url);
      }
    }
  }

  get id(): string {
    return this.sandboxId;
  }

  /**
   * Environment description handed to the agent's system prompt. A getter
   * (never `undefined`) so it always serializes cleanly across a
   * workflow-step boundary, matching VercelSandbox's contract.
   */
  get environmentDetails(): string {
    const lines = [
      `Sandbox: Boat Linux VM (Ubuntu 24.04, 4 vCPU / 8 GB), working directory ${this.workingDirectory}`,
    ];

    for (const [port, url] of this.hostedPorts) {
      if (url) lines.push(`  - Port ${port}: ${url}`);
    }

    return lines.join("\n");
  }

  /**
   * Fill in per-workspace metadata after the workspace exists. Called by
   * `connectBoat` once the clone/bootstrap step has finished.
   */
  async refreshWorkspaceMetadata(): Promise<void> {
    if (this.currentBranch !== undefined) return;

    try {
      const result = await this.exec(
        "git rev-parse --abbrev-ref HEAD",
        this.workingDirectory,
        15_000,
      );

      if (result.success) {
        const branch = result.stdout.trim();
        // Detached HEAD (a fresh `git init` repo with no commits) reports
        // "HEAD" -- that is not a branch name worth surfacing to the agent.
        if (branch && branch !== "HEAD") {
          this.currentBranch = branch;
        }
      }
    } catch {
      // Metadata is cosmetic for the system prompt; never fail a connect
      // because a git probe could not run.
    }
  }

  get state(): string {
    return this.currentState;
  }

  // ---------------------------------------------------------------- files

  private resolvePath(path: string): string {
    if (path.startsWith("/home/user") || path.startsWith("/tmp")) {
      return path;
    }

    if (path.startsWith("/")) {
      // The Boat file API refuses anything outside /home/user and /tmp
      // (400 invalid_path). Fail loudly with that contract spelled out
      // rather than silently writing somewhere unexpected.
      throw new Error(
        `Boat sandbox file paths must live under /home/user or /tmp (received ${path})`,
      );
    }

    return `${this.workingDirectory}/${path}`;
  }

  async readFile(path: string): Promise<string> {
    const response = await boatRequest<BoatFileReadResponse>(
      `/sandboxes/${this.sandboxId}/files`,
      { query: { path: this.resolvePath(path), encoding: "utf8" } },
    );

    if (!response.success) {
      throw new Error(`Failed to read ${path} in Boat sandbox`);
    }
    return response.content;
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    const response = await boatRequest<BoatFileReadResponse>(
      `/sandboxes/${this.sandboxId}/files`,
      { query: { path: this.resolvePath(path), encoding: "base64" } },
    );

    if (!response.success) {
      throw new Error(`Failed to read ${path} in Boat sandbox`);
    }
    return Buffer.from(response.content, "base64");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await boatRequest<BoatFileWriteResponse>(
      `/sandboxes/${this.sandboxId}/files`,
      {
        method: "PUT",
        body: { path: this.resolvePath(path), content, encoding: "utf8" },
      },
    );
  }

  async writeFileBuffer(path: string, content: Buffer): Promise<void> {
    await boatRequest<BoatFileWriteResponse>(
      `/sandboxes/${this.sandboxId}/files`,
      {
        method: "PUT",
        body: {
          path: this.resolvePath(path),
          content: content.toString("base64"),
          encoding: "base64",
        },
      },
    );
  }

  /**
   * Boat has no filesystem-metadata endpoint, so metadata operations are
   * emulated through the documented command endpoint. A single `stat`
   * call covers type/size/mtime -- exactly the subset SandboxStats exposes.
   */
  async stat(path: string): Promise<SandboxStats> {
    const target = shellQuote(path);
    const result = await this.exec(
      `stat -c '%F|%s|%Y' -- ${target} 2>/dev/null || stat -f '%HT|%z|%m' -- ${target}`,
      this.workingDirectory,
      30_000,
    );

    if (!result.success) {
      throw new Error(
        `ENOENT: no such file or directory, stat '${path}'`,
      );
    }

    const [kind, size, mtime] = result.stdout.trim().split("|");
    const normalizedKind = (kind ?? "").toLowerCase();

    return {
      isDirectory: () => normalizedKind.includes("directory"),
      isFile: () =>
        normalizedKind.includes("regular") &&
        !normalizedKind.includes("directory"),
      size: Number(size ?? 0) || 0,
      mtimeMs: Number(mtime ?? 0) * 1000 || 0,
    };
  }

  async access(path: string): Promise<void> {
    const result = await this.exec(
      `test -e ${shellQuote(path)}`,
      this.workingDirectory,
      30_000,
    );

    if (!result.success) {
      throw new Error(`ENOENT: no such file or directory, access '${path}'`);
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const flag = options?.recursive === false ? "" : "-p ";
    const result = await this.exec(
      `mkdir ${flag}${shellQuote(path)}`,
      this.workingDirectory,
      30_000,
    );

    if (!result.success) {
      throw new Error(`Failed to create directory '${path}': ${result.stderr}`);
    }
  }

  /**
   * Emulated via `find -printf`, which reports the entry type directly so
   * no separate lstat round-trip is needed to build Dirent entries.
   */
  async readdir(
    path: string,
    _options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    const result = await this.exec(
      `find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -printf '%y|%f\\n' | sort`,
      this.workingDirectory,
      60_000,
    );

    if (!result.success) {
      throw new Error(
        `Failed to read directory '${path}': ${result.stderr || result.stdout}`,
      );
    }

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf("|");
        const kind = separator === -1 ? line : line.slice(0, separator);
        const name = separator === -1 ? "" : line.slice(separator + 1);
        return buildDirent(name, kind);
      })
      .filter((entry) => entry.name.length > 0) as unknown as Dirent[];
  }

  // ----------------------------------------------------------------- exec

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    // Note: no onCommandStart/onCommandEnd hooks fire here. Boat exposes
    // no endpoint to kill an in-flight synchronous command by id, so
    // recording one would create an active-command handle the lifecycle
    // code could never act on. Boat's capabilities therefore report
    // `killCommand: false` and workspace migration is disabled for it.
    let response: BoatCommandResult;
    try {
      response = await boatRequest<BoatCommandResult>(
        `/sandboxes/${this.sandboxId}/commands`,
        {
          method: "POST",
          body: {
            command,
            cwd,
            timeoutSeconds: toBoatTimeoutSeconds(timeoutMs),
            detached: false,
          },
          ...(options?.signal ? { signal: options.signal } : {}),
        },
      );
    } catch (error) {
      if (options?.signal?.aborted) {
        return {
          success: false,
          exitCode: null,
          stdout: "",
          stderr: "Command aborted",
          truncated: false,
        };
      }
      throw error;
    }

    return toExecResult(response);
  }

  async execDetached(
    command: string,
    cwd: string,
  ): Promise<{ commandId: string }> {
    const response = await boatRequest<BoatCommandResult>(
      `/sandboxes/${this.sandboxId}/commands`,
      { method: "POST", body: { command, cwd, detached: true } },
    );

    const processId = response.processId ?? response.pid;
    if (processId === undefined || processId === null) {
      throw new Error(
        `Boat did not return a process id for detached command: ${command}`,
      );
    }

    return { commandId: String(processId) };
  }

  // ------------------------------------------------------------ lifecycle

  async stop(): Promise<void> {
    if (ARCHIVED_STATES.has(this.currentState)) {
      return;
    }

    if (this.hooks?.beforeStop) {
      await this.hooks.beforeStop(this);
    }

    // Boat snapshots the disk as part of stop(); if that snapshot fails
    // the stop is refused and the sandbox keeps running. That is the
    // documented behaviour, so surface it rather than swallowing a
    // lost-work condition.
    await boatRequest(`/sandboxes/${this.sandboxId}/stop`, {
      method: "POST",
      body: {},
    });
    // The stop call completing means Boat has archived the machine (it
    // snapshots first and refuses the stop if that snapshot fails, which
    // would have thrown above). Recording `archived` here is what makes
    // stop() idempotent for repeated archive/hibernate callers.
    this.currentState = "archived";
  }

  /**
   * Extend the auto-stop deadline by `additionalMs` beyond whatever is
   * currently scheduled. Boat's `ttlSeconds` is a duration rather than an
   * absolute timestamp, so the new value is computed from the later of
   * "now" and the existing deadline, then capped at Boat's 30-day ceiling.
   */
  async extendTimeout(additionalMs: number): Promise<{ expiresAt: number }> {
    const base = Math.max(Date.now(), this.expiresAt ?? Date.now());
    const target = base + Math.max(0, additionalMs);
    const ttlSeconds = Math.min(
      BOAT_MAX_TTL_SECONDS,
      Math.max(1, Math.ceil((target - Date.now()) / 1000)),
    );

    await boatRequest(`/sandboxes/${this.sandboxId}`, {
      method: "PATCH",
      body: { ttlSeconds },
    });

    this.expiresAt = Date.now() + ttlSeconds * 1000;

    if (this.hooks?.onTimeoutExtended) {
      await this.hooks.onTimeoutExtended(this, additionalMs);
    }

    return { expiresAt: this.expiresAt };
  }

  /**
   * Snapshot semantics mirror VercelSandbox.snapshot(): capture the
   * filesystem and leave the sandbox stopped. On Boat, stopping *is* the
   * capture -- snapshots are taken continuously while running and a final
   * one is written on stop -- so this stops, then reads back the id.
   */
  async snapshot(): Promise<SnapshotResult> {
    if (!ARCHIVED_STATES.has(this.currentState)) {
      await this.stop();
    }

    const latest = await boatRequest<{
      snapshot: { id: string } | null;
    }>(`/sandboxes/${this.sandboxId}/snapshots/latest`);

    const snapshotId = latest?.snapshot?.id;
    if (!snapshotId) {
      throw new Error(
        `Boat produced no snapshot for sandbox ${this.sandboxId} after stop`,
      );
    }

    return { snapshotId };
  }

  /**
   * Public HTTPS URL for an in-sandbox port:
   * `https://<subdomain>-<port>.on.boat.dev`.
   */
  domain(port: number): string {
    const hosted = this.hostedPorts.get(port);
    if (hosted) return hosted;
    if (!this.subdomain) return "";
    return `https://${this.subdomain}-${port}.on.boat.dev`;
  }

  /**
   * Register a port with Boat's hosting layer and cache the exact URL.
   * Called from connect() so a preview URL already exists by the time the
   * dev-server/code-editor routes ask for it. Idempotent per port.
   */
  async hostPort(port: number, title?: string): Promise<string> {
    const response = await boatRequest<BoatHostResponse>(
      `/sandboxes/${this.sandboxId}/host`,
      {
        method: "POST",
        body: { port, ...(title ? { title } : {}), public: true },
      },
    );

    const url = response.url ?? this.domain(port);
    if (response.url) {
      this.hostedPorts.set(port, response.url);
    }
    return url;
  }

  // --------------------------------------------------------- workspace IO

  packWorkspacePayload(): Promise<WorkspacePayload> {
    return packWorkspacePayload(this);
  }

  restoreWorkspacePayload(payload: WorkspacePayload): Promise<void> {
    return restoreWorkspacePayload(this, payload);
  }

  getState(): BoatState & { type: "boat" } {
    return {
      type: "boat",
      sandboxId: this.sandboxId,
      ...(this.subdomain ? { subdomain: this.subdomain } : {}),
      ...(this.expiresAt ? { expiresAt: this.expiresAt } : {}),
      ...(this.snapshotId ? { snapshotId: this.snapshotId } : {}),
      ...(this.source ? { source: this.source } : {}),
    };
  }

  // Deliberately no setGitHubAuthToken / setVercelAuthToken / killCommand:
  // optional on the interface and unsupported by this provider. Callers
  // that need them check the provider's capabilities first, so the failure
  // mode is "feature unavailable" -- never "silently ran somewhere else".
}

function toExecResult(response: BoatCommandResult): ExecResult {
  const truncated = Boolean(
    response.stdoutTruncated || response.stderrTruncated,
  );
  const stderr = response.timedOut
    ? `${response.stderr ?? ""}\nCommand timed out`
    : (response.stderr ?? "");

  return {
    success: response.success && response.exitCode === 0,
    exitCode: response.exitCode ?? null,
    stdout: response.stdout ?? "",
    stderr,
    truncated,
  };
}

interface BoatDirentLike {
  name: string;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isDirectory(): boolean;
  isFIFO(): boolean;
  isFile(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
}

function buildDirent(name: string, kind: string): BoatDirentLike {
  return {
    name,
    isBlockDevice: () => kind === "b",
    isCharacterDevice: () => kind === "c",
    isDirectory: () => kind === "d",
    isFIFO: () => kind === "p",
    isFile: () => kind === "f",
    isSocket: () => kind === "s",
    isSymbolicLink: () => kind === "l",
  };
}

export function isBoatReadyState(state: string): boolean {
  return READY_STATES.has(state);
}

export function isBoatArchivedState(state: string): boolean {
  return ARCHIVED_STATES.has(state);
}
