import type { ExecResult, Sandbox } from "./interface.ts";

// ---- types ----

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  path: string;
  status: FileChangeStatus;
  /** original path for renamed files */
  oldPath?: string;
}

export interface FileWithContent extends FileChange {
  content: string;
  encoding: "utf-8" | "base64";
}

function isSafeBranchName(branch: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock")
  );
}

// ---- helpers ----

function exec(
  sandbox: Sandbox,
  command: string,
  timeoutMs = 30000,
): Promise<ExecResult> {
  return sandbox.exec(command, sandbox.workingDirectory, timeoutMs);
}

function commandOutput(result: ExecResult): string {
  return result.stderr?.trim() || result.stdout?.trim() || "Git command failed";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isMissingRemoteRef(result: ExecResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return output.includes("couldn't find remote ref");
}

/**
 * Ensures the sandbox's `origin` remote is configured, re-adding it from
 * `remoteUrl` if missing.
 *
 * Root-caused a real production failure (2026-08-17): a resumed/restored
 * sandbox can come back with a `.git` directory that has no `origin`
 * remote configured at all -- e.g. a hibernate/restore snapshot taken
 * before the repo was linked, or any other path that leaves `.git`
 * without its remote config. `git fetch origin` then fails immediately
 * with the confusing "'origin' does not appear to be a git repository"
 * error, permanently blocking every future commit for that session even
 * though the actual repo and credentials are fine. Self-healing here
 * closes that failure mode instead of surfacing a dead-end error to the
 * user every time they try to commit.
 */
async function ensureOriginRemote(
  sandbox: Sandbox,
  remoteUrl: string,
): Promise<void> {
  const getUrlResult = await exec(sandbox, "git remote get-url origin", 10000);
  if (getUrlResult.success && getUrlResult.stdout.trim().length > 0) {
    return;
  }

  const addResult = await exec(
    sandbox,
    `git remote add origin ${shellQuote(remoteUrl)}`,
    10000,
  );
  if (!addResult.success) {
    throw new Error(
      `Failed to configure missing origin remote: ${commandOutput(addResult)}`,
    );
  }
}

async function fetchRemoteBranch(
  sandbox: Sandbox,
  branch: string,
): Promise<"fetched" | "missing"> {
  const fetchResult = await exec(
    sandbox,
    `GIT_TERMINAL_PROMPT=0 git fetch --force origin ${branch}:refs/remotes/origin/${branch}`,
    30000,
  );

  if (fetchResult.success) {
    return "fetched";
  }

  if (isMissingRemoteRef(fetchResult)) {
    return "missing";
  }

  throw new Error(
    `Failed to fetch remote branch: ${commandOutput(fetchResult)}`,
  );
}

async function resetToFetchedRemoteBranch(
  sandbox: Sandbox,
  branch: string,
): Promise<void> {
  const resetResult = await exec(
    sandbox,
    `git reset --hard origin/${branch}`,
    10000,
  );
  if (!resetResult.success) {
    throw new Error(
      `Failed to reset to remote branch: ${commandOutput(resetResult)}`,
    );
  }

  // Tracking config is written directly via `git config` instead of
  // `git branch --set-upstream-to`. Found 2026-08-30 in production:
  // set-upstream-to fatals with "cannot set up tracking information;
  // starting point 'origin/o/...' is not a branch" right after a
  // *successful* fetch+reset in real sessions, and because that fatal
  // fired after the stash/reset sequence in syncToRemotePreservingChanges,
  // it also stranded the user's stashed local changes in the stash. The
  // two config keys below are exactly what set-upstream-to persists
  // under the hood, involve no ref resolution, and are best-effort
  // anyway: missing tracking config is cosmetic for the commit flow
  // (the actual sync is the reset --hard above), so it must never block
  // a commit.
  const remoteConfigResult = await exec(
    sandbox,
    `git config branch.${branch}.remote origin`,
    10000,
  );
  const mergeConfigResult = await exec(
    sandbox,
    `git config branch.${branch}.merge refs/heads/${branch}`,
    10000,
  );
  if (!remoteConfigResult.success || !mergeConfigResult.success) {
    console.warn(
      `[sandbox] Could not persist tracking config for branch "${branch}" ` +
        "(non-fatal) -- " +
        commandOutput(
          remoteConfigResult.success ? mergeConfigResult : remoteConfigResult,
        ),
    );
  }
}

async function getCurrentHead(sandbox: Sandbox): Promise<string> {
  const headResult = await exec(sandbox, "git rev-parse HEAD", 10000);
  if (!headResult.success) {
    throw new Error(
      `Failed to inspect current HEAD: ${commandOutput(headResult)}`,
    );
  }

  return headResult.stdout.trim();
}

async function resetToCommit(sandbox: Sandbox, commit: string): Promise<void> {
  const resetResult = await exec(sandbox, `git reset --hard ${commit}`, 10000);
  if (!resetResult.success) {
    throw new Error(
      `Failed to restore original HEAD after sync failure: ${commandOutput(resetResult)}`,
    );
  }

  const cleanResult = await exec(sandbox, "git clean -fd", 10000);
  if (!cleanResult.success) {
    throw new Error(
      `Failed to clean worktree after sync failure: ${commandOutput(cleanResult)}`,
    );
  }
}

// ---- public functions ----

/**
 * Check whether the sandbox has uncommitted changes.
 */
export async function hasUncommittedChanges(
  sandbox: Sandbox,
): Promise<boolean> {
  const result = await exec(sandbox, "git status --porcelain", 10000);
  return result.success && result.stdout.trim().length > 0;
}

/**
 * Remove any embedded `.git` directories nested inside the working tree
 * (excluding the repo's own top-level `.git`) before staging.
 *
 * If left in place, `git add -A` records a nested `.git` directory's parent
 * as a gitlink (tree mode 160000, i.e. a submodule reference) instead of
 * walking into its files. This commonly happens by accident -- e.g. a
 * template, vendored package, or `git clone` performed inside the repo
 * without cleaning up its own `.git` folder. A gitlink can't be committed
 * through GitHub's contents/tree API (there's no real submodule to point
 * at), so without this cleanup the *entire* commit fails with an opaque
 * "Unsupported git file mode '160000'" error -- even when the nested `.git`
 * folder is unrelated to the actual change being committed. Stripping it
 * here means the directory's real files just get tracked normally instead.
 */
async function stripNestedGitDirectories(sandbox: Sandbox): Promise<void> {
  const result = await exec(
    sandbox,
    "find . -mindepth 2 -type d -name .git -prune -print0 | xargs -0 -r rm -rf --",
    15000,
  );
  if (!result.success) {
    throw new Error(
      `Failed to clean up nested .git directories: ${commandOutput(result)}`,
    );
  }
}

/**
 * Stage all changes in the sandbox working directory.
 */
export async function stageAll(sandbox: Sandbox): Promise<void> {
  await stripNestedGitDirectories(sandbox);

  const result = await exec(sandbox, "git add -A", 10000);
  if (!result.success) {
    throw new Error(`Failed to stage changes: ${result.stdout}`);
  }
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(sandbox: Sandbox): Promise<string> {
  const result = await exec(sandbox, "git symbolic-ref --short HEAD", 5000);
  return result.stdout.trim() || "HEAD";
}

/**
 * Get the HEAD commit SHA.
 */
export async function getHeadSha(sandbox: Sandbox): Promise<string> {
  const result = await exec(sandbox, "git rev-parse HEAD", 5000);
  return result.stdout.trim();
}

/**
 * Get the staged diff (for commit message generation).
 */
export async function getStagedDiff(sandbox: Sandbox): Promise<string> {
  const result = await exec(sandbox, "git diff --cached", 30000);
  return result.stdout;
}

/**
 * Parse the staged changes into a list of file changes.
 * Uses NUL separators for reliable filename parsing.
 */
export async function getChangedFiles(sandbox: Sandbox): Promise<FileChange[]> {
  const result = await exec(
    sandbox,
    "git diff --cached --name-status -z HEAD",
    15000,
  );

  if (!result.success || !result.stdout.trim()) {
    return [];
  }

  const changes: FileChange[] = [];
  const parts = result.stdout.split("\0").filter(Boolean);

  let i = 0;
  while (i < parts.length) {
    const statusField = parts[i];
    if (!statusField) break;

    const statusChar = statusField[0];

    if (statusChar === "R" || statusChar === "C") {
      // renamed/copied: status, old path, new path
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      if (oldPath && newPath) {
        changes.push({
          path: newPath,
          status: "renamed",
          oldPath,
        });
      }
      i += 3;
    } else {
      const path = parts[i + 1];
      if (path) {
        let status: FileChangeStatus;
        if (statusChar === "A") {
          status = "added";
        } else if (statusChar === "D") {
          status = "deleted";
        } else {
          status = "modified";
        }
        changes.push({ path, status });
      }
      i += 2;
    }
  }

  return changes;
}

/**
 * Detect which files are binary using git's numstat output.
 * Binary files show "-" for both additions and deletions.
 */
export async function detectBinaryFiles(
  sandbox: Sandbox,
): Promise<Set<string>> {
  const result = await exec(
    sandbox,
    "git diff --cached --numstat -z HEAD",
    15000,
  );

  const binaryPaths = new Set<string>();
  if (!result.success || !result.stdout.trim()) {
    return binaryPaths;
  }

  // numstat with -z: "additions\tdeletions\tpath\0"
  // binary files show: "-\t-\tpath\0"
  const lines = result.stdout.split("\0").filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("-\t-\t")) {
      const path = line.slice(4);
      if (path) {
        binaryPaths.add(path);
      }
    }
  }

  return binaryPaths;
}

