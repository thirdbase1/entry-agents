import type { WebAgentUIMessage } from "@/app/types";
import type { ChatUiStatus } from "@/lib/chat-streaming-state";
import { isFriendlyChatErrorText } from "@/lib/chat/friendly-error";

export const STREAM_RECOVERY_STALL_MS = 4_000;
export const STREAM_RECOVERY_MIN_INTERVAL_MS = 8_000;

export type ChatStreamingProbeResponse = {
  chats: { id: string; isStreaming: boolean }[];
};

export type StreamRecoveryDecision = "none" | "retry-error" | "probe";

/**
 * Whether recovery should be triggered on visibility/focus events.
 * `isVisibilityRecovery` is true when called from a visibilitychange or
 * focus event — in that case we also probe when the chat appears idle
 * ("ready") because the browser may have silently killed the connection
 * while the tab was backgrounded.
 */
export function getStreamRecoveryDecision(options: {
  now: number;
  lastRecoveryAt: number;
  status: ChatUiStatus;
  hasAssistantRenderableContent: boolean;
  inFlightStartedAt: number | null;
  isProbeInFlight: boolean;
  isVisibilityRecovery?: boolean;
  minIntervalMs?: number;
  stallMs?: number;
}): StreamRecoveryDecision {
  const {
    now,
    lastRecoveryAt,
    status,
    isProbeInFlight,
    isVisibilityRecovery = false,
    minIntervalMs = STREAM_RECOVERY_MIN_INTERVAL_MS,
  } = options;

  if (now - lastRecoveryAt < minIntervalMs) {
    return "none";
  }

  if (status === "error") {
    return "retry-error";
  }

  // When the tab regains visibility and the chat looks idle, probe the
  // server to check if a workflow is still running. The browser may have
  // silently dropped the connection while the tab was backgrounded.
  if (isVisibilityRecovery && status === "ready") {
    if (isProbeInFlight) {
      return "none";
    }
    return "probe";
  }

  return "none";
}

export function shouldScheduleStallRecovery(options: {
  isChatInFlight: boolean;
  hasAssistantRenderableContent: boolean;
  isDocumentVisible: boolean;
}): boolean {
  void options;

  return false;
}

export function getStreamRecoveryDelayMs(options: {
  now: number;
  inFlightStartedAt: number | null;
  stallMs?: number;
}): number {
  const {
    now,
    inFlightStartedAt,
    stallMs = STREAM_RECOVERY_STALL_MS,
  } = options;
  const elapsed = inFlightStartedAt === null ? 0 : now - inFlightStartedAt;
  return Math.max(0, stallMs - elapsed);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isChatStreamingProbeResponse(
  value: unknown,
): value is ChatStreamingProbeResponse {
  if (!isObjectRecord(value)) {
    return false;
  }

  const chats = value["chats"];
  if (!Array.isArray(chats)) {
    return false;
  }

  return chats.every(
    (chat) =>
      isObjectRecord(chat) &&
      typeof chat["id"] === "string" &&
      typeof chat["isStreaming"] === "boolean",
  );
}

// --- Dead-turn retry action (continue / regenerate / none) ---------------
//
// Owner-reported bug (2026-09-13): when a turn dies from a gateway error
// mid-response and the user hits the Retry button, the old behavior
// always called `chat.regenerate()` -- which DELETES the partial
// assistant message and re-runs the whole turn from the last user
// message. Result: the agent visibly repeats everything it had already
// said/done (burning the same tool calls and tokens again), and if the
// gateway error is still live it dies the exact same way -- so retrying
// "doesn't continue" either.
//
// Second pass, same day (owner: "improve the whole retry process, both
// retries"): the decision is now strategy-aware and shared by BOTH the
// manual Retry button ("hard") and automatic recovery ("soft" --
// visibility/focus/online events, the stall watchdog). The server
// already sanitizes dangling tool calls (convertMessages runs with
// ignoreIncompleteToolErrors) and persists the client's assistant
// messages (persistAssistantMessagesWithToolResults in POST
// /api/chat), so a continued turn picks up mid-task cleanly.
//
// Action semantics:
// - "continue": the dead turn left real partial work (completed tool
//   calls, data parts, or real text that isn't just the friendly error
//   notice) -- send CONTINUE_AFTER_ERROR_PROMPT so the model picks up
//   where it stopped. Safe for BOTH strategies: continuing never
//   repeats completed work, so auto-recovery may self-heal a dead turn
//   without the user asking (e.g. a mobile network blip while the tab
//   was backgrounded).
// - "regenerate": nothing worth keeping (turn died before any output,
//   or the last assistant message is just the persisted error notice) --
//   drop the dead turn and re-run it. MANUAL ONLY: a full re-run spends
//   the user's tokens again, so automatic recovery must never fire this
//   on its own.
// - "none": dead turn, nothing worth continuing, and we're in auto
//   recovery -- do nothing and keep the error visible for the user.
//
// Stacking guard: if the LAST message is already a failed
// CONTINUE_AFTER_ERROR_PROMPT (a previous continue attempt errored out
// before producing any new assistant message), never stack a second
// continuation message on top of it. Soft does nothing (the user can
// still tap Retry); hard resubmits the existing prompt via
// `regenerate()`, which for a trailing user message keeps it in
// history and re-submits it (verified against the SDK's regenerate()
// implementation) -- so the partial assistant work below it survives.

export const CONTINUE_AFTER_ERROR_PROMPT =
  "Continue from exactly where you left off. Do not repeat any completed work, tool calls, or text you already produced -- just carry the task forward.";

export type RetryStrategy = "hard" | "soft";

export type DeadTurnRetryAction = "continue" | "regenerate" | "none";

/**
 * Decides what to do once we know the server-side stream for the
 * current turn is dead (resumeStream() attached to nothing). See the
 * block comment above for the full action semantics.
 */
export function getDeadTurnRetryAction(
  messages: WebAgentUIMessage[],
  strategy: RetryStrategy,
): DeadTurnRetryAction {
  const last = messages[messages.length - 1];

  // A previous continue attempt already failed -- never stack another
  // continuation prompt on top of the existing one.
  if (
    last?.role === "user" &&
    last.parts.some(
      (part) =>
        part.type === "text" && part.text === CONTINUE_AFTER_ERROR_PROMPT,
    )
  ) {
    return strategy === "hard" ? "regenerate" : "none";
  }

  // No assistant response at all (turn died before any output) -- a
  // continuation prompt would have nothing to continue from.
  if (!last || last.role !== "assistant") {
    return strategy === "hard" ? "regenerate" : "none";
  }

  const hasRealPartialWork = last.parts.some((part) => {
    // Completed (or in-flight) tool calls, data parts, files, sources,
    // and reasoning all represent real work worth keeping.
    if (
      part.type.startsWith("tool-") ||
      part.type.startsWith("data-") ||
      part.type.startsWith("source-") ||
      part.type === "file" ||
      part.type === "reasoning"
    ) {
      return true;
    }
    if (part.type === "text") {
      const text = part.text.trim();
      // Real partial text counts; the workflow's setup-error notice
      // (a friendly-error string) does NOT -- continuing from an
      // error-only message would keep the useless notice in history.
      return text.length > 0 && !isFriendlyChatErrorText(text);
    }
    return false;
  });

  if (hasRealPartialWork) {
    return "continue";
  }
  return strategy === "hard" ? "regenerate" : "none";
}
