import type { LanguageModel, ModelMessage } from "ai";
import {
  compactToolData,
  findPendingCompactionCandidates,
  indexToolCalls,
} from "./aggressive-compaction-helpers";
import { getContextWindowForModel } from "./context-windows";

/**
 * Fraction of the model's context window that, once crossed, triggers
 * auto-compaction of older tool call/result payloads. Comparable to
 * Claude Code's auto-compact (which fires around ~90-95%); we trigger a
 * bit earlier since Entry's window is also shared with the system prompt,
 * skills, and (for some turns) a subagent call.
 */
export const AUTO_COMPACT_THRESHOLD = 0.8;

/**
 * How many of the most recent messages are protected from compaction --
 * their tool calls/results stay verbatim so the model always has full,
 * unsummarized detail on what it *just* did. Everything older than this
 * window is eligible to have its tool call/result payloads collapsed down
 * to a short placeholder (see aggressive-compaction-helpers.ts).
 */
export const PROTECTED_RECENT_MESSAGES = 12;

const COMPACTED_TOOL_NOTICE =
  "[Older tool output removed by auto-compaction to stay within the model's context window. " +
  "Re-run the tool if you need the original output again.]";

/**
 * Rough token estimate for a batch of ModelMessages. Same heuristic the
 * existing compaction-savings helper already uses (JSON length / 4) --
 * good enough for a threshold check, not meant to match a real tokenizer
 * exactly.
 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += JSON.stringify(message).length;
  }
  return Math.ceil(chars / 4);
}

function getModelId(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

/**
 * Auto-compaction: once the estimated token count for the current message
 * history crosses AUTO_COMPACT_THRESHOLD of the model's context window,
 * collapse tool call/result payloads older than the most recent
 * PROTECTED_RECENT_MESSAGES messages down to a short placeholder. Regular
 * user/assistant text is never touched -- only bulky tool call inputs and
 * tool result outputs (bash output, file reads, grep results, etc.), which
 * is almost always what actually fills up the window on long sessions.
 *
 * Wired into open-agent.ts's prepareStep, ahead of addCacheControl.
 */
export function maybeCompactMessages({
  messages,
  model,
}: {
  messages: ModelMessage[];
  model: LanguageModel;
}): ModelMessage[] {
  if (messages.length <= PROTECTED_RECENT_MESSAGES) {
    return messages;
  }

  const contextWindow = getContextWindowForModel(getModelId(model));
  const estimatedTokens = estimateMessagesTokens(messages);

  if (estimatedTokens < contextWindow * AUTO_COMPACT_THRESHOLD) {
    return messages;
  }

  const toolCallIndex = indexToolCalls(messages);

  // Protect the tail: any tool-call key that appears anywhere in the last
  // PROTECTED_RECENT_MESSAGES messages is treated as "recent" and skipped,
  // even if its paired call/result sits just outside the protected window.
  const recentToolCallKeys = new Set<string>();
  const recentStart = messages.length - PROTECTED_RECENT_MESSAGES;
  for (
    let messageIndex = recentStart;
    messageIndex < messages.length;
    messageIndex++
  ) {
    const partKeys = toolCallIndex.byLocation.get(messageIndex);
    if (!partKeys) continue;
    for (const key of partKeys.values()) {
      recentToolCallKeys.add(key);
    }
  }

  const pendingCandidates = findPendingCompactionCandidates({
    messages,
    toolCallIndex,
    recentToolCallKeys,
    compactedToolNotice: COMPACTED_TOOL_NOTICE,
  });

  if (
    pendingCandidates.pendingToolCallKeys.size === 0 &&
    pendingCandidates.pendingAnonymousToolResults === 0
  ) {
    return messages;
  }

  console.warn(
    `[auto-compact] ~${estimatedTokens} tokens (~${Math.round(
      (estimatedTokens / contextWindow) * 100,
    )}% of ${contextWindow}) -- compacting ${pendingCandidates.pendingToolCallKeys.size} tool call(s) and ${pendingCandidates.pendingAnonymousToolResults} anonymous tool result(s) older than the last ${PROTECTED_RECENT_MESSAGES} messages.`,
  );

  return compactToolData({
    messages,
    toolCallIndex,
    pendingCandidates,
    compactedToolNotice: COMPACTED_TOOL_NOTICE,
  });
}
