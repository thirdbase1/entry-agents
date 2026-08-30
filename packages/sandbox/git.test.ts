import { describe, expect, test } from "bun:test";
import type { ExecResult, Sandbox } from "./interface";
import { syncToRemotePreservingChanges } from "./git";

const fetchFeatureCommand =
  "GIT_TERMINAL_PROMPT=0 git fetch --force origin feature:refs/remotes/origin/feature";
const getOriginUrlCommand = "git remote get-url origin";
const remoteUrl = "https://github.com/octo/repo.git";
const trackRemoteCommand = "git config branch.feature.remote origin";
const trackMergeCommand = "git config branch.feature.merge refs/heads/feature";

function result(params: Partial<ExecResult> = {}): ExecResult {
  return {
    success: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
    ...params,
  };
}

function createSandbox(results: ExecResult[]): Sandbox {
  const commands: string[] = [];

  return {
    type: "cloud",
    workingDirectory: "/repo",
    exec: async (command) => {
      commands.push(command);
      return results.shift() ?? result();
    },
    readFile: async () => "",
    writeFile: async () => {},
    readFileBuffer: async () => Buffer.from(""),
    writeFileBuffer: async () => {},
    access: async () => {},
    stat: async () => ({
      isDirectory: () => false,
      isFile: () => true,
      size: 0,
      mtimeMs: 0,
    }),
    mkdir: async () => {},
    readdir: async () => [],
    exists: async () => true,
    stop: async () => {},
    commands,
  } as Sandbox & { commands: string[] };
}

describe("syncToRemotePreservingChanges", () => {
  test("stashes local changes, resets to remote, and restores changes", async () => {
    const sandbox = createSandbox([
      result({ stdout: "https://github.com/octo/repo.git\n" }),
      result(),
      result({ stdout: " M file.ts\n" }),
      result({ stdout: "original-head\n" }),
      result(),
      result(),
      result(),
      result(),
    ]) as Sandbox & { commands: string[] };

    await syncToRemotePreservingChanges(sandbox, "feature", remoteUrl);

    expect(sandbox.commands).toEqual([
      getOriginUrlCommand,
      fetchFeatureCommand,
      "git status --porcelain",
      "git rev-parse HEAD",
      "git stash push --include-untracked -m open-agents-pre-commit-sync",
      "git reset --hard origin/feature",
      trackRemoteCommand,
      trackMergeCommand,
      "git stash pop",
    ]);
  });

  test("re-adds a missing origin remote before fetching (self-heal after a broken restore)", async () => {
    const sandbox = createSandbox([
      result({ success: false, exitCode: 2, stderr: "" }),
      result(),
      result(),
      result({ stdout: " M file.ts\n" }),
      result({ stdout: "original-head\n" }),
      result(),
      result(),
      result(),
      result(),
    ]) as Sandbox & { commands: string[] };

    await syncToRemotePreservingChanges(sandbox, "feature", remoteUrl);

    expect(sandbox.commands).toEqual([
      getOriginUrlCommand,
      `git remote add origin '${remoteUrl}'`,
      fetchFeatureCommand,
      "git status --porcelain",
      "git rev-parse HEAD",
      "git stash push --include-untracked -m open-agents-pre-commit-sync",
      "git reset --hard origin/feature",
      trackRemoteCommand,
      trackMergeCommand,
      "git stash pop",
    ]);
  });

  test("returns without touching local changes when the remote branch is missing", async () => {
    const sandbox = createSandbox([
      result({ stdout: "https://github.com/octo/repo.git\n" }),
      result({
        success: false,
        exitCode: 128,
        stderr: "fatal: couldn't find remote ref feature\n",
      }),
    ]) as Sandbox & { commands: string[] };

    await syncToRemotePreservingChanges(sandbox, "feature", remoteUrl);

    expect(sandbox.commands).toEqual([
      getOriginUrlCommand,
      fetchFeatureCommand,
    ]);
  });

  test("rolls back and restores local changes when stash restore conflicts after sync", async () => {
    const sandbox = createSandbox([
      result({ stdout: "https://github.com/octo/repo.git\n" }),
      result(),
      result({ stdout: " M file.ts\n" }),
      result({ stdout: "original-head\n" }),
      result(),
      result(),
      result(),
      result(),
      result({
        success: false,
        exitCode: 1,
        stderr: "CONFLICT (content): Merge conflict in file.ts\n",
      }),
      result(),
      result(),
      result(),
    ]) as Sandbox & { commands: string[] };

    await expect(
      syncToRemotePreservingChanges(sandbox, "feature", remoteUrl),
    ).rejects.toThrow(
      "Failed to restore local changes after syncing remote branch",
    );

    expect(sandbox.commands).toEqual([
      getOriginUrlCommand,
      fetchFeatureCommand,
      "git status --porcelain",
      "git rev-parse HEAD",
      "git stash push --include-untracked -m open-agents-pre-commit-sync",
      "git reset --hard origin/feature",
      trackRemoteCommand,
      trackMergeCommand,
      "git stash pop",
      "git reset --hard original-head",
      "git clean -fd",
      "git stash pop",
    ]);
  });

  test("treats tracking-config persistence as best-effort (2026-08-30 regression)", async () => {
    // Found 2026-08-30 in production: the old `git branch
    // --set-upstream-to=origin/o/... o/...` step fatals with "starting
    // point ... is not a branch" right after a successful fetch+reset,
    // which aborted the whole pre-commit sync AND stranded the user's
    // stashed local changes. Tracking config is cosmetic for the commit
    // flow, so a failure here must never block the sync or the stash pop.
    const sandbox = createSandbox([
      result({ stdout: "https://github.com/octo/repo.git\n" }),
      result(),
      result({ stdout: " M file.ts\n" }),
      result({ stdout: "original-head\n" }),
      result(),
      result(),
      result({
        success: false,
        exitCode: 128,
        stderr:
          "fatal: cannot set up tracking information; starting point 'origin/feature' is not a branch",
      }),
      result(),
      result(),
    ]) as Sandbox & { commands: string[] };

    await syncToRemotePreservingChanges(sandbox, "feature", remoteUrl);

    expect(sandbox.commands).toEqual([
      getOriginUrlCommand,
      fetchFeatureCommand,
      "git status --porcelain",
      "git rev-parse HEAD",
      "git stash push --include-untracked -m open-agents-pre-commit-sync",
      "git reset --hard origin/feature",
      trackRemoteCommand,
      trackMergeCommand,
      "git stash pop",
    ]);
  });
});
