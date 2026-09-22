import { describe, expect, test } from "bun:test";

import type { Sandbox } from "./interface.ts";
import {
  packWorkspacePayload,
  restoreWorkspacePayload,
} from "./migrate.ts";

/**
 * Regression tests for the pack/restore round-trip.
 *
 * The bug these cover failed migration 45 times in a row in production:
 * a session whose workspace is a git repo with ZERO commits hits
 * `git bundle create --all`, which refuses outright with "Refusing to
 * create empty bundle", and that throw aborted the whole migration.
 *
 * A second, quieter bug was sitting behind it: the packer used
 * `git ls-files --others` to collect files to tar, and that command
 * returns nothing for work the user STAGED but never committed -- so
 * that work was silently dropped even without the crash.
 */

interface FakeSandboxOptions {
  /** Fail `git bundle create --all` the way an empty repo does. */
  emptyRepo?: boolean;
  /** Files present on the (simulated) filesystem. */
  files?: Record<string, string>;
}

function createFakeSandbox(options: FakeSandboxOptions = {}): {
  sandbox: Sandbox;
  execs: string[];
  written: Record<string, string>;
} {
  const { emptyRepo = false, files = {} } = options;
  const execs: string[] = [];
  const written: Record<string, string> = {};
  const cwd = "/workspace";

  const sandbox = {
    workingDirectory: cwd,
    async exec(command: string) {
      execs.push(command);

      if (command === "git rev-parse --is-inside-work-tree 2>/dev/null || echo no") {
        return { success: true, stdout: "true\n", stderr: "", exitCode: 0 };
      }

      // The commit probe introduced by the fix.
      if (command === "git rev-parse --verify HEAD") {
        return emptyRepo
          ? { success: false, stdout: "", stderr: "fatal: Needed a single revision\n", exitCode: 128 }
          : { success: true, stdout: "abc123\n", stderr: "", exitCode: 0 };
      }

      if (command.startsWith("git bundle create")) {
        // Real git refuses this on a repo with no commits.
        if (emptyRepo) {
          return {
            success: false,
            stdout: "",
            stderr: "fatal: Refusing to create empty bundle.\n",
            exitCode: 1,
          };
        }
        return { success: true, stdout: "", stderr: "", exitCode: 0 };
      }

      if (command === "git diff HEAD" || command === "git diff --cached") {
        if (emptyRepo && command === "git diff HEAD") {
          return {
            success: false,
            stdout: "",
            stderr: "fatal: ambiguous argument 'HEAD'\n",
            exitCode: 128,
          };
        }
        return { success: true, stdout: "", stderr: "", exitCode: 0 };
      }

      if (command.includes("ls-files")) {
        if (command.includes("--others") && !command.includes("--cached")) {
          return { success: true, stdout: "", stderr: "", exitCode: 0 };
        }
        // --cached --others
        return { success: true, stdout: "", stderr: "", exitCode: 0 };
      }

      if (command.startsWith("git init")) {
        return { success: true, stdout: "", stderr: "", exitCode: 0 };
      }

      return { success: true, stdout: "", stderr: "", exitCode: 0 };
    },
    async readFileBuffer() {
      return Buffer.from("");
    },
    async readFile() {
      return "";
    },
    async writeFile(path: string, content: string) {
      written[path] = content;
    },
    async writeFileBuffer() {},
    async mkdir() {},
    async readdir() {
      return [];
    },
  } as unknown as Sandbox;

  void files;
  return { sandbox, execs, written };
}

describe("packWorkspacePayload", () => {
  test("an empty repo no longer throws during migration", async () => {
    // THE regression: this used to be the 45-failure crash.
    const { sandbox } = createFakeSandbox({ emptyRepo: true });

    const payload = await packWorkspacePayload(sandbox);

    expect(payload.kind).toBe("git");
  });

  test("an empty repo signals 'no bundle' so the destination re-inits", async () => {
    const { sandbox } = createFakeSandbox({ emptyRepo: true });

    const payload = await packWorkspacePayload(sandbox);

    expect(payload.kind).toBe("git");
    if (payload.kind !== "git") return;
    expect(payload.bundleBase64).toBeNull();
  });

  test("an empty repo never runs the bundle command that git refuses", async () => {
    const { sandbox, execs } = createFakeSandbox({ emptyRepo: true });

    await packWorkspacePayload(sandbox);

    expect(execs.some((c) => c.startsWith("git bundle create"))).toBe(false);
  });

  test("an empty repo uses `git diff --cached`, not `git diff HEAD`", async () => {
    const { sandbox, execs } = createFakeSandbox({ emptyRepo: true });

    await packWorkspacePayload(sandbox);

    expect(execs).toContain("git diff --cached");
    expect(execs).not.toContain("git diff HEAD");
  });

  test("a repo with commits still bundles exactly as before", async () => {
    const { sandbox, execs } = createFakeSandbox({ emptyRepo: false });

    const payload = await packWorkspacePayload(sandbox);

    expect(execs.some((c) => c.startsWith("git bundle create"))).toBe(true);
    expect(execs).toContain("git diff HEAD");
    expect(payload.kind).toBe("git");
    if (payload.kind !== "git") return;
    expect(typeof payload.bundleBase64).toBe("string");
  });

  test("the untracked list is never widened to --cached (no double restore)", async () => {
    // Staged files are already carried by `git diff --cached`; including
    // them in the tarball too would restore them twice and let the tar
    // silently win on any disagreement.
    for (const emptyRepo of [true, false]) {
      const { sandbox, execs } = createFakeSandbox({ emptyRepo });
      await packWorkspacePayload(sandbox);
      const lists = execs.filter((c) => c.includes("ls-files"));
      for (const cmd of lists) {
        expect(cmd).not.toContain("--cached");
      }
    }
  });
});

describe("restoreWorkspacePayload", () => {
  test("a null bundle re-inits instead of cloning", async () => {
    const { sandbox, execs } = createFakeSandbox({});

    await restoreWorkspacePayload(sandbox, {
      kind: "git",
      bundleBase64: null,
      diffText: "",
      untrackedTarBase64: null,
    });

    expect(execs).toContain("git init");
    expect(execs.some((c) => c.includes("git clone"))).toBe(false);
  });

  test("a real bundle still clones", async () => {
    const { sandbox, execs } = createFakeSandbox({});

    await restoreWorkspacePayload(sandbox, {
      kind: "git",
      bundleBase64: "AAAA",
      diffText: "",
      untrackedTarBase64: null,
    });

    expect(execs.some((c) => c.includes("git clone"))).toBe(true);
    expect(execs).not.toContain("git init");
  });

  test("a git init failure is reported, not swallowed", async () => {
    const { sandbox } = createFakeSandbox({});
    const original = sandbox.exec.bind(sandbox);
    (sandbox as unknown as { exec: unknown }).exec = async (
      command: string,
      ...rest: unknown[]
    ) => {
      if (command === "git init") {
        return { success: false, stdout: "", stderr: "permission denied", exitCode: 1 };
      }
      return original(command, ...(rest as []));
    };

    await expect(
      restoreWorkspacePayload(sandbox, {
        kind: "git",
        bundleBase64: null,
        diffText: "",
        untrackedTarBase64: null,
      }),
    ).rejects.toThrow(/initialise git repo/);
  });
});
