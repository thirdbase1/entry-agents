import type { ModalClient, Volume } from "modal";
import type { Dirent } from "fs";
import type {
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
  SnapshotResult,
} from "../interface.ts";
import {
  MODAL_DEFAULT_CPU,
  MODAL_DEFAULT_IDLE_TIMEOUT_MS,
  MODAL_DEFAULT_IMAGE,
  MODAL_DEFAULT_MEMORY_MIB,
  MODAL_DEFAULT_TIMEOUT_MS,
  MODAL_WORKSPACE_MOUNT_PATH,
} from "./config.ts";
import {
  getModalApp,
  getModalImage,
  isModalSandboxGoneError,
} from "./client.ts";
import type { ModalState } from "./state.ts";

/** Modal's own `Sandbox` handle. Imported ONLY as a type. */
type ModalSdkSandbox = import("modal").Sandbox;

/** Modal caps exec output per stream; stay comfortably under it. */
const MAX_OUTPUT_LENGTH = 200_000;

/** Marker delimiting the PID echoed back by a started background command. */
const PID_MARKER = "__ENTRY_PID__:";

/**
 * How long readPid() waits for the marker line before giving up.
 *
 * The marker is printed before the real command runs, so it normally lands
 * in the first stream chunk (sub-second). The bound exists purely so a
 * wedged stream cannot hang a turn forever; on timeout execDetached simply
 * reports "no command id" and killCommand becomes a no-op.
 */
const READ_PID_TIMEOUT_MS = 10_000;

/**
 * Modal exposes no per-process kill RPC -- `ContainerProcess` only has
 * `wait()`, so a runaway `npm install` cannot be stopped from outside by
 * handle. Every command is therefore started through a shell wrapper that
 * prints its own PID first, and killCommand() signals that PID from inside
 * the sandbox. The PID becomes the command id Entry persists via
 * onCommandStart, so the migration flow can kill an in-flight command
 * from another process, and kill is still a single exec round-trip.
 */
export function pidFromStdout(stdout: string): string | undefined {
  // The colon is written literally (`echo "__ENTRY_PID__:$$"`), but Modal's
  // stream framing can strip it before the line reaches us -- observed live
  // as `__ENTRY_PID__4`. Matching the marker NAME and allowing an optional
  // separator keeps both spellings working, instead of silently returning
  // undefined for every detached command (which would make killCommand a
  // permanent no-op -- the exact bug this guards).
  const match = stdout.match(/__ENTRY_PID__\s*:?\s*(\d+)/);
  return match?.[1];
}

export interface ModalSandboxConfig {
  /** Modal client, already constructed (see client.ts). */
  client: ModalClient;
  /** Stable per-session sandbox name (unique within the App). */
  name?: string;
  /** Optional repo to clone into the workspace. */
  source?: { url: string; branch?: string; newBranch?: string };
  /** Environment variables available to every command. */
  env?: Record<string, string>;
  /** Git user for commits inside the workspace. */
  gitUser?: { name: string; email: string };
  /** Lifecycle hooks. */
  hooks?: SandboxHooks;
  /** Ports to expose as encrypted tunnels for dev-server preview URLs. */
  ports?: number[];
  /** Physical CPU cores to reserve. Defaults to the cheapest legal shape. */
  cpu?: number;
  /** Memory reservation in MiB. */
  memoryMiB?: number;
  /** Persistent workspace Volume to mount at the workspace path. */
  volume?: Volume;
  /** Skip `git init` (used when preparing a base image). */
  skipGitWorkspaceBootstrap?: boolean;
}

/**
 * Entry's Modal-backed `Sandbox`.
 *
 * The workspace lives on a mounted Modal Volume, so the filesystem
 * survives sandbox expiry: a fresh sandbox remounting the same volume
 * sees every byte the last one wrote. That is why this class implements
 * no snapshot-based migration -- there is nothing to carry across.
 */
