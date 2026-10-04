import { spawn, type ChildProcess } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExecResult, Sandbox, SandboxHooks } from "../interface.ts";
import type { LocalState } from "./state.ts";

export interface LocalSandboxConnectOptions {
  env?: Record<string, string>;
  hooks?: SandboxHooks;
  timeout?: number;
  /**
   * Additional filesystem roots this sandbox may touch, beyond its own
   * `rootDir`. Defaults to `[]`, i.e. rootDir is the only allowed root.
   *
   * This is the security boundary for the desktop runtime: without it,
   * `LocalSandbox` was a plain filesystem wrapper whose `resolve()` happily
   * joined any absolute path or `../` segment handed to it. Roots (including
   * rootDir) are canonicalized once, through `realpath`, at construction
   * time so a symlinked root still compares correctly against realpaths.
   */
  allowedRoots?: string[];
}

/**
 * Longest a detached process may keep running after its LocalSandbox is
 * stopped. On stop() we try a graceful termination first, then hard-kill
 * whatever is left after this window. Slightly generous: `pnpm dev` needs a
 * moment to forward SIGTERM to its child server before exiting.
 */
const DETACHED_SHUTDOWN_GRACE_MS = 2_000;

/**
 * How long killCommand() waits for the OS to actually reap the process tree
 * before falling back to SIGKILL. Kept short -- this is a command cancel,
 * not a graceful application shutdown.
 */
const KILL_ESCALATION_MS = 1_000;

/**
 * Thrown when a path handed to LocalSandbox escapes every allowed root.
 *
 * Echoes only the caller-provided string, never the resolved host path,
 * realpath, or symlink target: the caller (often a model) needs to know the
 * path is outside the workspace, and filesystem layout is not its business.
 */
export class LocalSandboxPathError extends Error {
  readonly code = "LOCAL_SANDBOX_PATH_OUTSIDE_ROOT";
  constructor(received: string) {
    super(
      `Path "${received}" is outside the allowed workspace roots for this sandbox.`,
    );
    this.name = "LocalSandboxPathError";
  }
}

