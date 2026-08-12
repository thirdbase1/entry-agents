import { desc, eq, sql } from "drizzle-orm";
import { estimateModelUsageCost, type AvailableModel } from "@/lib/models";
import { costForModel } from "./admin-usage";
import { db } from "./client";
import { accounts, sessions, usageEvents, users } from "./schema";

export interface AdminUserProfile {
  id: string;
  username: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  createdAt: Date;
  lastLoginAt: Date;
  githubConnected: boolean;
  vercelConnected: boolean;
  sessionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  hasUnpricedUsage: boolean;
}

/**
 * Full profile for the admin user-detail drill-down page: base account
 * fields, connection flags, and an all-time usage/spend summary. Returns
 * null if the user doesn't exist.
 */
export async function getAdminUserProfile(
  userId: string,
  modelCostCatalog: AvailableModel[],
): Promise<AdminUserProfile | null> {
  const [userRow] = await db
    .select({
      id: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      isAdmin: users.isAdmin,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!userRow) return null;

  const [connectionRows, sessionCountRows, usageRows] = await Promise.all([
    db
      .select({ providerId: accounts.providerId })
      .from(accounts)
      .where(eq(accounts.userId, userId)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(eq(sessions.userId, userId)),
    db
      .select({
        modelId: usageEvents.modelId,
        totalInputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::double precision`,
        totalCachedInputTokens: sql<number>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)::double precision`,
        totalOutputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::double precision`,
      })
      .from(usageEvents)
      .where(eq(usageEvents.userId, userId))
      .groupBy(usageEvents.modelId),
  ]);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let estimatedCostUsd = 0;
  let hasUnpricedUsage = false;

  for (const row of usageRows) {
    totalInputTokens += row.totalInputTokens;
    totalOutputTokens += row.totalOutputTokens;
    const cost = costForModel(row.modelId, modelCostCatalog);
    const estimated = estimateModelUsageCost(
      {
        inputTokens: row.totalInputTokens,
        cachedInputTokens: row.totalCachedInputTokens,
        outputTokens: row.totalOutputTokens,
      },
      cost,
    );
    if (estimated === undefined) {
      hasUnpricedUsage = true;
    } else {
      estimatedCostUsd += estimated;
    }
  }

  return {
    id: userRow.id,
    username: userRow.username,
    name: userRow.name,
    email: userRow.email,
    avatarUrl: userRow.avatarUrl,
    isAdmin: userRow.isAdmin,
    createdAt: userRow.createdAt,
    lastLoginAt: userRow.lastLoginAt,
    githubConnected: connectionRows.some((r) => r.providerId === "github"),
    vercelConnected: connectionRows.some((r) => r.providerId === "vercel"),
    sessionCount: sessionCountRows[0]?.count ?? 0,
    totalInputTokens,
    totalOutputTokens,
    estimatedCostUsd,
    hasUnpricedUsage,
  };
}

export interface AdminUserUsageDayRow {
  /** YYYY-MM-DD, UTC. */
  date: string;
  totalTokens: number;
  estimatedCostUsd: number;
}

/**
 * Daily token volume + estimated spend for one user over the last
 * `days` days, zero-filled -- the usage-history chart on the drill-down
 * page.
 */
export async function getAdminUserUsageTrend(
  userId: string,
  modelCostCatalog: AvailableModel[],
  days = 30,
): Promise<AdminUserUsageDayRow[]> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));

  const rows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${usageEvents.createdAt}), 'YYYY-MM-DD')`,
      modelId: usageEvents.modelId,
      totalInputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::double precision`,
      totalCachedInputTokens: sql<number>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)::double precision`,
      totalOutputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::double precision`,
    })
    .from(usageEvents)
    .where(
      sql`${usageEvents.userId} = ${userId} and ${usageEvents.createdAt} >= ${since.toISOString()}`,
    )
    .groupBy(
      sql`date_trunc('day', ${usageEvents.createdAt})`,
      usageEvents.modelId,
    );

  const byDay = new Map<
    string,
    { totalTokens: number; estimatedCostUsd: number }
  >();

  for (const row of rows) {
    const cost = costForModel(row.modelId, modelCostCatalog);
    const estimated =
      estimateModelUsageCost(
        {
          inputTokens: row.totalInputTokens,
          cachedInputTokens: row.totalCachedInputTokens,
          outputTokens: row.totalOutputTokens,
        },
        cost,
      ) ?? 0;

    const existing = byDay.get(row.day) ?? {
      totalTokens: 0,
      estimatedCostUsd: 0,
    };
    existing.totalTokens += row.totalInputTokens + row.totalOutputTokens;
    existing.estimatedCostUsd += estimated;
    byDay.set(row.day, existing);
  }

  const result: AdminUserUsageDayRow[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(since);
    day.setUTCDate(since.getUTCDate() + i);
    const key = day.toISOString().slice(0, 10);
    const found = byDay.get(key);
    result.push({
      date: key,
      totalTokens: found?.totalTokens ?? 0,
      estimatedCostUsd: found?.estimatedCostUsd ?? 0,
    });
  }

  return result;
}

export interface AdminUserModelRow {
  modelId: string;
  provider: string | null;
  eventCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number | undefined;
}

/** Per-model, all-time breakdown for one user's usage-history table. */
export async function getAdminUserModelBreakdown(
  userId: string,
  modelCostCatalog: AvailableModel[],
): Promise<AdminUserModelRow[]> {
  const rows = await db
    .select({
      modelId: usageEvents.modelId,
      provider: usageEvents.provider,
      eventCount: sql<number>`count(*)::int`,
      totalInputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::double precision`,
      totalCachedInputTokens: sql<number>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)::double precision`,
      totalOutputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::double precision`,
    })
    .from(usageEvents)
    .where(eq(usageEvents.userId, userId))
    .groupBy(usageEvents.modelId, usageEvents.provider);

  return rows
    .map((row) => ({
      modelId: row.modelId ?? "unknown",
      provider: row.provider,
      eventCount: row.eventCount,
      totalInputTokens: row.totalInputTokens,
      totalOutputTokens: row.totalOutputTokens,
      estimatedCostUsd: estimateModelUsageCost(
        {
          inputTokens: row.totalInputTokens,
          cachedInputTokens: row.totalCachedInputTokens,
          outputTokens: row.totalOutputTokens,
        },
        costForModel(row.modelId, modelCostCatalog),
      ),
    }))
    .toSorted(
      (a, b) => (b.estimatedCostUsd ?? -1) - (a.estimatedCostUsd ?? -1),
    );
}

export interface AdminUserSessionRow {
  id: string;
  title: string;
  status: "running" | "completed" | "failed" | "archived";
  repoOwner: string | null;
  repoName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Most recent sessions for one user, for the drill-down page. */
export async function getAdminUserSessions(
  userId: string,
  limit = 10,
): Promise<AdminUserSessionRow[]> {
  return db
    .select({
      id: sessions.id,
      title: sessions.title,
      status: sessions.status,
      repoOwner: sessions.repoOwner,
      repoName: sessions.repoName,
      createdAt: sessions.createdAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.updatedAt))
    .limit(limit);
}