export class ModalCloudSandbox implements Sandbox {
  readonly type = "cloud" as const;
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
  readonly hooks?: SandboxHooks;
  readonly name: string;
  /** Set by bootstrapWorkspace after the clone/checkout. */
  currentBranch?: string;

  private readonly client: ModalClient;
  private readonly sdk: ModalSdkSandbox;
  private readonly volumeName?: string;
  private readonly timeoutMs: number;
  private _expiresAt: number;
  private stopped = false;

  /** cmdIds killed via killCommand(); exec() reports killedExternally. */
  private readonly killedCommandIds = new Set<string>();

  /**
   * Resolved tunnel URLs, port -> https URL. Cached at creation because
   * `domain()` must answer synchronously (route handlers call it without
   * await) while `sandbox.tunnels()` is async.
   */
  private readonly tunnelUrls = new Map<number, string>();

  /**
   * Credential held between setGitHubAuthToken() and the trusted operation
   * the caller runs inside it. Applied to individual exec environments
   * only -- never written to the volume, never surfaced through `env` or
   * environmentDetails, so the raw access token never reaches the model.
   */
  private brokeredGitHubToken?: string;

  private constructor(params: {
    client: ModalClient;
    sdk: ModalSdkSandbox;
    name: string;
    workingDirectory: string;
    env?: Record<string, string>;
    hooks?: SandboxHooks;
    volumeName?: string;
    timeoutMs: number;
    tunnelUrls: Map<number, string>;
  }) {
    this.client = params.client;
    this.sdk = params.sdk;
    this.name = params.name;
    this.workingDirectory = params.workingDirectory;
    this.env = params.env;
    this.hooks = params.hooks;
    this.volumeName = params.volumeName;
    this.timeoutMs = params.timeoutMs;
    this.tunnelUrls = params.tunnelUrls;
    this._expiresAt = Date.now() + params.timeoutMs;
  }

  get expiresAt(): number | undefined {
    return this.stopped ? undefined : this._expiresAt;
  }

  /** Initial configured lifetime. Modal's documented ceiling is 24h. */
  get timeout(): number | undefined {
    return this.timeoutMs;
  }

  /**
   * Environment for one exec: sandbox-level env, any currently-brokered
   * GitHub credential, and git ownership safety (the workspace volume can
   * be owned by a different uid than the process git runs as, which
   * otherwise makes every git read fail with "dubious ownership").
   */
  private getCommandEnv(): Record<string, string> {
    return {
      ...this.env,
      ...(this.brokeredGitHubToken ? { GITHUB_TOKEN: this.brokeredGitHubToken } : {}),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
    };
  }

