import { describe, expect, it } from "bun:test";
import type { Sandbox } from "@open-agents/sandbox";
import { ensureUploadsGitignored } from "./uploads-gitignore";

/**
 * Minimal in-memory Sandbox stub -- only implements the two methods
 * ensureUploadsGitignored actually touches (readFile/writeFile). Anything
 * else throws if called, so a test would fail loudly instead of silently
 * doing the wrong thing.
 */
function createFakeSandbox(initialGitignore?: string): {
  sandbox: Sandbox;
  getGitignore: () => string | undefined;
} {
  let gitignore = initialGitignore;

  const sandbox = {
    async readFile(path: string) {
      if (path !== ".gitignore" || gitignore === undefined) {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      return gitignore;
    },
    async writeFile(path: string, content: string) {
      if (path !== ".gitignore") {
        throw new Error(`unexpected writeFile path: ${path}`);
      }
      gitignore = content;
    },
  } as unknown as Sandbox;

  return { sandbox, getGitignore: () => gitignore };
}

describe("ensureUploadsGitignored", () => {
  it("creates .gitignore with a root-anchored /uploads/ entry when none exists", async () => {
    const { sandbox, getGitignore } = createFakeSandbox(undefined);

    await ensureUploadsGitignored(sandbox);

    const result = getGitignore();
    expect(result).toContain("/uploads/");
  });

  it("appends the entry to an existing .gitignore without touching prior content", async () => {
    const { sandbox, getGitignore } = createFakeSandbox(
      "node_modules/\n.env\n",
    );

    await ensureUploadsGitignored(sandbox);

    const result = getGitignore();
    expect(result).toContain("node_modules/");
    expect(result).toContain(".env");
    expect(result).toContain("/uploads/");
  });

  it("is idempotent -- does not duplicate the entry if already present", async () => {
    const { sandbox, getGitignore } = createFakeSandbox(
      "node_modules/\n/uploads/\n",
    );

    await ensureUploadsGitignored(sandbox);

    const result = getGitignore() ?? "";
    const occurrences = result
      .split("\n")
      .filter((line) => line.trim() === "/uploads/").length;
    expect(occurrences).toBe(1);
  });

  it("also recognizes a pre-existing non-root-anchored 'uploads/' entry as already covered", async () => {
    const { sandbox, getGitignore } = createFakeSandbox("uploads/\n");
    const before = getGitignore();

    await ensureUploadsGitignored(sandbox);

    // Should not have added a second, redundant entry.
    expect(getGitignore()).toBe(before);
  });
});
