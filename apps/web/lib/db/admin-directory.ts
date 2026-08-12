import { desc, ilike, inArray, or, sql } from "drizzle-orm";
import { estimateModelUsageCost, type AvailableModel } from "@/lib/models";
import { db } from "./client";
import { accounts, sessions, usageEvents, users } from "./schema";
import { costForModel } from "./admin-usage";

export interface AdminSignupRow {
  id: string;
  username: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  createdAt: Date;
  githubConnected: boolean;
  vercelConnected: boolean;
}

interface BaseUserRow {
  id: string;
  username: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  createdAt: Date;
  lastLoginAt: Date;
}

async function attachConnectionFlags(
  baseRows: BaseUserRow[],
): Promise<Map<string, { github: boolean; vercel: boolean }>> {
  const flags = new Map<string, { github: boolean; vercel: boolean }>();
  if (baseRows.length === 0) return flags;

  const userIds = baseRows.map((row) => row.id);
  const accountRows = await db
    .select({ userId: accounts.userId, providerId: accounts.providerId })
    .from(accounts)
    .where(inArray(accounts.userId, userIds));

  for (const row of baseRows) {
    flags.set(row.id, { github: false, vercel: false });
  }
  for (const account of accountRows) {
    const entry = flags.get(account.userId);
    if (!entry) continue;
    if (account.providerId === "github") entry.github = true;
    if (account.providerId === "vercel") entry.vercel = true;
  }

  return flags;
}

/**
 * Most recently created accounts, for the admin Users tab. Cheap lookup
 * -- one page-size query plus a batched connections join.
 */
export async function getAdminRecentSignups(
  limit = 12,
): Promise<AdminSignupRow[]> {
  const baseRows = await db
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
    .orderBy(desc(users.createdAt))
    .limit(limit);

  const flags = await attachConnectionFlags(baseRows);

  return baseRows.map((row) => ({
    id: row.id,
    username: row.username,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatarUrl,
    isAdmin: row.isAdmin,
    createdAt: row.createdAt,
    githubConnected: flags.get(row.id)?.github ?? false,
    vercelConnected: flags.get(row.id)?.vercel ?? false,
  }));
}

export interface AdminUserLookupRow {
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
 * Free-text lookup (matches username/name/email) for the admin Users
 * tab's search box, enriched with connection flags, session count, and
 * an all-time estimated-spend summary. Used to answer "who is this user
 * and how much have they used" without touching a database console.
 */
export async function searchAdminUsers(
  query: string,
  modelCostCatalog: AvailableModel[],
  limit = 10,
): Promise<AdminUserLookupRow[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const pattern = `%${trimmed}%`;

  const baseRows = await db
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
    .where(
      or(
        ilike(users.username, pattern),
        ilike(users.name, pattern),
        ilike(users.email, pattern),
      ),
    )
    .limit(limit);

  if (baseRows.length === 0) return [];

  const userIds = baseRows.map((row) => row.id);

  const [flags, sessionRows, usageRows] = await Promise.all([
    attachConnectionFlags(baseRows),
    db
      .select({
        userId: sessions.userId,
        count: sql<number>`count(*)::int`,
      })
      .from(sessions)
      .where(inArray(sessions.userId, userIds))
      .groupBy(sessions.userId),
    db
      .select({
        userId: usageEvents.userId,
        modelId: usageEvents.modelId,
        totalInputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::double precision`,
        totalCachedInputTokens: sql<number>`coalesce(sum(${usageEvents.cachedInputTokens}), 0)::double precision`,
        totalOutputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::double precision`,
      })
      .from(usageEvents)
      .where(inArray(usageEvents.userId, userIds))
      .groupBy(usageEvents.userId, usageEvents.modelId),
  ]);

  const sessionCountByUser = new Map(
    sessionRows.map((row) => [row.userId, row.count]),
  );

  const usageByUser = new Map<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cost: number;
      unpriced: boolean;
    }
  >();
  for (const row of usageRows) {
    const cost = costForModel(row.modelId, modelCostCatalog);
    const estimatedCost = estimateModelUsageCost(
      {
        inputTokens: row.totalInputTokens,
        cachedInputTokens: row.totalCachedInputTokens,
        outputTokens: row.totalOutputTokens,
      },
      cost,
    );
    const existing = usageByUser.get(row.userId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      unpriced: false,
    };
    existing.inputTokens += row.totalInputTokens;
    existing.outputTokens += row.totalOutputTokens;
    existing.cost += estimatedCost ?? 0;
    existing.unpriced = existing.unpriced || estimatedCost === undefined;
    usageByUser.set(row.userId, existing);
  }

  return baseRows.map((row) => {
    const usage = usageByUser.get(row.id);
    const connections = flags.get(row.id);
    return {
      id: row.id,
      username: row.username,
      name: row.name,
      email: row.email,
      avatarUrl: row.avatarUrl,
      isAdmin: row.isAdmin,
      createdAt: row.createdAt,
      lastLoginAt: row.lastLoginAt,
      githubConnected: connections?.github ?? false,
      vercelConnected: connections?.vercel ?? false,
      sessionCount: sessionCountByUser.get(row.id) ?? 0,
      totalInputTokens: usage?.inputTokens ?? 0,
      totalOutputTokens: usage?.outputTokens ?? 0,
      estimatedCostUsd: usage?.cost ?? 0,
      hasUnpricedUsage: usage?.unpriced ?? false,
    };
  });
}
