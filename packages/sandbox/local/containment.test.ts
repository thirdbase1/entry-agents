import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { connectLocal, LocalSandbox, LocalSandboxPathError } from "./sandbox.ts";

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "local-sandbox-test-"));
}

/**
 * Builds an isolated landscape:
 *
 *   <base>/project/          <- the sandbox root
 *   <base>/outside/secret.txt
 *   <base>/project-secret/   <- prefix-collision sibling of the root
 *
 * so escapes can be attempted without touching anything real.
 */
async function makeLandscape() {
  const base = await makeTmpDir();
  const root = path.join(base, "project");
  const outside = path.join(base, "outside");
  const collision = `${root}-secret`;
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(collision, { recursive: true });
  await fs.writeFile(path.join(outside, "secret.txt"), "top secret");
  await fs.writeFile(path.join(collision, "collision.txt"), "sibling");
  return { base, root, outside, collision };
}

async function trySymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

/** Asserts the operation rejects with the sandbox containment error. */
async function expectRejected(op: Promise<unknown>, label: string, input?: string) {
  let error: unknown;
  try {
    await op;
  } catch (err) {
    error = err;
  }
  expect(error, `${label} should have been rejected`).toBeInstanceOf(
    LocalSandboxPathError,
  );
  expect((error as LocalSandboxPathError).code).toBe(
    "LOCAL_SANDBOX_PATH_OUTSIDE_ROOT",
  );
  // The error must echo only the caller-provided string -- never the
  // resolved host path, realpath, or symlink target.
  if (input !== undefined) {
    expect((error as Error).message).toBe(
      `Path "${input}" is outside the allowed workspace roots for this sandbox.`,
    );
  }
}