/**
 * Read the contents of changed files from the sandbox.
 * Binary files are read as base64, text files as utf-8.
 * Deleted files are excluded (no content to read).
 */
export async function readFileContents(
  sandbox: Sandbox,
  changes: FileChange[],
): Promise<FileWithContent[]> {
  const binaryFiles = await detectBinaryFiles(sandbox);
  const cwd = sandbox.workingDirectory;

  const results: FileWithContent[] = [];

  for (const change of changes) {
    if (change.status === "deleted") {
      results.push({ ...change, content: "", encoding: "utf-8" });
      continue;
    }

    const fullPath = `${cwd}/${change.path}`;

    if (binaryFiles.has(change.path)) {
      const buffer = await sandbox.readFileBuffer(fullPath);
      results.push({
        ...change,
        content: buffer.toString("base64"),
        encoding: "base64",
      });
    } else {
      const content = await sandbox.readFile(fullPath, "utf-8");
      results.push({ ...change, content, encoding: "utf-8" });
    }
  }

  return results;
}

/**
 * Read a symlink's target from the git index (stage 0), i.e. what will
 * actually be committed as the blob content for a mode-120000 tree entry.
 * Reading from the index rather than the filesystem keeps this in sync
 * with whatever is staged, even if the working tree symlink changes again
 * before the commit is built.
 */
