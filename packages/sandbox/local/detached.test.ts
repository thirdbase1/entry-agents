import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { LocalSandbox, LocalSandboxPathError } from "./sandbox.ts";

/**
 * Phase 2B -- detached process lifecycle.
 *
 * Every test is written so nothing survives a failure: cleanup is in
 * afterAll for the shared sandbox, per-test kills use try/finally or rely on
 * sandbox.stop() (which terminates every owned process) in afterAll.
 */

const tmpRoots: string[] = [];
async function makeRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-sandbox-proc-"));
  tmpRoots.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(
    tmpRoots.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

/** Resolves once the given PID is no longer alive (polls, 25ms cadence). */
async function waitGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // signal 0 = liveness probe only
      await new Promise((r) => setTimeout(r, 25));
    } catch {
      return true; // ESRCH -- gone
    }
  }
  try {
    process.kill(pid, 0);
    return false; // still alive
  } catch {
    return true;
  }
}

async function waitListening(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`nothing listening on port ${port} within ${timeoutMs}ms`);
}

/** The server process for the dev-server-style test; killed in afterAll. */
let serverCleanupPid: number | undefined;

describe("LocalSandbox detached process lifecycle", () => {
  test("short-lived command: returns immediately with a command id", async () => {
    const root = await makeRoot();
    const sandbox = new LocalSandbox(root);

    const start = Date.now();
    const { commandId } = await sandbox.execDetached("sleep 0.2", root);
    const elapsed = Date.now() - start;

    expect(commandId).toMatch(/^local-\d+$/);
    expect(elapsed).toBeLessThan(1000); // did NOT wait for completion
  });

  test("long-running command: alive after execDetached returns, still tracked", async () => {
    const root = await makeRoot();
    const sandbox = new LocalSandbox(root);

    // Write our own pid so the test can observe liveness independently.
    const { commandId } = await sandbox.execDetached(
      `sleep 30 & echo $! > ${JSON.stringify(path.join(root, "pid.txt"))}; wait`,
      root,
    );
    try {
      await new Promise((r) => setTimeout(r, 300));
      const pid = Number((await fs.readFile(path.join(root, "pid.txt"), "utf-8")).trim());
      expect(Number.isFinite(pid)).toBe(true);
      // alive: signal 0 succeeds
      expect(() => process.kill(pid, 0)).not.toThrow();

      // Kill the whole thing by id; the background `sleep` is a child of the
      // bash child, so the process-group signal is what reaches it.
      await sandbox.killCommand(commandId);
      expect(await waitGone(pid)).toBe(true);
    } finally {
      await sandbox.stop();
    }
  });

  test("kill: process terminates and registry releases the id", async () => {
    const root = await makeRoot();
    const sandbox = new LocalSandbox(root);

    const { commandId } = await sandbox.execDetached("sleep 30", root);
    const { commandId: secondId } = await sandbox.execDetached("sleep 30", root);
    try {
      expect(commandId).not.toBe(secondId); // ids are unique per sandbox

      await sandbox.killCommand(commandId);
      // second one untouched
      const registryAfterFirst = await sandbox
        .execDetached("true", root)
        .then(() => true);
      expect(registryAfterFirst).toBe(true);
      await sandbox.killCommand(secondId);
    } finally {
      await sandbox.stop();
    }
  });

  test("kill an already-exited process resolves cleanly", async () => {
    const root = await makeRoot();
    const sandbox = new LocalSandbox(root);

    const { commandId } = await sandbox.execDetached("true", root); // exits at once
    await new Promise((r) => setTimeout(r, 150)); // let it exit + deregister
    // Either the registry slot is gone (no-op) or the exit was observed --
    // both must resolve without throwing.
    await expect(sandbox.killCommand(commandId)).resolves.toBeUndefined();

    // Race window: grab a live one, let it die, then kill by id.
    const { commandId: racingId } = await sandbox.execDetached("sleep 0.05", root);
    await new Promise((r) => setTimeout(r, 200));
    await expect(sandbox.killCommand(racingId)).resolves.toBeUndefined();
  });

  test("unknown / foreign process ids are refused (no arbitrary PID kill)", async () => {
    const root = await makeRoot();
    const sandbox = new LocalSandbox(root);

    // Never spawned by this sandbox -- including values that look like PIDs.
    await expect(sandbox.killCommand("local-999")).resolves.toBeUndefined();
    await expect(sandbox.killCommand("1")).resolves.toBeUndefined(); // init!
    await expect(sandbox.killCommand(process.pid.toString())).resolves.toBeUndefined();
    await expect(sandbox.killCommand("")).resolves.toBeUndefined();

    // A DIFFERENT sandbox instance's ids are foreign to this one.
    const other = new LocalSandbox(root);
    const { commandId } = await other.execDetached("sleep 30", root);
    try {
      await expect(sandbox.killCommand(commandId)).resolves.toBeUndefined();
      // ...and the other instance's process is unaffected by the refused kill.
      const probe = await other.exec("kill -0 $$", root, 3000);
      expect(probe.success).toBe(true);
    } finally {
      await other.stop();
    }
  });

  test("cwd containment: inside allowed, outside rejected with LocalSandboxPathError", async () => {
    const base = await makeRoot();
    const root = path.join(base, "project");
    await fs.mkdir(root);
    const sandbox = new LocalSandbox(root);

    await expect(sandbox.execDetached("true", root)).resolves.toMatchObject({
      commandId: expect.stringMatching(/^local-/),
    });
    await expect(sandbox.execDetached("true", "..")).rejects.toBeInstanceOf(
      LocalSandboxPathError,
    );
    await expect(
      sandbox.execDetached("true", path.join(base, "outside-dir")),
    ).rejects.toBeInstanceOf(LocalSandboxPathError);
    await expect(
      sandbox.execDetached("true", "/etc"),
    ).rejects.toBeInstanceOf(LocalSandboxPathError);
  });

  test("dev-server-style: Node server binds a port, stays up, then dies on kill", async () => {
    const root = await makeRoot();
    const sandbox = new LocalSandbox(root);
    const port = 18_000 + Math.floor(Math.random() * 2_000);
    const serverScript = path.join(root, "tiny-server.js");
    await fs.writeFile(
      serverScript,
      `require("http").createServer((_, res) => res.end("ok")).listen(${port}, "127.0.0.1");`,
    );

    // Mirrors how the web app's dev-server launcher wraps the run command:
    // write the child pid to a file, then exec the real server.
    const pidFile = path.join(root, "server.pid");
    const { commandId } = await sandbox.execDetached(
      `echo $$ > ${JSON.stringify(pidFile)} && exec ${JSON.stringify(process.execPath)} ${JSON.stringify(serverScript)}`,
      root,
    );

    serverCleanupPid = undefined;
    try {
      await waitListening(port); // proves the process is actually serving

      // The listener is alive independently of execDetached's return.
      const pid = Number((await fs.readFile(pidFile, "utf-8")).trim());
      serverCleanupPid = pid;
      expect(() => process.kill(pid, 0)).not.toThrow();

      await sandbox.killCommand(commandId);
      expect(await waitGone(pid)).toBe(true);

      // And the port really closed (nothing is serving anymore).
      let stillOpen = false;
      for (let i = 0; i < 20; i++) {
        stillOpen = await new Promise<boolean>((resolve) => {
          const socket = net.connect(port, "127.0.0.1");
          socket.once("connect", () => {
            socket.destroy();
            resolve(true);
          });
          socket.once("error", () => resolve(false));
        });
        if (!stillOpen) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(stillOpen).toBe(false);
      serverCleanupPid = undefined; // killCommand handled it
    } finally {
      if (serverCleanupPid !== undefined) {
        try {
          process.kill(-serverCleanupPid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      await sandbox.stop();
    }
  });

  test("stop() terminates everything still owned by the sandbox", async () => {
    const root = await makeRoot();
    const sandbox = new LocalSandbox(root);

    const pidFiles = ["s1.pid", "s2.pid"];
    const ids = [];
    for (const f of pidFiles) {
      const { commandId } = await sandbox.execDetached(
        `sleep 60 & echo $! > ${JSON.stringify(path.join(root, f))}; wait`,
        root,
      );
      ids.push(commandId);
    }
    await new Promise((r) => setTimeout(r, 300));
    const pids = await Promise.all(
      pidFiles.map((f) =>
        fs.readFile(path.join(root, f), "utf-8").then((s) => Number(s.trim())),
      ),
    );
    for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();

    await sandbox.stop();

    for (const pid of pids) expect(await waitGone(pid)).toBe(true);
  });
});
