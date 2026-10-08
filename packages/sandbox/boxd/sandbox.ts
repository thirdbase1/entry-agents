import type { Boxd } from "@boxd-sh/sdk";
import type { DirEntry, ExecResult as BoxdExecResult } from "@boxd-sh/sdk";
import type { Dirent } from "node:fs";
import type {
  ActiveCommandInfo,
  ExecResult,
  Sandbox,
  SandboxHooks,
  SandboxStats,
} from "../interface.ts";
import type { ConnectOptions } from "../factory.ts";
import { BOXD_WORKING_DIRECTORY } from "./config.ts";

function asDirent(entry: DirEntry): Dirent {
  return {
    name: entry.name,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => entry.isDir,
    isFIFO: () => false,
    isFile: () => !entry.isDir,
    isSocket: () => false,
    isSymbolicLink: () => false,
  } as Dirent;
}

function mapExec(result: BoxdExecResult): ExecResult {
  return {
    success: result.success,
    exitCode: result.exitCode ?? null,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: false,
  };
}

export class BoxdSandbox implements Sandbox {
  readonly type = "cloud" as const;
  readonly workingDirectory = BOXD_WORKING_DIRECTORY;
  readonly hooks?: SandboxHooks;
  readonly env?: Record<string, string>;
  readonly host?: string;
  readonly expiresAt?: number;
  private githubToken?: string;
  private stopped = false;

  constructor(
    private readonly client: Boxd,
    private readonly machineId: string,
    private readonly machineName: string,
    options?: ConnectOptions,
  ) {
    this.hooks = options?.hooks;
    this.env = options?.env;
  }

  private assertRunning() {
    if (this.stopped) throw new Error("boxd sandbox is stopped");
  }

  private commandEnv(): Record<string, string> | undefined {
    return this.githubToken
      ? { ...(this.env ?? {}), GITHUB_TOKEN: this.githubToken }
      : this.env;
  }

  async readFile(path: string, _encoding: "utf-8"): Promise<string> {
    this.assertRunning();
    const bytes = await this.client.machines.files.download(this.machineId, path);
    return new TextDecoder().decode(bytes);
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    this.assertRunning();
    return Buffer.from(await this.client.machines.files.download(this.machineId, path));
  }

  async writeFile(path: string, content: string, _encoding: "utf-8"): Promise<void> {
    await this.writeFileBuffer(path, Buffer.from(content, "utf8"));
  }

  async writeFileBuffer(path: string, content: Buffer): Promise<void> {
    this.assertRunning();
    await this.client.machines.files.upload(this.machineId, path, content);
  }

  async stat(path: string): Promise<SandboxStats> {
    const result = await this.client.machines.exec(this.machineId, {
      command: ["stat", "-c", "%F|%s|%Y", path],
      cwd: BOXD_WORKING_DIRECTORY,
      env: this.commandEnv(),
    });
    if (!result.success) throw new Error(result.stderr || "boxd stat failed");
    const [kind, size, mtime] = result.stdout.trim().split("|");
    return {
      isDirectory: () => kind === "directory",
      isFile: () => kind === "regular file",
      size: Number(size),
      mtimeMs: Number(mtime) * 1000,
    };
  }

  async access(path: string): Promise<void> {
    const result = await this.client.machines.exec(this.machineId, {
      command: ["test", "-e", path],
      cwd: BOXD_WORKING_DIRECTORY,
      env: this.commandEnv(),
    });
    if (!result.success) throw new Error(result.stderr || `Path does not exist: ${path}`);
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    await this.client.machines.exec(this.machineId, {
      command: ["mkdir", "-p", path],
      cwd: BOXD_WORKING_DIRECTORY,
      env: this.commandEnv(),
    });
  }

  async readdir(path: string, _options: { withFileTypes: true }): Promise<Dirent[]> {
    const listing = await this.client.machines.files.listDir(this.machineId, path);
    return listing.entries.map(asDirent);
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    this.assertRunning();
    if (options?.signal?.aborted) throw new Error("Command aborted");
    const result = await this.client.machines.exec(this.machineId, {
      command,
      cwd,
      timeout: timeoutMs,
      env: this.commandEnv(),
    });
    return mapExec(result);
  }

  async setGitHubAuthToken(token?: string): Promise<void> {
    this.githubToken = token;
  }

  async destroy(): Promise<void> {
    if (this.stopped) return;
    await this.hooks?.beforeStop?.(this);
    await this.client.machines.delete(this.machineId);
    await this.client.close();
    this.stopped = true;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    await this.hooks?.beforeStop?.(this);
    await this.client.machines.hibernate(this.machineId);
    this.stopped = true;
  }

  domain(port: number): string {
    return `${this.machineName}.boxd.sh`;
  }

  getState(): { type: "boxd"; machineId: string; machineName: string } {
    return { type: "boxd", machineId: this.machineId, machineName: this.machineName };
  }
}
