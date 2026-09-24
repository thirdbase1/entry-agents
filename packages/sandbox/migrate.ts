import type { Sandbox } from "./interface.ts";

/**
 * Transferable snapshot of a sandbox's workspace, produced by
 * packWorkspacePayload() and consumed by restoreWorkspacePayload() to move
 * a session's files from one (expiring) sandbox into a brand-new one.
 *
 * Two shapes, matching how the workspace was detected:
 * - "git": the workspace is a git repo. We transfer full history via a
 *   git bundle (works with no remote/network access needed on the
 *   destination), plus the uncommitted diff and untracked files
 *   separately, since a bundle only captures committed history.
 *   bundleBase64 is null when the repo has NO COMMITS AT ALL -- a bundle
 *   is impossible then, so the destination re-inits instead of cloning.
 *   Not a rare edge case: a brand-new session's repo is exactly this
 *   until its first commit.
 * - "plain": no git repo (e.g. a scratch/chat sandbox). We transfer a
 *   full tarball of the workspace, excluding regenerable junk
 *   (node_modules, build output, etc.) to keep the payload small.
 */
export type WorkspacePayload =
  | {
      kind: "git";
      /** Null when the source repo has no commits -- nothing to bundle. */
      bundleBase64: string | null;
      diffText: string;
      untrackedTarBase64: string | null;
    }
  | {
      kind: "plain";
      fullTarBase64: string;
    };

const BUNDLE_PATH = "/tmp/.sandbox-migrate-bundle.git";
const DIFF_PATH = "/tmp/.sandbox-migrate-diff.patch";
const UNTRACKED_TAR_PATH = "/tmp/.sandbox-migrate-untracked.tar.gz";
const FULL_TAR_PATH = "/tmp/.sandbox-migrate-full.tar.gz";
const PACK_TIMEOUT_MS = 60_000;

/** Directories/files that are safe to skip -- regenerable, not user data. */
const PLAIN_TAR_EXCLUDES = [
  "node_modules",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".git",
];

async function isGitRepo(sandbox: Sandbox): Promise<boolean> {
  const result = await sandbox.exec(
    "git rev-parse --is-inside-work-tree 2>/dev/null || echo no",
    sandbox.workingDirectory,
    PACK_TIMEOUT_MS,
  );
  return result.stdout.trim() === "true";
}

/**
 * Does this repo have at least one commit?
 *
 * A freshly-created session's workspace is a git repo with ZERO commits
 * until the first commit lands, and that state breaks three separate
 * commands this packer used to run unconditionally (all verified against
 * a real empty repo):
 *   git bundle create --all   -> "fatal: Refusing to create empty bundle"
 *   git diff HEAD             -> "fatal: ambiguous argument 'HEAD'"
 *   git ls-files --others     -> returns NOTHING for staged files
 * The first one is what failed migration 45 times in a row in
 * production; the third is a silent data-loss bug on top of it, since
 * work the user staged but never committed was simply never carried
 * over. Probe first and take the no-commit path when that is the case.
 */
async function hasCommits(sandbox: Sandbox): Promise<boolean> {
  const result = await sandbox.exec(
    "git rev-parse --verify HEAD",
    sandbox.workingDirectory,
    PACK_TIMEOUT_MS,
  );
  return result.success;
}

async function packGitWorkspace(
  sandbox: Sandbox,
): Promise<WorkspacePayload & { kind: "git" }> {
  const cwd = sandbox.workingDirectory;

  const repoHasCommits = await hasCommits(sandbox);

  // No commits yet: there is no history to bundle, so git refuses the
  // command outright. Carry the files instead and let the destination
  // re-init an empty repo. bundleBase64 null is the signal for that.
  let bundleBase64: string | null = null;
  if (repoHasCommits) {
    const bundleResult = await sandbox.exec(
      `git bundle create ${BUNDLE_PATH} --all`,
      cwd,
      PACK_TIMEOUT_MS,
    );
    if (!bundleResult.success) {
      throw new Error(`Failed to create git bundle: ${bundleResult.stderr}`);
    }
    bundleBase64 = (await sandbox.readFileBuffer(BUNDLE_PATH)).toString(
      "base64",
    );
  }

  // `git diff HEAD` needs a HEAD, which a no-commit repo does not have.
  // `--cached` diffs the index against the empty tree, which is exactly
  // the staged-not-yet-committed work we would otherwise drop.
  const diffCommand = repoHasCommits ? "git diff HEAD" : "git diff --cached";
  const diffResult = await sandbox.exec(diffCommand, cwd, PACK_TIMEOUT_MS);
  const diffText = diffResult.stdout;

  // Stays `--others` even in the no-commit case: the staged files are
  // already carried by diffText above (git diff --cached), so adding
  // --cached here would restore them a second time from the tarball
  // and any disagreement between the two would silently let the tar win.
  const untrackedList = await sandbox.exec(
    "git ls-files --others --exclude-standard",
    cwd,
    PACK_TIMEOUT_MS,
  );
  let untrackedTarBase64: string | null = null;
  if (untrackedList.stdout.trim().length > 0) {
    const tarResult = await sandbox.exec(
      `git ls-files --others --exclude-standard | tar -czf ${UNTRACKED_TAR_PATH} -T -`,
      cwd,
      PACK_TIMEOUT_MS,
    );
    if (tarResult.success) {
      untrackedTarBase64 = (
        await sandbox.readFileBuffer(UNTRACKED_TAR_PATH)
      ).toString("base64");
    }
  }

  return { kind: "git", bundleBase64, diffText, untrackedTarBase64 };
}
async function packPlainWorkspace(
  sandbox: Sandbox,
): Promise<WorkspacePayload & { kind: "plain" }> {
  const cwd = sandbox.workingDirectory;
  const excludeArgs = PLAIN_TAR_EXCLUDES.map((p) => `--exclude=${p}`).join(" ");
  const tarResult = await sandbox.exec(
    `tar ${excludeArgs} -czf ${FULL_TAR_PATH} .`,
    cwd,
    PACK_TIMEOUT_MS,
  );
  if (!tarResult.success) {
    throw new Error(`Failed to tar workspace: ${tarResult.stderr}`);
  }
  const fullTarBase64 = (await sandbox.readFileBuffer(FULL_TAR_PATH)).toString(
    "base64",
  );
  return { kind: "plain", fullTarBase64 };
}