  /** Run one shell command to completion and collect its output. */
  private async runCommand(
    command: string,
    options: { timeoutMs?: number } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = await this.sdk.exec(["bash", "-c", command], {
      workdir: this.workingDirectory,
      env: this.getCommandEnv(),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    const stdout = await proc.stdout.readText();
    const stderr = await proc.stderr.readText();
    const exitCode = await proc.wait();
    return { exitCode, stdout, stderr };
  }

  /** Provision a new sandbox on the given volume. */
  static async create(config: ModalSandboxConfig): Promise<ModalCloudSandbox> {
    const app = await getModalApp(config.client);
    const image = getModalImage(config.client, MODAL_DEFAULT_IMAGE);

    const sdk = await config.client.sandboxes.create(app, image, {
      cpu: config.cpu ?? MODAL_DEFAULT_CPU,
      memoryMiB: config.memoryMiB ?? MODAL_DEFAULT_MEMORY_MIB,
      timeoutMs: MODAL_DEFAULT_TIMEOUT_MS,
      idleTimeoutMs: MODAL_DEFAULT_IDLE_TIMEOUT_MS,
      workdir: MODAL_WORKSPACE_MOUNT_PATH,
      ...(config.env ? { env: config.env } : {}),
      ...(config.ports?.length ? { encryptedPorts: config.ports } : {}),
      ...(config.name ? { name: config.name } : {}),
      ...(config.volume
        ? { volumes: { [MODAL_WORKSPACE_MOUNT_PATH]: config.volume } }
        : {}),
    });

    const tunnelUrls = await resolveTunnels(sdk, config.ports);

    const sandbox = new ModalCloudSandbox({
      client: config.client,
      sdk,
      name: config.name ?? sdk.sandboxId,
      workingDirectory: MODAL_WORKSPACE_MOUNT_PATH,
      ...(config.env ? { env: config.env } : {}),
      ...(config.hooks ? { hooks: config.hooks } : {}),
      ...(config.volume?.name ? { volumeName: config.volume.name } : {}),
      timeoutMs: MODAL_DEFAULT_TIMEOUT_MS,
      tunnelUrls,
    });

    await sandbox.bootstrapWorkspace(config);

    if (config.hooks?.afterStart) {
      await config.hooks.afterStart(sandbox);
    }

    return sandbox;
  }

  /**
   * Wrap an already-running sandbox handle.
   *
   * Used by connect() when `sandboxId` reattached successfully: the
   * workspace bootstrap is skipped entirely because the volume is already
   * mounted and populated.
   */
  static async reconnect(
    client: ModalClient,
    sdk: ModalSdkSandbox,
    config: Pick<ModalSandboxConfig, "name" | "volume" | "hooks" | "env">,
  ): Promise<ModalCloudSandbox> {
    const tunnelUrls = await resolveTunnels(sdk, undefined);
    const sandbox = new ModalCloudSandbox({
      client,
      sdk,
      name: config.name ?? sdk.sandboxId,
      workingDirectory: MODAL_WORKSPACE_MOUNT_PATH,
      ...(config.env ? { env: config.env } : {}),
      ...(config.hooks ? { hooks: config.hooks } : {}),
      ...(config.volume?.name ? { volumeName: config.volume.name } : {}),
      timeoutMs: MODAL_DEFAULT_TIMEOUT_MS,
      tunnelUrls,
    });

    if (config.hooks?.afterStart) {
      await config.hooks.afterStart(sandbox);
    }

    return sandbox;
  }

  /**
   * Prepare the workspace: clone the source, or stand up an empty repo.
   *
   * `git clone` refuses a non-empty destination, and a mounted Volume
   * that has been used before is exactly that, so the clone goes into a
   * scratch dir and is merged in when the workspace is not empty.
   */
  private async bootstrapWorkspace(config: ModalSandboxConfig): Promise<void> {
    if (config.source && !config.skipGitWorkspaceBootstrap) {
      const branch = config.source.branch
        ? ` --branch ${shellEscape(config.source.branch)}`
        : "";
      const clone = await this.runCommand(
        `if [ -z "$(ls -A ${MODAL_WORKSPACE_MOUNT_PATH})" ]; then ` +
          `git clone${branch} ${shellEscape(config.source.url)} ${MODAL_WORKSPACE_MOUNT_PATH}; ` +
          `else rm -rf /tmp/entry-clone && git clone${branch} ${shellEscape(config.source.url)} /tmp/entry-clone && ` +
          // `cp -a` is not safe here: the destination volume may already
          // hold .git objects that are IDENTICAL to the ones being copied
          // (same repo, re-cloned), and cp refuses "same file" hard enough
          // to exit non-zero. --no-clobber skips what is already there,
          // which is the correct merge semantic for a durable workspace.
          `cp -a --no-clobber /tmp/entry-clone/. ${MODAL_WORKSPACE_MOUNT_PATH}/ && rm -rf /tmp/entry-clone; fi`,
        { timeoutMs: 180_000 },
      );
      if (clone.exitCode !== 0) {
        throw new Error(
          `Failed to clone '${config.source.url}': ${clone.stderr.trim()}`,
        );
      }

      if (config.source.newBranch) {
        const checkout = await this.runCommand(
          `git checkout -b ${shellEscape(config.source.newBranch)}`,
        );
        if (checkout.exitCode !== 0) {
          throw new Error(
            `Failed to create branch '${config.source.newBranch}': ${checkout.stderr.trim()}`,
          );
        }
        this.currentBranch = config.source.newBranch;
      } else if (config.source.branch) {
        this.currentBranch = config.source.branch;
      }
    } else if (!config.skipGitWorkspaceBootstrap) {
      await this.runCommand(
        `test -d ${MODAL_WORKSPACE_MOUNT_PATH}/.git || git init ${MODAL_WORKSPACE_MOUNT_PATH}`,
      );
    }

    if (config.gitUser) {
      await this.runCommand(
        `git config user.name ${shellEscape(config.gitUser.name)} && ` +
          `git config user.email ${shellEscape(config.gitUser.email)}`,
      );
    }
  }

  async readFile(path: string, _encoding: "utf-8"): Promise<string> {
    const result = await this.runCommand(`cat ${shellEscape(path)}`);
    if (result.exitCode !== 0) {
      throw new Error(`ENOENT: no such file or directory, read '${path}'`);
    }
    return result.stdout;
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    // base64 over stdout: Modal's filesystem read path is capped for
    // large files, and argv cannot carry a big payload.
    const result = await this.runCommand(`base64 ${shellEscape(path)}`);
    if (result.exitCode !== 0) {
      throw new Error(`ENOENT: no such file or directory, read '${path}'`);
    }
    return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
  }

  async writeFile(path: string, content: string, _encoding: "utf-8"): Promise<void> {
    await this.writeFileBuffer(path, Buffer.from(content, "utf-8"));
  }

  async writeFileBuffer(path: string, content: Buffer): Promise<void> {
    // Payload travels over stdin (Modal's write stream), never argv, so
    // multi-megabyte files cannot blow past the command-length limit.
    const b64 = content.toString("base64");
    const proc = await this.sdk.exec(
      [
        "bash",
        "-c",
        `mkdir -p "$(dirname ${shellEscape(path)})" && base64 -d > ${shellEscape(path)}`,
      ],
      { workdir: this.workingDirectory, env: this.getCommandEnv() },
    );
    await proc.stdin.writeText(b64);
    await proc.stdin.close();
    const exitCode = await proc.wait();
    if (exitCode !== 0) {
      throw new Error(`Failed to write file (exit ${exitCode}): ${path}`);
    }
  }

  async stat(path: string): Promise<SandboxStats> {
    const result = await this.runCommand(
      `stat -c '%F\\t%s\\t%Y' ${shellEscape(path)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }
    const parts = result.stdout.trim().split("\t");
    const fileType = parts[0] ?? "";
    const isDir = fileType === "directory";
    return {
      isDirectory: () => isDir,
      isFile: () => !isDir,
      size: Number.parseInt(parts[1] ?? "0", 10) || 0,
      mtimeMs: (Number.parseInt(parts[2] ?? "0", 10) * 1000) || 0,
    };
  }

  async access(path: string): Promise<void> {
    const result = await this.runCommand(`test -e ${shellEscape(path)}`);
    if (result.exitCode !== 0) {
      throw new Error(`ENOENT: no such file or directory, access '${path}'`);
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const flags = options?.recursive ? "-p " : "";
    const result = await this.runCommand(`mkdir ${flags}${shellEscape(path)}`);
    if (result.exitCode !== 0) {
      const alreadyExists = options?.recursive && /File exists/i.test(result.stderr);
      if (!alreadyExists) {
        throw new Error(`Failed to create directory: ${path}`);
      }
    }
  }

  async readdir(path: string, _options: { withFileTypes: true }): Promise<Dirent[]> {
    const result = await this.runCommand(
      `find ${shellEscape(path)} -maxdepth 1 -mindepth 1 -printf '%y %f\\n'`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    const output = result.stdout.trim();
    if (!output) {
      return [];
    }
    return output.split("\n").map((line) => {
      const [type, ...nameParts] = line.split(" ");
      const name = nameParts.join(" ");
      return {
        name,
        parentPath: path,
        path,
        isDirectory: () => type === "d",
        isFile: () => type === "f",
        isSymbolicLink: () => type === "l",
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
      } as Dirent;
    });
  }

  /**
   * Run a command and collect its output.
   *
   * Fires onCommandStart with the command's PID as soon as it is running
   * -- before it finishes -- so the sandbox-migration flow can find and
   * kill it while it is still in flight. onCommandEnd fires in the
   * finally block so the persisted active-command record is cleared on
   * success, failure, and kill alike.
   */
  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    if (this.stopped) {
      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: "Sandbox is stopped",
        truncated: false,
      };
    }

    let cmdId: string;
    let proc: import("modal").ContainerProcess;
    try {
      // The PID wrapper is what makes killCommand possible at all: it
      // prints the PID of the shell that goes on to run the real command.
      // `exec` is load-bearing -- without it the echoed $$ would be a
      // wrapper-outer shell that exits immediately while the real
      // command keeps running under a different (unknown) PID.
      //
      // The user's command runs inside its own `bash -c` so COMPOUND
      // commands work: `exec <compound>` is a syntax error in bash
      // (`do` after `exec while true`), which would have made every
      // loop/pipe/redirect fail before it ran.
      proc = await this.sdk.exec(
        [
          "bash",
          "-c",
          `cd ${shellEscape(cwd)} && echo "${PID_MARKER}$$" && ` +
            `exec bash -c ${shellEscape(command)}`,
        ],
        { workdir: this.workingDirectory, env: this.getCommandEnv() },
      );
      cmdId = (await readPid(proc.stdout)) ?? "";
    } catch (error) {
      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        truncated: false,
      };
    }

    if (this.hooks?.onCommandStart) {
      try {
        await this.hooks.onCommandStart({
          cmdId,
          command,
          cwd,
          startedAt: Date.now(),
        });
      } catch (error) {
        console.warn("[ModalSandbox] onCommandStart hook failed:", error);
      }
    }

    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = options?.signal
        ? AbortSignal.any([timeoutSignal, options.signal])
        : timeoutSignal;

      const [stdout, stderr] = await Promise.race([
        Promise.all([proc.stdout.readText(), proc.stderr.readText()]),
        abortRace(signal).then(() => {
          throw new DOMException("Aborted", "AbortError");
        }),
      ]);
      const exitCode = await proc.wait();

      return {
        success: exitCode === 0,
        exitCode,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        truncated: stdout.length > MAX_OUTPUT_LENGTH || stderr.length > MAX_OUTPUT_LENGTH,
        killedExternally: this.killedCommandIds.has(cmdId),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return {
          success: false,
          exitCode: null,
          stdout: "",
          stderr: `Command timed out after ${timeoutMs}ms`,
          truncated: false,
        };
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (isModalSandboxGoneError(message)) {
        this.markGone();
      }
      return {
        success: false,
        exitCode: null,
        stdout: "",
        stderr: message,
        truncated: false,
        killedExternally: this.killedCommandIds.has(cmdId),
      };
    } finally {
      this.killedCommandIds.delete(cmdId);
      if (this.hooks?.onCommandEnd) {
        try {
          await this.hooks.onCommandEnd(cmdId);
        } catch (error) {
          console.warn("[ModalSandbox] onCommandEnd hook failed:", error);
        }
      }
    }
  }

  /**
   * Force-kill a running command by id from any process -- used by the
   * sandbox-migration flow to stop an in-flight tool call (found via the
   * {cmdId} persisted by onCommandStart) before packaging the workspace
   * and handing it off to a fresh sandbox.
   *
   * Modal has no kill RPC, so this signals the PID from INSIDE the
   * sandbox: SIGTERM first, then SIGKILL a second later. Best-effort --
   * a PID that already exited is a no-op, and a failure never throws
   * into the caller's turn.
   */
  async killCommand(cmdId: string): Promise<void> {
    this.killedCommandIds.add(cmdId);
    if (this.stopped) {
      return;
    }
    try {
      await this.sdk.exec(
        [
          "bash",
          "-c",
          `kill -TERM ${shellEscape(cmdId)} 2>/dev/null || true; ` +
            `sleep 1; kill -KILL ${shellEscape(cmdId)} 2>/dev/null || true`,
        ],
        {
          workdir: this.workingDirectory,
          env: this.getCommandEnv(),
          timeoutMs: 20_000,
        },
      );
    } catch {
      // The sandbox may already be gone -- nothing left to kill.
    }
  }

  /**
   * Execute a command in detached mode (returns immediately).
   * The command continues running in the background.
   */
  async execDetached(
    command: string,
    cwd: string,
  ): Promise<{ commandId: string }> {
    if (this.stopped) {
      throw new Error("Sandbox is stopped");
    }
    const proc = await this.sdk.exec(
      [
        "bash",
        "-c",
        `cd ${shellEscape(cwd)} && echo "${PID_MARKER}$$" && ` +
          `exec bash -c ${shellEscape(command)}`,
      ],
      { workdir: this.workingDirectory, env: this.getCommandEnv() },
    );
    const commandId = await readPid(proc.stdout);
    if (!commandId) {
      throw new Error("Failed to capture the background command's pid");
    }
    return { commandId };
  }

  /**
   * Get the public URL for an exposed port.
   *
   * Synchronous, because every route handler calls it without `await`.
   * The URLs are resolved once at creation (when `tunnels()` is async)
   * and cached here.
   */
  domain(port: number): string {
    const url = this.tunnelUrls.get(port);
    if (!url) {
      throw new Error(`No tunnel is configured for port ${port}`);
    }
    return url;
  }

  setGitHubAuthToken(token?: string): Promise<void> {
    this.brokeredGitHubToken = token;
    return Promise.resolve();
  }

  /** Run an operation with a GitHub token scoped to exactly that work. */
  async withGitHubAuth<T>(token: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.brokeredGitHubToken;
    this.brokeredGitHubToken = token;
    try {
      return await operation();
    } finally {
      this.brokeredGitHubToken = previous;
    }
  }

  /**
   * Capture the workspace as a Modal filesystem snapshot Image.
   *
   * A safety net before a risky change -- NOT a migration mechanism. The
   * workspace is already durable on its Volume, so a new sandbox simply
   * remounts the same bytes and there is nothing to transfer.
   */
  async snapshot(): Promise<SnapshotResult> {
    const image = await this.sdk.snapshotFilesystem({ timeoutMs: 55_000 });
    return { snapshotId: image.imageId ?? "" };
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this._expiresAt = 0;

    if (this.hooks?.beforeStop) {
      try {
        await this.hooks.beforeStop(this);
      } catch (error) {
        console.error(
          "[ModalSandbox] beforeStop hook failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    try {
      await this.sdk.terminate();
    } catch (error) {
      // A sandbox Modal already reaped is not an error for us.
      if (!isModalSandboxGoneError(errorMessage(error))) {
        throw error;
      }
    }
    this.sdk.detach();
  }

  get status(): "starting" | "ready" | "stopped" {
    return this.stopped ? "stopped" : "ready";
  }

  private markGone(): void {
    this.stopped = true;
    this._expiresAt = 0;
  }

  getState(): { type: "modal" } & ModalState {
    return {
      type: "modal",
      // No sandboxId once stopped: Modal has nothing to reconnect to,
      // and the volume is the durable half of the state.
      ...(this.stopped ? {} : { sandboxId: this.sdk.sandboxId }),
      ...(this.volumeName ? { volumeName: this.volumeName } : {}),
      ...(this.stopped ? {} : { expiresAt: this.expiresAt }),
    };
  }

  get host(): string | undefined {
    for (const port of this.tunnelUrls.keys()) {
      try {
        return new URL(this.domain(port)).host;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  get environmentDetails(): string {
    const volumeLine = this.volumeName
      ? `- The workspace lives on a persistent Modal Volume ("${this.volumeName}") mounted at ${MODAL_WORKSPACE_MOUNT_PATH}. Files you write survive sandbox expiry -- a new sandbox remounts the same volume, so there is nothing to migrate.`
      : "- The workspace is on the sandbox's own filesystem and does NOT survive sandbox expiry.";
    return `- Modal sandboxes are temporary (max ${Math.round(this.timeoutMs / 3_600_000)}h).
${volumeLine}
- All bash commands already run in the working directory by default -- never prepend "cd ${MODAL_WORKSPACE_MOUNT_PATH} &&"
- Use workspace-relative paths for read/write/search/edit operations
- Git is available for local inspection only; do not configure remotes or credentials
- GitHub writes are handled by the broker outside this sandbox. Do not configure credentials, commit, or push from inside the sandbox.
- Node.js, bun and git are available; Alpine is the base image, so "apk add" installs extra packages
- Dependencies may not be installed. Before running project scripts, check if "node_modules" exists and run the package manager install command if needed
- The sandbox has outbound network access; respect the user's trust level and do not fetch untrusted code blindly`;
  }
}

/** Resolve https URLs for every declared tunnel once, at create time. */
async function resolveTunnels(
  sdk: ModalSdkSandbox,
  ports: number[] | undefined,
): Promise<Map<number, string>> {
  const urls = new Map<number, string>();
  if (!ports?.length) {
    return urls;
  }
  try {
    const tunnels = await sdk.tunnels();
    for (const port of ports) {
      const tunnel = tunnels[port];
      if (tunnel?.url) {
        urls.set(port, String(tunnel.url));
      }
    }
  } catch {
    // Tunnels are optional; dev-server preview URLs simply stay absent.
  }
  return urls;
}

/** Single-quote a value for bash. */
function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function truncate(text: string): string {
  return text.length <= MAX_OUTPUT_LENGTH ? text : text.slice(0, MAX_OUTPUT_LENGTH);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve once `signal` aborts.
 *
 * Modal's `ContainerProcess.wait()` takes no signal, so the only way to
 * honour the caller's abort/timeout is to race it against the read.
 */
function abortRace(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Read the stream far enough to capture the `${PID_MARKER}<pid>` prefix.
 *
 * MUST NOT await `readText()` to completion: it resolves only at EOF, and a
 * DETACHED command never reaches EOF, so awaiting it deadlocks
 * `execDetached` (and the whole kill-command path) on the first detached
 * launch. Verified live against Modal: the marker line arrives in the very
 * first chunk, seconds before EOF would ever happen.
 *
 * Reads incrementally with `getReader()` and returns as soon as the marker
 * + digits are complete, leaving the rest of the stream unconsumed.
 */
async function readPid(
  stream: {
    readText(): Promise<string>;
    getReader?: () => {
      read(): Promise<{ done?: boolean; value?: unknown }>;
      releaseLock(): void;
    };
  },
): Promise<string | undefined> {
  if (typeof stream.getReader !== "function") {
    // Fallback for streams that only expose the one-shot read (tests and
    // any future SDK shape change).
    return pidFromStdout(await stream.readText());
  }

  const reader = stream.getReader();
  let buffer = "";
  try {
    // Bounded: the marker is echoed before the command runs, so a few
    // seconds is generous. Without a bound, a wedged stream would hang
    // the turn forever.
    const deadline = Date.now() + READ_PID_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done?: boolean; value?: unknown }>((resolve) =>
          setTimeout(() => resolve({ value: undefined }), 1_000),
        ),
      ]);
      if (chunk.done) {
        break;
      }
      if (chunk.value !== undefined) {
        buffer +=
          typeof chunk.value === "string"
            ? chunk.value
            : new TextDecoder().decode(chunk.value as Uint8Array);
        const pid = pidFromStdout(buffer);
        if (pid !== undefined) {
          return pid;
        }
      }
    }
  } catch {
    // A stream that errors has no usable pid; callers treat a missing pid
    // as "nothing to kill" rather than failing the command.
    return undefined;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by the stream teardown.
    }
  }

  return pidFromStdout(buffer);
}
