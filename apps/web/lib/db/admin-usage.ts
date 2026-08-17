import { sql } from "drizzle-orm";
import { estimateModelUsageCost, type AvailableModel } from "@/lib/models";
import { db } from "./client";
import { usageEvents, users } from "./schema";

export interface AdminUsagePerModelRow {
  modelId: string;
  provider: string | null;
  eventCount: number;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  /** undefined when the model isn't in the live cost catalog (unpriced). */
  estimatedCostUsd: number | undefined;
}

export interface AdminUsageTopUserRow {
  userId: string;
  username: string;
  name: string | null;
  email: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  hasUnpricedUsage: boolean;
}

export interface AdminPlatformUsageOverview {
  rangeDays: number;
  totalActiveUsers: number;
  totalEvents: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUsd: number;
  /** True if any usage fell under a model missing from the cost catalog. */
  hasUnpricedUsage: boolean;
  perModel: AdminUsagePerModelRow[];
  topUsers: AdminUsageTopUserRow[];
}

interface RawUserEventRow {
  userId: string;
  username: string;
  name: string | null;
  email: string | null;
  modelId: string | null;
  provider: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface AdminUsageOverviewOptions {
  /** Lookback window in days. Defaults to 30. */
  days?: number;
  /** Live model cost catalog (from fetchAvailableLanguageModels()). */
  modelCostCatalog: AvailableModel[];
  /** Max number of top-spending users to return. Defaults to 10. */
  topUserLimit?: number;
}

export function costForModel(
  modelId: string | null,
  catalog: AvailableModel[],
): AvailableModel["cost"] | undefined {
  if (!modelId) return undefined;
  return catalog.find((model) => model.id === modelId)?.cost;
}

/**
 * Platform-wide usage + estimated spend across every user, for the admin
 * dashboard. Built directly on the existing `usage_events` table (same
 * source the per-user usage-insights views already read from) -- no
 * schema changes needed. Cost is estimated client-side (in this function)
 * from the live per-model pricing catalog since usage_events only stores
 * raw token counts, not a persisted dollar cost.
 *
 * FIXED 2026-08-17: this used to have Postgres sum() raw token counts
 * across every event in the window *before* handing the totals to
 * estimateModelUsageCost once. That's wrong for any model with a
 * `cost.context_over_200k` premium tier (currently grok-4.5) --
 * resolveCostTier's ">200k" check is meant to apply to a single request's
 * own prompt size, not a user's cumulative 30-day total. A heavy user who
 * never sent one single 200k+ prompt could still cross 200k in the SUM
 * and get 2x'd across their *entire* usage, wildly inflating estimated
 * spend (this is what produced the bogus ~$600 estimate an admin saw on
 * a user's profile). Fix: fetch raw per-event rows and price each one
 * individually (so the 200k check sees that one event's real
 * inputTokens), THEN sum the resulting dollar amounts -- never sum
 * tokens across separate events before pricing them.
 */
export async function getAdminPlatformUsageOverview(
  options: AdminUsageOverviewOptions,
): Promise<AdminPlatformUsageOverview> {
  const days = options.days ?? 30;
  const topUserLimit = options.topUserLimit ?? 10;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const rows: RawUserEventRow[] = await db
    .select({
      userId: users.id,
      username: users.username,
      name: users.name,
      email: users.email,
      modelId: usageEvents.modelId,
      provider: usageEvents.provider,
      inputTokens: usageEvents.inputTokens,
      cachedInputTokens: usageEvents.cachedInputTokens,
      outputTokens: usageEvents.outputTokens,
    })
    .from(usageEvents)
    .innerJoin(users, sql`${usageEvents.userId} = ${users.id}`)
    .where(sql`${usageEvents.createdAt} >= ${since.toISOString()}`);

  const perModelMap = new Map<string, AdminUsagePerModelRow>();
  const topUsersMap = new Map<string, AdminUsageTopUserRow>();
  const activeUserIds = new Set<string>();

  let totalEvents = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalEstimatedCostUsd = 0;
  let hasUnpricedUsage = false;

  for (const row of rows) {
    activeUserIds.add(row.userId);
    totalEvents += 1;
    totalInputTokens += row.inputTokens;
    totalOutputTokens += row.outputTokens;

    // Priced per-event, on this event's own token counts -- see the
    // function doc comment above for why this must not be a pre-summed
    // total.
    const cost = costForModel(row.modelId, options.modelCostCatalog);
    const estimatedCost = estimateModelUsageCost(
      {
        inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens,
        outputTokens: row.outputTokens,
      },
      cost,
    );
    const rowIsUnpriced = estimatedCost === undefined;
    if (rowIsUnpriced) {
      hasUnpricedUsage = true;
    } else {
      totalEstimatedCostUsd += estimatedCost;
    }

    const modelKey = row.modelId ?? "unknown";
    const existingModel = perModelMap.get(modelKey);
    if (existingModel) {
      existingModel.eventCount += 1;
      existingModel.totalInputTokens += row.inputTokens;
      existingModel.totalCachedInputTokens += row.cachedInputTokens;
      existingModel.totalOutputTokens += row.outputTokens;
      existingModel.estimatedCostUsd =
        existingModel.estimatedCostUsd === undefined &&
        estimatedCost === undefined
          ? undefined
          : (existingModel.estimatedCostUsd ?? 0) + (estimatedCost ?? 0);
    } else {
      perModelMap.set(modelKey, {
        modelId: modelKey,
        provider: row.provider,
        eventCount: 1,
        totalInputTokens: row.inputTokens,
        totalCachedInputTokens: row.cachedInputTokens,
        totalOutputTokens: row.outputTokens,
        estimatedCostUsd: estimatedCost,
      });
    }

    const existingUser = topUsersMap.get(row.userId);
    if (existingUser) {
      existingUser.totalInputTokens += row.inputTokens;
      existingUser.totalOutputTokens += row.outputTokens;
      existingUser.estimatedCostUsd += estimatedCost ?? 0;
      existingUser.hasUnpricedUsage =
        existingUser.hasUnpricedUsage || rowIsUnpriced;
    } else {
      topUsersMap.set(row.userId, {
        userId: row.userId,
        username: row.username,
        name: row.name,
        email: row.email,
        totalInputTokens: row.inputTokens,
        totalOutputTokens: row.outputTokens,
        estimatedCostUsd: estimatedCost ?? 0,
        hasUnpricedUsage: rowIsUnpriced,
      });
    }
  }

  const topUsers = [...topUsersMap.values()]
    .toSorted((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)
    .slice(0, topUserLimit);

  const perModel = [...perModelMap.values()].toSorted((a, b) => {
    const costA = a.estimatedCostUsd ?? -1;
    const costB = b.estimatedCostUsd ?? -1;
    if (costB !== costA) return costB - costA;
    return (
      b.totalInputTokens +
      b.totalOutputTokens -
      (a.totalInputTokens + a.totalOutputTokens)
    );
  });

  return {
    rangeDays: days,
    totalActiveUsers: activeUserIds.size,
    totalEvents,
    totalInputTokens,
    totalOutputTokens,
    totalEstimatedCostUsd,
    hasUnpricedUsage,
    perModel,
    topUsers,
  };
}