/**
 * Snapshot the current sandbox's workspace into a transferable payload.
 * Safe to call on a sandbox that's about to be killed/migrated -- doesn't
 * mutate anything outside /tmp.
 */
export async function packWorkspacePayload(
  sandbox: Sandbox,
): Promise<WorkspacePayload> {
  return (await isGitRepo(sandbox))
    ? packGitWorkspace(sandbox)
    : packPlainWorkspace(sandbox);
}

/**
 * Restore a payload produced by packWorkspacePayload() into a fresh
 * sandbox's (empty) workspace.
 */
export async function restoreWorkspacePayload(
  sandbox: Sandbox,
  payload: WorkspacePayload,
): Promise<void> {
  const cwd = sandbox.workingDirectory;

  if (payload.kind === "git") {
    if (payload.bundleBase64 !== null) {
      await sandbox.writeFileBuffer(
        BUNDLE_PATH,
        Buffer.from(payload.bundleBase64, "base64"),
      );

      // `git clone <bundle> .` refuses a destination that already has
      // entries. The target workspace is normally empty, but a base
      // snapshot can leave files behind (and it is not a git repo), so
      // the very first restore already hit "destination path '.' already
      // exists and is not an empty directory" and failed the migration.
      // Clone into a scratch dir and merge in when `.` is not empty,
      // instead of failing.
      const emptyCheck = await sandbox.exec(
        '[ -z "$(ls -A)" ]',
        cwd,
        PACK_TIMEOUT_MS,
      );
      const scratch = "/tmp/entry-ws-restore";
      const cloneCommand = emptyCheck.success
        ? `git clone ${BUNDLE_PATH} .`
        : `rm -rf ${scratch} && git clone ${BUNDLE_PATH} ${scratch} && ` +
          `cp -a ${scratch}/. . && rm -rf ${scratch}`;

      const cloneResult = await sandbox.exec(
        cloneCommand,
        cwd,
        PACK_TIMEOUT_MS,
      );
      if (!cloneResult.success) {
        throw new Error(
          `Failed to restore git bundle into new sandbox: ${cloneResult.stderr}`,
        );
      }
    } else {
      // No bundle because the source repo had no commits. There is
      // nothing to clone, so stand up an empty repo for the files and
      // diff below to land in.
      const initResult = await sandbox.exec("git init", cwd, PACK_TIMEOUT_MS);
      if (!initResult.success) {
        throw new Error(
          `Failed to initialise git repo in new sandbox: ${initResult.stderr}`,
        );
      }
    }

    if (payload.diffText.trim().length > 0) {
      await sandbox.writeFile(DIFF_PATH, payload.diffText, "utf-8");
      const applyResult = await sandbox.exec(
        `git apply ${DIFF_PATH}`,
        cwd,
        PACK_TIMEOUT_MS,
      );
      if (!applyResult.success) {
        throw new Error(
          `Failed to reapply uncommitted diff after migration: ${applyResult.stderr}`,
        );
      }
    }

    if (payload.untrackedTarBase64) {
      await sandbox.writeFileBuffer(
        UNTRACKED_TAR_PATH,
        Buffer.from(payload.untrackedTarBase64, "base64"),
      );
      const extractResult = await sandbox.exec(
        `tar -xzf ${UNTRACKED_TAR_PATH}`,
        cwd,
        PACK_TIMEOUT_MS,
      );
      if (!extractResult.success) {
        throw new Error(
          `Failed to restore untracked files after migration: ${extractResult.stderr}`,
        );
      }
    }
    return;
  }

  await sandbox.writeFileBuffer(
    FULL_TAR_PATH,
    Buffer.from(payload.fullTarBase64, "base64"),
  );
  const extractResult = await sandbox.exec(
    `tar -xzf ${FULL_TAR_PATH}`,
    cwd,
    PACK_TIMEOUT_MS,
  );
  if (!extractResult.success) {
    throw new Error(
      `Failed to restore workspace tar after migration: ${extractResult.stderr}`,
    );
  }
}