/** True when `candidate` is `root` itself or a descendant of it. */
function isWithin(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/**
 * Sandbox implementation backed by a real local directory + child_process,
 * implementing the exact same Sandbox interface the "vercel" implementation
 * does. Every existing tool (bash/read/write/edit/grep/glob) works against
 * this unmodified -- they only ever go through the Sandbox interface, never
 * the Vercel Sandbox SDK directly.
 *
 * Path containment: every path-taking method resolves through `resolvePath`,
 * the single canonical containment function. Containment is enforced here,
 * at the sandbox boundary, so it holds even when the higher-level tool
 * guards (`tools/path-security.ts`, `tools/cwd-security.ts`) are bypassed.
 * Those tool guards are intentionally left in place -- this is a second,
 * independent layer, not a replacement.
 *
 * Process lifecycle: execDetached()/killCommand() manage background
 * processes (dev servers) owned by THIS instance. Command ids are opaque
 * (`local-1`, `local-2`, ...); killing is registry-scoped, never by raw
 * PID, so foreign or stale ids cannot reach unrelated system processes.
 * See each method's doc for tree/platform semantics and limitations.
 *
 * Intentionally NOT used for real user sessions by the web app -- see
 * state.ts. It IS the intended desktop execution layer.
 */
export class LocalSandbox implements Sandbox {
  readonly type = "cloud" as const; // matches the interface's SandboxType union
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
  readonly hooks?: SandboxHooks;
  readonly timeout?: number;
  readonly allowedRoots: readonly string[];

  /**
   * Canonical (realpath-resolved) allowed roots, computed once. Root dirs are
   * normally created before construction (connectLocal mkdirs them), so this
   * settles on the first resolution; failures degrade to the lexical path.
   */
  private readonly realRoots: Promise<string[]>;

  /**
   * Detached processes this instance started, keyed by opaque commandId.
   *
   * This is the ownership boundary for killCommand(): only ids present here
   * can be terminated, and the stored value holds the ChildProcess handle --
   * never a raw PID lookup. A killCommand() for an unknown, foreign, or
   * already-reaped id therefore cannot reach an arbitrary system process.
   *
   * Entries are removed when the process exits (the 'exit' listener runs for
   * self-exited processes too, because exit listeners are not gated on
   * killCommand being the cause).
   */
  private readonly ownedCommands = new Map<
    string,
    { child: ChildProcess; label: string }
  >();

  /** Monotonic counter for opaque command ids. */
  private commandSeq = 0;

  constructor(rootDir: string, options?: LocalSandboxConnectOptions) {
    this.workingDirectory = rootDir;
    this.env = options?.env;
    this.hooks = options?.hooks;
    this.timeout = options?.timeout;
    this.allowedRoots = [rootDir, ...(options?.allowedRoots ?? [])];
    this.realRoots = Promise.all(
      this.allowedRoots.map(async (root) => {
        try {
          return await fs.realpath(root);
        } catch {
          return path.resolve(root);
        }
      }),
    );
  }

  /**
   * Canonical path resolution + containment. The single security path all
   * methods below use.
   *
   * Algorithm:
   *  1. Absolutize against the working directory.
   *  2. Find the longest existing ancestor and `realpath` it, so symlinks in
   *     the *existing* part of the path are resolved before comparison.
   *  3. Re-append the nonexistent tail (normalized) so writes to files that
   *     do not exist yet (`src/new-file.txt`) still work.
   *  4. Require the result to be inside an allowed root, compared as whole
   *     path segments (never a string-prefix test, so `/project-secret` can
   *     never satisfy a `/project` root).
   *
   * TOCTOU: this is not race-free. A symlink swapped in between this check
   * and the subsequent fs operation can still redirect the operation. Making
   * it race-free needs `openat`/`O_NOFOLLOW`-style descriptor-relative
   * syscalls, which Node does not expose portably; the practical mitigation
   * here is that the caller is the same user that owns the workspace. See
   * ENTRY-DESKTOP-HARDENING-RESULT.md for the documented limitation.
   */
  private async resolvePath(p: string): Promise<string> {
    const absolute = path.isAbsolute(p)
      ? path.resolve(p)
      : path.resolve(this.workingDirectory, p);

    // realpath the deepest existing ancestor, then re-append the rest.
    let anchor = absolute;
    let tail = "";
    for (;;) {
      try {
        await fs.lstat(anchor);
        break;
      } catch {
        const parent = path.dirname(anchor);
        /* c8 ignore next 3 -- only reachable at a filesystem root */
        if (parent === anchor) break;
        tail = tail ? path.join(path.basename(anchor), tail) : path.basename(anchor);
        anchor = parent;
      }
    }

    let realAnchor: string;
    try {
      realAnchor = await fs.realpath(anchor);
    } catch {
      realAnchor = path.resolve(anchor);
    }

    const canonical = tail ? path.resolve(realAnchor, tail) : realAnchor;
    const roots = await this.realRoots;

    if (!roots.some((root) => isWithin(root, canonical))) {
      throw new LocalSandboxPathError(p);
    }
    return canonical;
  }

  async readFile(filePath: string): Promise<string> {
    return fs.readFile(await this.resolvePath(filePath), "utf-8");
  }

  async readFileBuffer(filePath: string): Promise<Buffer> {
    return fs.readFile(await this.resolvePath(filePath));
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const resolved = await this.resolvePath(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");
  }

  async writeFileBuffer(filePath: string, content: Buffer): Promise<void> {
    const resolved = await this.resolvePath(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content);
  }

  async stat(filePath: string) {
    const s = await fs.stat(await this.resolvePath(filePath));
    return {
      isDirectory: () => s.isDirectory(),
      isFile: () => s.isFile(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  }

  async access(filePath: string): Promise<void> {
    await fs.access(await this.resolvePath(filePath));
  }

  async mkdir(
    dirPath: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    await fs.mkdir(await this.resolvePath(dirPath), {
      recursive: options?.recursive ?? false,
    });
  }

  async readdir(
    dirPath: string,
    _options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    return fs.readdir(await this.resolvePath(dirPath), {
      withFileTypes: true,
    }) as unknown as Promise<Dirent[]>;
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    // The cwd goes through the same containment check as file paths: a
    // sandbox whose `exec` accepts an out-of-root cwd is not a boundary.
    const resolvedCwd = await this.resolvePath(cwd);

    return new Promise((resolve) => {
      const child = spawn("bash", ["-c", command], {
        cwd: resolvedCwd,
        env: { ...process.env, ...this.env },
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      // Single settlement point -- every listener below calls this instead
      // of `resolve()` directly, so there's exactly one place that can
      // ever resolve the promise (the `settled` guard lives here, not
      // duplicated across four call sites).
      const settle = (result: ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // False positive below: the `settled` guard above is the single
        // gate for this call, so `resolve` only ever actually runs once
        // even though the rule's static analysis can't trace through the
        // indirection to see that four listeners share one guarded call
        // site.
        // oxlint-disable-next-line promise/no-multiple-resolved
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle({
          success: false,
          exitCode: null,
          stdout,
          stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms`,
          truncated: false,
        });
      }, timeoutMs);

      options?.signal?.addEventListener("abort", () => {
        child.kill("SIGKILL");
        settle({
          success: false,
          exitCode: null,
          stdout,
          stderr: "Command aborted",
          truncated: false,
        });
      });

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));

      child.on("close", (code) => {
        settle({
          success: code === 0,
          exitCode: code,
          stdout,
          stderr,
          truncated: false,
        });
      });

      child.on("error", (err) => {
        settle({
          success: false,
          exitCode: null,
          stdout,
          stderr: err.message,
          truncated: false,
        });
      });
    });
  }

  /**
   * Execute a shell command in detached mode: spawn it, return an opaque
   * commandId immediately, and do NOT wait for completion.
   *
   * Semantics guaranteed:
   *  - Returns as soon as the child has been spawned (no output wait, no
   *    quick-failure probe -- unlike Vercel's implementation, which races a
   *    short window to surface early crashes; a local dev server that is
   *    still booting must not be treated as failed here).
   *  - Output is intentionally DISCARDED (stdin/stdout/stderr -> "ignore",
   *    plus stdio: "ignore" for grandchildren). There is no in-memory log
   *    buffer, so a chatty server can never grow host memory; follow the
   *    process's own log file (or a UI terminal, later phase) for output.
   *  - The child is spawned with detached: true, i.e. its own process group
   *    (POSIX) / detached console semantics (Windows). Combined with stdio
   *    "ignore" this means the Node host is not held alive by the child's
   *    pipes and can exit without an unneeded IPC reference.
   *  - The cwd is resolved through the SAME containment path as exec(), so an
   *    out-of-workspace cwd throws LocalSandboxPathError.
   *  - The same environment as exec() is inherited (process.env + the
   *    sandbox's configured env). See exec() for that behavior.
   *
   * Not a PTY: interactive use is out of scope by design (OAgent's PTY layer
   * covers terminals in a later phase).
   */
  async execDetached(command: string, cwd: string): Promise<{ commandId: string }> {
    const resolvedCwd = await this.resolvePath(cwd);

    const child = spawn("bash", ["-c", command], {
      cwd: resolvedCwd,
      env: { ...process.env, ...this.env },
      detached: true,
      stdio: "ignore",
    });

    const commandId = `local-${(this.commandSeq += 1)}`;
    this.ownedCommands.set(commandId, { child, label: command });

    // Deregister on exit -- self-initiated exits included. 'exit' (not
    // 'close') so a process that leaves a grandchild holding a pipe still
    // frees its registry slot.
    child.on("exit", () => {
      this.ownedCommands.delete(commandId);
    });
    // A spawn failure must not become an unhandled 'error' event.
    child.on("error", () => {
      this.ownedCommands.delete(commandId);
    });

    // Own registry insert handled the reference; don't let the child's own
    // handle keep the event loop alive after the work is done.
    child.unref();

    return { commandId };
  }

  /**
   * Terminate a detached command started by THIS instance.
   *
   * Ownership: id lookup is by opaque commandId in `ownedCommands`; unknown,
   * foreign, or already-reaped ids are a no-op that resolves normally, so an
   * arbitrary system process can never be targeted through this method.
   *
   * Signal: SIGTERM first (so `pnpm dev`'s wrapper can forward it and exit),
   * escalated to SIGKILL if the tree has not exited within
   * KILL_ESCALATION_MS. The signal goes to the process GROUP when we created
   * one (POSIX detached spawn), which is what actually reaches the
   * `pnpm -> node -> server` tree; on Windows the direct child is terminated
   * and the group limitation is documented (see the class docstring).
   */
  async killCommand(cmdId: string): Promise<void> {
    const owned = this.ownedCommands.get(cmdId);
    if (!owned) return; // unknown/foreign/already-exited: nothing to do
    this.ownedCommands.delete(cmdId);

    const { child } = owned;
    if (child.exitCode !== null || child.signalCode !== null) return;

    this.signalTree(child, "SIGTERM");

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          this.signalTree(child, "SIGKILL");
        }
        // Don't wait forever on a signal that was already delivered.
        resolve();
      }, KILL_ESCALATION_MS);
    });
  }

  /**
   * Deliver `signal` to the whole process group the child leads when it has
   * one (POSIX, detached spawn), else to the child itself. Kept in one place
   * so the platform branch is isolated and auditable.
   *
   * Windows: no process groups, so only the direct child is signalled and
   * grandchildren may survive -- a documented limitation.
   */
  private signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return;
    if (process.platform === "win32") {
      child.kill(signal);
      return;
    }
    try {
      // Negative pid = the process group led by this child.
      process.kill(-child.pid, signal);
    } catch {
      // Group already gone (or never formed) -- fall back to the child.
      try {
        child.kill(signal);
      } catch {
        /* already exited */
      }
    }
  }

  // deliberately no setGitHubAuthToken/setVercelAuthToken/domain/snapshot --
  // optional on the interface, and none of the benchmark tasks or local dev
  // use cases need them. Callers get a clear "not a function" error if a tool
  // ever calls one of these against a LocalSandbox, which is the right failure
  // mode (loud, not silently wrong).

  async stop(): Promise<void> {
    // Terminate every detached process this instance started, so quitting the
    // app cannot orphan dev servers. Graceful first, then hard-kill.
    const running = [...this.ownedCommands.values()];
    this.ownedCommands.clear();
    const live = running.filter(
      ({ child }) => child.exitCode === null && child.signalCode === null,
    );
    if (live.length === 0) return;

    for (const { child } of live) this.signalTree(child, "SIGTERM");
    await Promise.race([
      Promise.all(
        live.map(
          ({ child }) =>
            new Promise<void>((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) return resolve();
              child.once("exit", () => resolve());
            }),
        ),
      ),
      new Promise<void>((r) => setTimeout(r, DETACHED_SHUTDOWN_GRACE_MS)),
    ]);
    for (const { child } of live) {
      if (child.exitCode === null && child.signalCode === null) {
        this.signalTree(child, "SIGKILL");
      }
    }
  }

  getState(): LocalState {
    return { rootDir: this.workingDirectory };
  }
}

export async function connectLocal(
  state: LocalState,
  options?: LocalSandboxConnectOptions,
): Promise<Sandbox> {
  await fs.mkdir(state.rootDir, { recursive: true });
  const sandbox = new LocalSandbox(state.rootDir, options);
  if (options?.hooks?.afterStart) {
    await options.hooks.afterStart(sandbox);
  }
  return sandbox;
}