describe("LocalSandbox workspace containment", () => {
  // ── PASS cases ────────────────────────────────────────────────────────
  test("PASS: the root directory itself", async () => {
    const { base, root } = await makeLandscape();
    const sandbox = new LocalSandbox(root);

    await expect(sandbox.access(root)).resolves.toBeUndefined();
    await expect(sandbox.readdir(root, { withFileTypes: true })).resolves.toBeArray();
    await expect(sandbox.stat(root)).resolves.toBeDefined();

    await fs.rm(base, { recursive: true, force: true });
  });

  test("PASS: simple file inside root (relative and absolute)", async () => {
    const { base, root } = await makeLandscape();
    const sandbox = new LocalSandbox(root);

    await sandbox.writeFile("hello.txt", "hi");
    expect(await sandbox.readFile("hello.txt")).toBe("hi");
    expect(await sandbox.readFile(path.join(root, "hello.txt"))).toBe("hi");
    await expect(sandbox.access(path.join(root, "hello.txt"))).resolves.toBeUndefined();

    await fs.rm(base, { recursive: true, force: true });
  });

  test("PASS: nested file and nested directory", async () => {
    const { base, root } = await makeLandscape();
    const sandbox = new LocalSandbox(root);

    await sandbox.writeFile("src/components/App.tsx", "export default null;");
    expect(await sandbox.readFile("src/components/App.tsx")).toBe("export default null;");
    await sandbox.writeFile("foo/bar/baz.txt", "deep");
    expect(await sandbox.readFile(path.join(root, "foo/bar/baz.txt"))).toBe("deep");
    await expect(sandbox.mkdir("src/newdir", { recursive: true })).resolves.toBeUndefined();
    await expect(sandbox.readdir("src", { withFileTypes: true })).resolves.toBeArray();

    await fs.rm(base, { recursive: true, force: true });
  });

  test("PASS: nonexistent file inside root (write creates parents)", async () => {
    const { base, root } = await makeLandscape();
    const sandbox = new LocalSandbox(root);

    await sandbox.writeFile("src/brand/new-file.txt", "created");
    expect(await fs.readFile(path.join(root, "src/brand/new-file.txt"), "utf-8")).toBe("created");
    // nonexistent + relative path resolution must not throw
    await expect(sandbox.access("nope/still-nope.txt")).rejects.toMatchObject({ code: "ENOENT" });

    await fs.rm(base, { recursive: true, force: true });
  });

  test("PASS: symlink whose target is inside root", async () => {
    const { base, root } = await makeLandscape();
    await fs.mkdir(path.join(root, "real"), { recursive: true });
    await fs.writeFile(path.join(root, "real", "inside.txt"), "inside content");
    const linked = await trySymlink(
      path.join(root, "real"),
      path.join(root, "safe-link"),
    );
    if (!linked) {
      throw new Error(
        "SYMLINK UNAVAILABLE: this environment does not permit symlink creation, so the symlink security cases could not be executed.",
      );
    }
    const sandbox = new LocalSandbox(root);

    expect(await sandbox.readFile("safe-link/inside.txt")).toBe("inside content");
    await expect(sandbox.readdir("safe-link", { withFileTypes: true })).resolves.toBeArray();

    await fs.rm(base, { recursive: true, force: true });
  });

  // ── REJECT cases ──────────────────────────────────────────────────────
  test("REJECT: relative traversal (../ and ../../)", async () => {
    const { base, root } = await makeLandscape();
    const sandbox = new LocalSandbox(root);

    await expectRejected(sandbox.readFile("../outside/secret.txt"), "../outside");
    await expectRejected(sandbox.readFile("../../outside/secret.txt"), "../../outside");
    await expectRejected(sandbox.writeFile("../outside/planted.txt", "x"), "write ../outside");
    await expectRejected(sandbox.access("../outside"), "access ../outside");

    await fs.rm(base, { recursive: true, force: true });
  });

  test("REJECT: nested traversal escaping root after valid segments", async () => {
    const { base, root } = await makeLandscape();
    const sandbox = new LocalSandbox(root);

    await expectRejected(
      sandbox.readFile("src/components/../../../outside/secret.txt"),
      "nested traversal",
    );
    await expectRejected(
      sandbox.writeFile("a/b/c/../../../../outside/planted.txt", "x"),
      "nested traversal write",
    );

    await fs.rm(base, { recursive: true, force: true });
  });

  test("REJECT: absolute path outside root", async () => {
    const { base, root, outside } = await makeLandscape();
    const sandbox = new LocalSandbox(root);

    await expectRejected(
      sandbox.readFile(path.join(outside, "secret.txt")),
      "absolute outside read",
    );
    await expectRejected(
      sandbox.writeFile(path.join(outside, "planted.txt"), "x"),
      "absolute outside write",
    );
    await expectRejected(sandbox.mkdir(outside, { recursive: true }), "absolute outside mkdir");
    await expectRejected(sandbox.readdir(outside, { withFileTypes: true }), "absolute outside readdir");

    await fs.rm(base, { recursive: true, force: true });
  });

  test("REJECT: symlink pointing outside root", async () => {
    const { base, root, outside } = await makeLandscape();
    const linked = await trySymlink(outside, path.join(root, "escape-link"));
    if (!linked) {
      throw new Error(
        "SYMLINK UNAVAILABLE: this environment does not permit symlink creation, so the symlink security cases could not be executed.",
      );
    }
    const sandbox = new LocalSandbox(root);

    // The symlink exists and is lexically inside root, but resolves outside.
    expect(await fs.readlink(path.join(root, "escape-link"))).toBe(outside);
    await expectRejected(sandbox.readFile("escape-link/secret.txt"), "symlink escape read");
    await expectRejected(sandbox.writeFile("escape-link/planted.txt", "x"), "symlink escape write");
    await expectRejected(sandbox.readdir("escape-link", { withFileTypes: true }), "symlink escape readdir");
    await expectRejected(sandbox.access("escape-link"), "symlink escape access");

    await fs.rm(base, { recursive: true, force: true });
  });

  test("REJECT: nested symlink chain escaping root", async () => {
    const { base, root, outside } = await makeLandscape();
    // project/chain/inner -> ../../outside   (escape via nested dir)
    await fs.mkdir(path.join(root, "chain"), { recursive: true });
    const linkedInner = await trySymlink(outside, path.join(root, "chain", "inner"));
    // project/outer -> chain/inner  (second hop)
    const linkedOuter = await trySymlink(
      path.join(root, "chain", "inner"),
      path.join(root, "outer"),
    );
    if (!linkedInner || !linkedOuter) {
      throw new Error(
        "SYMLINK UNAVAILABLE: this environment does not permit symlink creation, so the symlink security cases could not be executed.",
      );
    }
    const sandbox = new LocalSandbox(root);

    await expectRejected(sandbox.readFile("chain/inner/secret.txt"), "chain hop 1");
    await expectRejected(sandbox.readFile("outer/secret.txt"), "chain hop 2");
    await expectRejected(sandbox.writeFile("outer/planted.txt", "x"), "chain hop 2 write");

    await fs.rm(base, { recursive: true, force: true });
  });

  test("REJECT: prefix collision such as /project-secret", async () => {
    const { base, root, collision } = await makeLandscape();
    const sandbox = new LocalSandbox(root);

    expect(collision.startsWith(root)).toBe(true); // the trap: string-prefix would pass
    await expectRejected(
      sandbox.readFile(path.join(collision, "collision.txt")),
      "prefix collision read",
    );
    await expectRejected(
      sandbox.writeFile(path.join(collision, "planted.txt"), "x"),
      "prefix collision write",
    );

    await fs.rm(base, { recursive: true, force: true });
  });

  test("REJECT: prefix collision via relative traversal", async () => {
    const { base, root } = await makeLandscape();
    const sandbox = new LocalSandbox(root);

    // root = <base>/project ; "../project-secret/collision.txt"
    await expectRejected(
      sandbox.readFile("../project-secret/collision.txt"),
      "relative prefix collision",
    );

    await fs.rm(base, { recursive: true, force: true });
  });

  test("REJECT: exec cwd outside root", async () => {
    const { base, root, outside } = await makeLandscape();
    const sandbox = new LocalSandbox(root);

    const result = await sandbox.exec("pwd", outside, 5000).catch((e) => e);
    expect(result).toBeInstanceOf(LocalSandboxPathError);
    await expectRejected(sandbox.exec("pwd", "../outside", 5000), "exec ../outside");
    await expectRejected(sandbox.exec("pwd", path.join(outside, "..", "outside"), 5000), "exec normalized escape");

    await fs.rm(base, { recursive: true, force: true });
  });

  test("REJECT: symlinked cwd for exec", async () => {
    const { base, root, outside } = await makeLandscape();
    const linked = await trySymlink(outside, path.join(root, "escape-link"));
    if (!linked) {
      throw new Error(
        "SYMLINK UNAVAILABLE: this environment does not permit symlink creation, so the symlink security cases could not be executed.",
      );
    }
    const sandbox = new LocalSandbox(root);

    await expectRejected(sandbox.exec("pwd", "escape-link", 5000), "exec via symlinked cwd");

    await fs.rm(base, { recursive: true, force: true });
  });

  // ── allowedRoots opt-in ───────────────────────────────────────────────
  test("allowedRoots grants access to an explicitly permitted second root only", async () => {
    const { base, root, outside, collision } = await makeLandscape();
    const sandbox = new LocalSandbox(root, { allowedRoots: [outside] });

    expect(await sandbox.readFile(path.join(outside, "secret.txt"))).toBe("top secret");
    await expectRejected(
      sandbox.readFile(path.join(collision, "collision.txt")),
      "unlisted sibling still rejected",
    );

    await fs.rm(base, { recursive: true, force: true });
  });

  test("a symlinked root is matched via realpath, not its lexical path", async () => {
    const { base, root } = await makeLandscape();
    const linkRoot = path.join(base, "project-link");
    const linked = await trySymlink(root, linkRoot);
    if (!linked) {
      throw new Error("SYMLINK UNAVAILABLE: cannot symlink the root in this environment.");
    }
    const sandbox = new LocalSandbox(linkRoot);

    await sandbox.writeFile("via-link.txt", "ok");
    expect(await fs.readFile(path.join(root, "via-link.txt"), "utf-8")).toBe("ok");
    expect(await sandbox.readFile(path.join(linkRoot, "via-link.txt"))).toBe("ok");

    await fs.rm(base, { recursive: true, force: true });
  });
});