export async function getSymlinkTarget(
  sandbox: Sandbox,
  path: string,
): Promise<string> {
  const result = await exec(
    sandbox,
    `git cat-file -p :${shellQuote(path)}`,
    10000,
  );
  if (!result.success) {
    throw new Error(
      `Failed to read symlink target for '${path}': ${commandOutput(result)}`,
    );
  }
  return result.stdout.trim();
}

/**
 * Get file modes from the staging area (handles executable files).
 * Returns a map of path → mode string (e.g. "100644", "100755").
 */
export async function getFileModes(
  sandbox: Sandbox,
): Promise<Map<string, string>> {
  const result = await exec(sandbox, "git ls-files --stage", 15000);

  const modes = new Map<string, string>();
  if (!result.success) return modes;

  for (const line of result.stdout.split("\n")) {
    // format: "mode sha stage\tpath"
    const match = line.match(/^(\d+)\s+\S+\s+\d+\t(.+)$/);
    if (match && match[1] && match[2]) {
      modes.set(match[2], match[1]);
    }
  }

  return modes;
}

/**
 * Sync the sandbox working tree to match the remote branch.
 * Call this after creating a commit via the GitHub API.
 */
export async function syncToRemote(
  sandbox: Sandbox,
  branch: string,
  remoteUrl: string,
): Promise<void> {
  if (!isSafeBranchName(branch)) {
    throw new Error("Invalid branch name");
  }

  await ensureOriginRemote(sandbox, remoteUrl);

  const fetchStatus = await fetchRemoteBranch(sandbox, branch);
  if (fetchStatus === "missing") {
    throw new Error(`Remote branch '${branch}' not found`);
  }

  await resetToFetchedRemoteBranch(sandbox, branch);
}

/**
 * Refresh the sandbox branch from remote before building an API commit.
 * Local edits are stashed and restored so commits are based on the latest
 * remote head even when a previous broker-created commit was not synced back.
 */
export async function syncToRemotePreservingChanges(
  sandbox: Sandbox,
  branch: string,
  remoteUrl: string,
): Promise<void> {
  if (!isSafeBranchName(branch)) {
    throw new Error("Invalid branch name");
  }

  await ensureOriginRemote(sandbox, remoteUrl);

  const fetchStatus = await fetchRemoteBranch(sandbox, branch);
  if (fetchStatus === "missing") {
    return;
  }

  const statusResult = await exec(sandbox, "git status --porcelain", 10000);
  if (!statusResult.success) {
    throw new Error(
      `Failed to inspect local changes: ${commandOutput(statusResult)}`,
    );
  }

  const hasLocalChanges = statusResult.stdout.trim().length > 0;
  if (!hasLocalChanges) {
    await resetToFetchedRemoteBranch(sandbox, branch);
    return;
  }

  const originalHead = await getCurrentHead(sandbox);

  const stashResult = await exec(
    sandbox,
    "git stash push --include-untracked -m open-agents-pre-commit-sync",
    30000,
  );
  if (!stashResult.success) {
    throw new Error(
      `Failed to stash local changes: ${commandOutput(stashResult)}`,
    );
  }

  try {
    await resetToFetchedRemoteBranch(sandbox, branch);
  } catch (error) {
    await resetToCommit(sandbox, originalHead);
    await exec(sandbox, "git stash pop", 30000).catch(() => {});
    throw error;
  }

  const popResult = await exec(sandbox, "git stash pop", 30000);
  if (!popResult.success) {
    await resetToCommit(sandbox, originalHead);
    const restoreResult = await exec(sandbox, "git stash pop", 30000);
    if (!restoreResult.success) {
      throw new Error(
        `Failed to restore local changes after rolling back sync failure: ${commandOutput(restoreResult)}`,
      );
    }

    throw new Error(
      `Failed to restore local changes after syncing remote branch: ${commandOutput(popResult)}`,
    );
  }
}

export async function withTemporaryGitHubAuth<T>(
  sandbox: Sandbox,
  token: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!token) {
    return operation();
  }

  if (!sandbox.setGitHubAuthToken) {
    throw new Error("Sandbox does not support temporary GitHub auth");
  }

  await sandbox.setGitHubAuthToken(token);
  try {
    return await operation();
  } finally {
    await sandbox.setGitHubAuthToken(undefined);
  }
}
