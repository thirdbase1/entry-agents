import { eq, sql } from "drizzle-orm";
import { db } from "./client";
import { accounts, chats, sessions, users } from "./schema";

export interface AdminPlatformStats {
  totalUsers: number;
  newUsersLast7d: number;
  totalAdmins: number;
  totalSessions: number;
  activeSessions: number;
  totalChats: number;
  githubConnectedUsers: number;
  vercelConnectedUsers: number;
}

/**
 * Coarse, all-time platform counters for the admin overview page --
 * separate from the time-ranged usage/spend numbers in
 * `getAdminPlatformUsageOverview`. Cheap single-row aggregates, safe to
 * run on every page load.
 */
export async function getAdminPlatformStats(): Promise<AdminPlatformStats> {
  const since7d = new Date();
  since7d.setDate(since7d.getDate() - 7);

  const [userStats, sessionStats, chatStats, githubStats, vercelStats] =
    await Promise.all([
      db
        .select({
          totalUsers: sql<number>`count(*)::int`,
          newUsersLast7d: sql<number>`coalesce(sum(case when ${users.createdAt} >= ${since7d.toISOString()} then 1 else 0 end), 0)::int`,
          totalAdmins: sql<number>`coalesce(sum(case when ${users.isAdmin} then 1 else 0 end), 0)::int`,
        })
        .from(users),
      db
        .select({
          totalSessions: sql<number>`count(*)::int`,
          activeSessions: sql<number>`coalesce(sum(case when ${sessions.status} = 'running' then 1 else 0 end), 0)::int`,
        })
        .from(sessions),
      db
        .select({
          totalChats: sql<number>`count(*)::int`,
        })
        .from(chats),
      db
        .select({
          count: sql<number>`count(distinct ${accounts.userId})::int`,
        })
        .from(accounts)
        .where(eq(accounts.providerId, "github")),
      db
        .select({
          count: sql<number>`count(distinct ${accounts.userId})::int`,
        })
        .from(accounts)
        .where(eq(accounts.providerId, "vercel")),
    ]);

  return {
    totalUsers: userStats[0]?.totalUsers ?? 0,
    newUsersLast7d: userStats[0]?.newUsersLast7d ?? 0,
    totalAdmins: userStats[0]?.totalAdmins ?? 0,
    totalSessions: sessionStats[0]?.totalSessions ?? 0,
    activeSessions: sessionStats[0]?.activeSessions ?? 0,
    totalChats: chatStats[0]?.totalChats ?? 0,
    githubConnectedUsers: githubStats[0]?.count ?? 0,
    vercelConnectedUsers: vercelStats[0]?.count ?? 0,
  };
}
