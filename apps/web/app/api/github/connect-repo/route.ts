import { connectSandbox } from "@open-agents/sandbox";
import { performAutoCommit } from "@/lib/chat/auto-commit-direct";
import { getSessionById, updateSession } from "@/lib/db/sessions";
import { generateBranchName, isSafeBranchName } from "@/lib/git/helpers";
import {
  getRepoAccessErrorMessage,
  verifyRepoAccess,
} from "@/lib/github/access";
import {
  isValidGitHubRepoName,
  isValidGitHubRepoOwner,
} from "@/lib/github/urls";
import { getServerSession } from "@/lib/session/get-server-session";
import { isSandboxActive } from "@/lib/sandbox/utils";

// Allow up to 2 minutes: this does a live repo-access check plus an
// initial commit+push, same budget as create-repo/commit.
export const maxDuration = 120;

interface ConnectRepoBody {
  sessionId?: string;
  owner?: string;
  repo?: string;
}

/**
 * Links an EXISTING GitHub repository to a session that doesn't have one
 * yet (sessions can currently only get a repo at creation time -- there's
 * no way to add one later, which this closes). Repo creation itself stays
 * disabled (see /api/github/create-repo); the user must pick a repo they
 * already have push access to.
 *
 * On success this also pushes the session's current sandbox state as the
 * first commit, on a fresh branch off the repo's default branch -- reusing
 * `performAutoCommit`, the exact same verified-commit path as the manual
 * "Commit & Push" button and the background auto-commit. If there's
 * nothing to commit yet (brand new, untouched session), the repo is still
 * linked; the first real commit happens naturally once work starts.
 */
export async function POST(req: Request) {
  const session = await getServerSession();
  if (!session?.user) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: ConnectRepoBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sessionId, owner, repo } = body;

  if (!sessionId || typeof sessionId !== "string") {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }
  if (!owner || typeof owner !== "string" || !isValidGitHubRepoOwner(owner)) {
    return Response.json(
      { error: "Invalid repository owner" },
      { status: 400 },
    );
  }
  if (!repo || typeof repo !== "string" || !isValidGitHubRepoName(repo)) {
    return Response.json({ error: "Invalid repository name" }, { status: 400 });
  }

  const sessionRecord = await getSessionById(sessionId);
  if (!sessionRecord) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  if (sessionRecord.userId !== session.user.id) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (sessionRecord.repoOwner && sessionRecord.repoName) {
    return Response.json(
      {
        error: `This session is already connected to ${sessionRecord.repoOwner}/${sessionRecord.repoName}.`,
      },
      { status: 409 },
    );
  }
  if (!isSandboxActive(sessionRecord.sandboxState)) {
    return Response.json(
      { error: "Sandbox not active. Please wait for it to start." },
      { status: 400 },
    );
  }

  const access = await verifyRepoAccess({
    userId: session.user.id,
    owner,
    repo,
    requiredUserPermission: "write",
  });
  if (!access.ok) {
    return Response.json(
      { error: getRepoAccessErrorMessage(access.reason) },
      { status: 403 },
    );
  }

  const branch = generateBranchName(session.user.username, session.user.name);
  if (!isSafeBranchName(branch)) {
    return Response.json(
      { error: "Failed to generate a safe branch name" },
      { status: 500 },
    );
  }

  const cloneUrl = `https://github.com/${owner}/${repo}.git`;

  // Link first so a crash after this point still leaves the session
  // pointed at the repo (surfaced to the user, retryable), rather than
  // silently doing nothing.
  await updateSession(sessionId, {
    repoOwner: owner,
    repoName: repo,
    cloneUrl,
    branch,
    isNewBranch: true,
  });

  try {
    const sandbox = await connectSandbox(sessionRecord.sandboxState);
    const checkoutResult = await sandbox.exec(
      `git checkout -b ${branch}`,
      sandbox.workingDirectory,
      10_000,
    );
    if (!checkoutResult.success) {
      await updateSession(sessionId, {
        repoOwner: null,
        repoName: null,
        cloneUrl: null,
        isNewBranch: false,
      });
      return Response.json(
        { error: `Failed to create branch: ${checkoutResult.stdout}` },
        { status: 500 },
      );
    }

    const result = await performAutoCommit({
      sandbox,
      userId: session.user.id,
      sessionId,
      sessionTitle: sessionRecord.title,
      repoOwner: owner,
      repoName: repo,
      baseBranch: access.defaultBranch,
      commitMessage: `chore: connect "${sessionRecord.title}" to ${owner}/${repo}`,
    });

    if (result.error) {
      await updateSession(sessionId, {
        repoOwner: null,
        repoName: null,
        cloneUrl: null,
        isNewBranch: false,
      });
      return Response.json({ error: result.error }, { status: 500 });
    }

    return Response.json({
      repoOwner: owner,
      repoName: repo,
      branch,
      cloneUrl,
      committed: result.committed,
      pushed: result.pushed,
      commitSha: result.commitSha,
      commitUrl: result.commitUrl,
    });
  } catch (error) {
    await updateSession(sessionId, {
      repoOwner: null,
      repoName: null,
      cloneUrl: null,
      isNewBranch: false,
    }).catch(() => {});
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to connect repository",
      },
      { status: 500 },
    );
  }
}
