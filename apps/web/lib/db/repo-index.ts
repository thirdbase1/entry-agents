import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { githubRepoIndex } from "./schema";
import type { InstallationRepository } from "@/lib/github/repos";

/**
 * Cached per-user GitHub repository index (upstream open-agents #840).
 *
 * The repo selector used to page api.github.com on every keystroke;
 * GitHub's 30s secondary rate limit made that flaky and slow. Now the
 * FULL list is fetched once per installation, stored in
 * github_repo_index, and served from the DB until the TTL expires.
 * Filtering (owner/query/limit) happens locally against the cached
 * array — pure functions below, unit-tested in repo-index.test.ts.
 */

export const GITHUB_REPO_INDEX_TTL_MS = 10 * 60 * 1000;

export interface CachedRepoIndex {
  repos: InstallationRepository[];
  fetchedAt: Date;
}

export async function getCachedUserRepoIndex(
  userId: string,
  installationId: number,
  maxAgeMs = GITHUB_REPO_INDEX_TTL_MS,
): Promise<CachedRepoIndex | null> {
  const rows = await db
    .select()
    .from(githubRepoIndex)
    .where(
      and(
        eq(githubRepoIndex.userId, userId),
        eq(githubRepoIndex.installationId, installationId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  const age = Date.now() - row.fetchedAt.getTime();
  if (age > maxAgeMs) {
    return null;
  }

  const repos = Array.isArray(row.repos)
    ? (row.repos as InstallationRepository[])
    : [];

  return { repos, fetchedAt: row.fetchedAt };
}

export async function saveUserRepoIndex(
  userId: string,
  installationId: number,
  repos: InstallationRepository[],
): Promise<void> {
  const id = `${userId}:${installationId}`;
  const now = new Date();

  await db
    .insert(githubRepoIndex)
    .values({ id, userId, installationId, repos, fetchedAt: now })
    .onConflictDoUpdate({
      target: githubRepoIndex.id,
      set: { repos, fetchedAt: now },
    });
}
