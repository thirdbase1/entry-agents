import { NextRequest, NextResponse } from "next/server";
import { getInstallationByUserAndId } from "@/lib/db/installations";
import {
  getCachedUserRepoIndex,
  saveUserRepoIndex,
} from "@/lib/db/repo-index";
import { getLastRepoByUserId } from "@/lib/db/last-repo";
import {
  filterRepositories,
  listUserInstallationRepositories,
  type InstallationRepository,
} from "@/lib/github/repos";
import { getUserGitHubToken } from "@/lib/github/token";
import { getServerSession } from "@/lib/session/get-server-session";

/**
 * Boost the user's most recently used repo to the top of the list
 * (upstream #792): the repo they worked on yesterday is the most
 * likely target, and pinning it first keeps it visible even when the
 * query matches many other repos.
 */
function boostLastUsedRepo(
  repos: InstallationRepository[],
  lastRepo: { owner: string; repo: string } | null,
): InstallationRepository[] {
  if (!lastRepo?.owner || !lastRepo.repo) {
    return repos;
  }

  const owner = lastRepo.owner.toLowerCase();
  const name = lastRepo.repo.toLowerCase();
  const index = repos.findIndex(
    (repo) =>
      repo.full_name.toLowerCase() === `${owner}/${name}`,
  );

  if (index <= 0) {
    return repos;
  }

  const [pinned] = repos.splice(index, 1);
  repos.unshift(pinned);
  return repos;
}

function parseInstallationId(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

export async function GET(request: NextRequest) {
  const session = await getServerSession();

  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const installationId = parseInstallationId(
    searchParams.get("installation_id"),
  );
  // refresh=1 bypasses the cached repo index (upstream #840) for when
  // the user just installed/created a repo and wants it immediately.
  const forceRefresh = searchParams.get("refresh") === "1";
  const query = searchParams.get("query")?.trim() || undefined;
  const limitParam = searchParams.get("limit");
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
  const limit =
    typeof parsedLimit === "number" && Number.isFinite(parsedLimit)
      ? parsedLimit
      : undefined;

  if (!installationId) {
    return NextResponse.json(
      { error: "installation_id is required" },
      { status: 400 },
    );
  }

  const installation = await getInstallationByUserAndId(
    session.user.id,
    installationId,
  );
  if (!installation) {
    return NextResponse.json(
      { error: "Installation not found" },
      { status: 403 },
    );
  }

  const userToken = await getUserGitHubToken(session.user.id);
  if (!userToken) {
    return NextResponse.json(
      { error: "GitHub not connected" },
      { status: 401 },
    );
  }

  try {
    // Cache-first (upstream open-agents #840): serve from the DB when
    // fresh, and only page GitHub on a miss or explicit refresh. The
    // full list is cached unfiltered so every subsequent selector query
    // is a pure local filter — no more per-keystroke GitHub round-trips.
    let allRepos: InstallationRepository[] | null = null;

    if (!forceRefresh) {
      const cached = await getCachedUserRepoIndex(
        session.user.id,
        installationId,
      );
      if (cached) {
        allRepos = cached.repos;
      }
    }

    if (!allRepos) {
      allRepos = await listUserInstallationRepositories({
        installationId,
        userToken,
        limit: 100,
      });
      await saveUserRepoIndex(session.user.id, installationId, allRepos);
    }

    const lastRepo = await getLastRepoByUserId(session.user.id).catch(
      () => null,
    );

    const repos = boostLastUsedRepo(
      filterRepositories(allRepos, {
        owner: installation.accountLogin,
        query,
        limit,
      }),
      lastRepo,
    );

    // Response stays a plain array — the selector client must not care
    // whether the list came from the cache or from GitHub.
    return NextResponse.json(repos);
  } catch (error) {
    console.error("Failed to fetch installation repositories:", error);
    return NextResponse.json(
      { error: "Failed to fetch repositories" },
      { status: 500 },
    );
  }
}
