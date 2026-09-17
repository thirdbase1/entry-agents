import { and, desc, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { CompactionEvent } from "@open-agents/agent";
import { db } from "./client";
import { compactionEvents, usageEvents } from "./schema";

/**
 * Admin-visible compaction analytics. Added 2026-09-17 (owner: "build
 * compaction usage on the admin side -- cause am thinking compaction
 * doesn't work").
 *
 * recordCompactionEvent is called fire-and-forget from chat.ts's
 * AsyncLocalStorage sink (packages/agent compaction-telemetry) every time
 * auto-compaction actually fires mid-turn; it must never throw upward --
 * telemetry failures are logged and swallowed so a live model step is
 * never affected.
 */
export async function recordCompactionEvent(
  event: CompactionEvent,
  context: { userId: string; chatId?: string; sessionId?: string },
): Promise<void> {
  await db.insert(compactionEvents).values({
    id: nanoid(),
    userId: context.userId,
    chatId: context.chatId ?? null,
    sessionId: context.sessionId ?? null,
    modelId: event.modelId ?? null,
    preCompactTokens: event.preCompactTokens,
    postCompactTokens: event.postCompactTokens,
    contextWindowTokens: event.contextWindowTokens,
    threshold: event.threshold,
    compactedToolCalls: event.compactedToolCalls,
    compactedAnonymousToolResults: event.compactedAnonymousToolResults,
  });
}

export interface CompactionEventRow {
  id: string;
  chatId: string | null;
  modelId: string | null;
  preCompactTokens: number;
  postCompactTokens: number;
  contextWindowTokens: number;
  threshold: number;
  compactedToolCalls: number;
  compactedAnonymousToolResults: number;
  createdAt: string;
}

export interface CompactionOverview {
  /** Total firings in the window. Zero means compaction never fired --
   * the exact signal the owner wanted to verify. */
  eventCount: number;
  /** Distinct chats that ever compacted in the window. */
  chatCount: number;
  /** Average estimated request tokens before compaction fired. */
  avgPreCompactTokens: number;
  /** Average estimated request tokens after compaction. */
  avgPostCompactTokens: number;
  /** Total tokens reclaimed by compaction in the window. */
  totalTokensSaved: number;
  /** Most recent firing, null if none ever. */
  latestEventAt: string | null;
  events: CompactionEventRow[];
}

export async function getCompactionOverview(
  days = 30,
): Promise<CompactionOverview> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select()
    .from(compactionEvents)
    .orderBy(desc(compactionEvents.createdAt))
    .limit(200);

  const windowRows = rows.filter(
    (r) => new Date(r.createdAt).getTime() >= since.getTime(),
  );

  const eventCount = windowRows.length;
  const chatIds = new Set(
    windowRows.map((r) => r.chatId).filter((c): c is string => !!c),
  );

  const totals = windowRows.reduce(
    (acc, r) => {
      acc.pre += r.preCompactTokens;
      acc.post += r.postCompactTokens;
      return acc;
    },
    { pre: 0, post: 0 },
  );

  return {
    eventCount,
    chatCount: chatIds.size,
    avgPreCompactTokens:
      eventCount === 0 ? 0 : Math.round(totals.pre / eventCount),
    avgPostCompactTokens:
      eventCount === 0 ? 0 : Math.round(totals.post / eventCount),
    totalTokensSaved: Math.max(0, totals.pre - totals.post),
    latestEventAt:
      rows.length > 0
        ? new Date(rows[0].createdAt).toISOString()
        : null,
    events: rows.slice(0, 50).map((r) => ({
      id: r.id,
      chatId: r.chatId,
      modelId: r.modelId,
      preCompactTokens: r.preCompactTokens,
      postCompactTokens: r.postCompactTokens,
      contextWindowTokens: r.contextWindowTokens,
      threshold: r.threshold,
      compactedToolCalls: r.compactedToolCalls,
      compactedAnonymousToolResults: r.compactedAnonymousToolResults,
      createdAt: new Date(r.createdAt).toISOString(),
    })),
  };
}

/**
 * Companion stat for the admin overview: of all turns in the window, how
 * many carried a per-step context large enough that compaction COULD have
 * fired (estimated per-step context >= 95% of the model's window). This
 * pairs observed firings against the real opportunity surface -- if this
 * is high and eventCount is 0, compaction is broken; if both are low,
 * contexts simply never grow that large.
 */
export async function getCompactionEligibleTurnCount(
  days = 30,
): Promise<number> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Per-turn totals are the SUM of every step's context in the turn, so
  // (input + cached) / (tool_call_count + 1) approximates the average
  // per-step context. A turn is "eligible" when that average already sits
  // at ~240K tokens -- the 95% line of the 256K-window model class. Typed
  // drizzle helpers (gte) serialize Dates safely on Neon serverless; see
  // lessons-learned 2026-09-15 before switching this to a raw sql`` template.
  const [row] = await db
    .select({ eligible: sql<number>`count(*)::int` })
    .from(usageEvents)
    .where(
      and(
        gte(usageEvents.createdAt, since),
        sql`${usageEvents.inputTokens} + ${usageEvents.cachedInputTokens} >= 240000 * (${usageEvents.toolCallCount} + 1)`,
      ),
    );

  return row?.eligible ?? 0;
}
