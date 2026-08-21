import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { connectLocal, LocalSandbox } from "./sandbox.ts";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "local-sandbox-test-"));
}

describe("LocalSandbox", () => {
  test("writes and reads a file via relative + absolute paths", async () => {
    const root = await makeTmpDir();
    const sandbox = new LocalSandbox(root);

    await sandbox.writeFile("hello.txt", "hi there");
    expect(await sandbox.readFile("hello.txt")).toBe("hi there");
    expect(await sandbox.readFile(path.join(root, "hello.txt"))).toBe(
      "hi there",
    );

    await fs.rm(root, { recursive: true, force: true });
  });

  test("writeFile creates missing parent directories", async () => {
    const root = await makeTmpDir();
    const sandbox = new LocalSandbox(root);

    await sandbox.writeFile("nested/dir/file.txt", "content");
    expect(await sandbox.readFile("nested/dir/file.txt")).toBe("content");

    await fs.rm(root, { recursive: true, force: true });
  });

  test("exec runs a real shell command scoped to cwd and returns exit code", async () => {
    const root = await makeTmpDir();
    const sandbox = new LocalSandbox(root);
    await sandbox.writeFile("marker.txt", "present");

    const result = await sandbox.exec("ls", root, 5000);
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("marker.txt");

    await fs.rm(root, { recursive: true, force: true });
  });

  test("exec surfaces a non-zero exit code without throwing", async () => {
    const root = await makeTmpDir();
    const sandbox = new LocalSandbox(root);

    const result = await sandbox.exec("exit 3", root, 5000);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);

    await fs.rm(root, { recursive: true, force: true });
  });

  test("exec kills a runaway command at the timeout instead of hanging", async () => {
    const root = await makeTmpDir();
    const sandbox = new LocalSandbox(root);

    const result = await sandbox.exec("sleep 30", root, 200);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("timed out");

    await fs.rm(root, { recursive: true, force: true });
  });

  test("stat/access reflect real filesystem state", async () => {
    const root = await makeTmpDir();
    const sandbox = new LocalSandbox(root);
    await sandbox.writeFile("a.txt", "x");

    const stats = await sandbox.stat("a.txt");
    expect(stats.isFile()).toBe(true);
    expect(stats.isDirectory()).toBe(false);
    await expect(sandbox.access("a.txt")).resolves.toBeUndefined();
    await expect(sandbox.access("missing.txt")).rejects.toThrow();

    await fs.rm(root, { recursive: true, force: true });
  });

  test("connectLocal creates the root directory and runs afterStart hook", async () => {
    const root = path.join(await makeTmpDir(), "not-yet-created");
    let hookRanWith: unknown;

    const sandbox = await connectLocal(
      { rootDir: root },
      {
        hooks: {
          afterStart: async (sb) => {
            hookRanWith = sb;
          },
        },
      },
    );

    const exists = await fs
      .stat(root)
      .then((s) => s.isDirectory())
      .catch(() => false);
    expect(exists).toBe(true);
    expect(hookRanWith).toBe(sandbox);

    await fs.rm(path.dirname(root), { recursive: true, force: true });
  });
});
