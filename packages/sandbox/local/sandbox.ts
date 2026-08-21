import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExecResult, Sandbox, SandboxHooks } from "../interface.ts";
import type { LocalState } from "./state.ts";

export interface LocalSandboxConnectOptions {
  env?: Record<string, string>;
  hooks?: SandboxHooks;
  timeout?: number;
}

/**
 * Sandbox implementation backed by a real local directory + child_process,
 * implementing the exact same Sandbox interface the "vercel" implementation
 * does. Every existing tool (bash/read/write/edit/grep/glob) works against
 * this unmodified -- they only ever go through the Sandbox interface, never
 * the Vercel Sandbox SDK directly.
 *
 * Intentionally NOT used for real user sessions -- see state.ts docstring.
 */
export class LocalSandbox implements Sandbox {
  readonly type = "cloud" as const; // matches the interface's SandboxType union
  readonly workingDirectory: string;
  readonly env?: Record<string, string>;
  readonly hooks?: SandboxHooks;
  readonly timeout?: number;

  constructor(rootDir: string, options?: LocalSandboxConnectOptions) {
    this.workingDirectory = rootDir;
    this.env = options?.env;
    this.hooks = options?.hooks;
    this.timeout = options?.timeout;
  }

  private resolve(p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(this.workingDirectory, p);
  }

  async readFile(filePath: string): Promise<string> {
    return fs.readFile(this.resolve(filePath), "utf-8");
  }

  async readFileBuffer(filePath: string): Promise<Buffer> {
    return fs.readFile(this.resolve(filePath));
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const resolved = this.resolve(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");
  }

  async writeFileBuffer(filePath: string, content: Buffer): Promise<void> {
    const resolved = this.resolve(filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content);
  }

  async stat(filePath: string) {
    const s = await fs.stat(this.resolve(filePath));
    return {
      isDirectory: () => s.isDirectory(),
      isFile: () => s.isFile(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  }

  async access(filePath: string): Promise<void> {
    await fs.access(this.resolve(filePath));
  }

  async mkdir(
    dirPath: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    await fs.mkdir(this.resolve(dirPath), {
      recursive: options?.recursive ?? false,
    });
  }

  async readdir(
    dirPath: string,
    _options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    return fs.readdir(this.resolve(dirPath), {
      withFileTypes: true,
    }) as unknown as Promise<Dirent[]>;
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    const resolvedCwd = this.resolve(cwd);

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

  // deliberately no execDetached/setGitHubAuthToken/setVercelAuthToken/
  // domain/snapshot -- optional on the interface, and none of the
  // benchmark tasks or local dev use cases need them. Callers get a
  // clear "not a function" error if a tool ever calls one of these
  // against a LocalSandbox, which is the right failure mode (loud, not
  // silently wrong).

  async stop(): Promise<void> {
    // no remote resource to release
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
