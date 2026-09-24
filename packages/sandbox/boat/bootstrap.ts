import type { Sandbox } from "../interface.ts";
import type { Source } from "../types.ts";
import { shellQuote, shellQuoteArgs } from "./shell.ts";

export const BOAT_DEFAULT_WORKING_DIRECTORY = "/home/user/workspace";

async function isWorkspaceEmpty(sandbox: Sandbox): Promise<boolean> {
  const result = await sandbox.exec(
    `test -z "$(ls -A ${shellQuote(sandbox.workingDirectory)} 2>/dev/null)"`,
    "/tmp",
    30_000,
  );
  return result.success;
}

async function isGitRepo(sandbox: Sandbox): Promise<boolean> {
  const result = await sandbox.exec(
    `test -d ${shellQuote(`${sandbox.workingDirectory}/.git`)}`,
    "/tmp",
    30_000,
  );
  return result.success;
}

async function configureGitUser(
  sandbox: Sandbox,
  gitUser?: { name: string; email: string },
): Promise<void> {
  if (!gitUser) return;

  await sandbox.exec(
    [
      `git config user.name ${shellQuote(gitUser.name)}`,
      `git config user.email ${shellQuote(gitUser.email)}`,
    ].join(" && "),
    sandbox.workingDirectory,
    60_000,
  );
}

/**
 * Make the workspace a usable git repository. Mirrors the empty-workspace
 * bootstrap VercelSandbox.create() performs for containers that started
 * without a git source, so a Boat session with no repo behaves the same
 * way (tools can still commit).
 */
async function bootstrapEmptyWorkspace(
  sandbox: Sandbox,
  gitUser?: { name: string; email: string },
): Promise<void> {
  if (await isGitRepo(sandbox)) {
    await configureGitUser(sandbox, gitUser);
    return;
  }

  await sandbox.exec("git init", sandbox.workingDirectory, 60_000);
  await configureGitUser(sandbox, gitUser);
  await sandbox.exec(
    "git commit --allow-empty -m 'Initial commit'",
    sandbox.workingDirectory,
    60_000,
  );
}

async function cloneSource(
  sandbox: Sandbox,
  source: Source,
  gitUser?: { name: string; email: string },
): Promise<void> {
  const branch = source.branch ?? "main";
  const wd = shellQuote(sandbox.workingDirectory);

  await sandbox.exec(
    `git clone --branch ${shellQuote(branch)} ${shellQuote(source.repo)} ${wd}`,
    "/tmp",
    600_000,
  );

  await configureGitUser(sandbox, gitUser);

  if (source.newBranch) {
    await sandbox.exec(
      `git checkout -b ${shellQuote(source.newBranch)}`,
      sandbox.workingDirectory,
      60_000,
    );
  }
}

/**
 * Prepare a freshly-created (or freshly-resumed) Boat workspace.
 *
 * Boat has no git-source create option the way Vercel Sandbox does, so
 * the clone/bootstrap that the Vercel SDK performs at create time happens
 * here instead. Idempotent: an already-provisioned workspace is left
 * alone, which is what makes reconnects and resumes safe.
 */
export async function bootstrapBoatWorkspace(params: {
  sandbox: Sandbox;
  source?: Source;
  gitUser?: { name: string; email: string };
  skipGitWorkspaceBootstrap?: boolean;
}): Promise<void> {
  const { sandbox, source, gitUser, skipGitWorkspaceBootstrap } = params;

  if (params.skipGitWorkspaceBootstrap && !source) {
    return;
  }

  const empty = await isWorkspaceEmpty(sandbox);

  if (source && empty) {
    await cloneSource(sandbox, source, gitUser);
    return;
  }

  if (source && !empty) {
    // Workspace already holds work (reconnect/resume). If it is not a
    // repo yet, cloning would fail outright -- leave it as-is rather
    // than clobbering user files.
    if (await isGitRepo(sandbox)) {
      await configureGitUser(sandbox, gitUser);
      if (source.newBranch) {
        await sandbox.exec(
          `git rev-parse --verify ${shellQuote(source.newBranch)} >/dev/null 2>&1 || git checkout -b ${shellQuote(source.newBranch)}`,
          sandbox.workingDirectory,
          60_000,
        );
      }
    }
    return;
  }

  if (!skipGitWorkspaceBootstrap) {
    await bootstrapEmptyWorkspace(sandbox, gitUser);
  }
}

/** Ensure the working directory exists before anything writes into it. */
export async function ensureBoatWorkingDirectory(sandbox: Sandbox): Promise<void> {
  await sandbox.exec(
    `mkdir -p ${shellQuoteArgs([sandbox.workingDirectory])}`,
    "/tmp",
    30_000,
  );
}
