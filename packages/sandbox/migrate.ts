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
 * - "plain": no git repo (e.g. a scratch/chat sandbox). We transfer a
 *   full tarball of the workspace, excluding regenerable junk
 *   (node_modules, build output, etc.) to keep the payload small.
 */
export type WorkspacePayload =
  | {
      kind: "git";
      bundleBase64: string;
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

async function packGitWorkspace(
  sandbox: Sandbox,
): Promise<WorkspacePayload & { kind: "git" }> {
  const cwd = sandbox.workingDirectory;

  const bundleResult = await sandbox.exec(
    `git bundle create ${BUNDLE_PATH} --all`,
    cwd,
    PACK_TIMEOUT_MS,
  );
  if (!bundleResult.success) {
    throw new Error(`Failed to create git bundle: ${bundleResult.stderr}`);
  }
  const bundleBase64 = (await sandbox.readFileBuffer(BUNDLE_PATH)).toString(
    "base64",
  );

  const diffResult = await sandbox.exec("git diff HEAD", cwd, PACK_TIMEOUT_MS);
  const diffText = diffResult.stdout;

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
    await sandbox.writeFileBuffer(
      BUNDLE_PATH,
      Buffer.from(payload.bundleBase64, "base64"),
    );
    const cloneResult = await sandbox.exec(
      `git clone ${BUNDLE_PATH} .`,
      cwd,
      PACK_TIMEOUT_MS,
    );
    if (!cloneResult.success) {
      throw new Error(
        `Failed to restore git bundle into new sandbox: ${cloneResult.stderr}`,
      );
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
