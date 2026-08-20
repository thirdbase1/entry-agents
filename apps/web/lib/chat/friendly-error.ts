/**
 * Central place that decides what error text is safe to show a user in the
 * chat UI.
 *
 * Provider/gateway errors (Opencode Zen, any upstream model API, the
 * Vercel Workflow SDK's transport, plain network failures) can all carry
 * raw response bodies, HTML error pages, stack traces, or vendor-specific
 * text in `error.message`. None of that is safe or useful to show a user
 * verbatim -- it can leak infrastructure details and it's rarely
 * actionable. Every path that can put an error in front of a user must run
 * the error through this function first and use ONLY the returned text.
 *
 * This function never echoes any part of the original error back to the
 * caller -- it only ever returns one of a small, fixed set of friendly
 * strings chosen by classifying the error. That's deliberate: "no matter
 * what the direct error says" should show up, this is the boundary that
 * guarantees it.
 *
 * Used in two places:
 *  - apps/web/app/workflows/chat.ts: as the `onError` for
 *    `result.toUIMessageStream()` (catches in-stream model/tool errors)
 *    and to sanitize the error re-thrown at the end of a failed workflow
 *    run (catches setup/transport-level failures).
 *  - apps/web/app/sessions/[sessionId]/chats/[chatId]/session-chat-content.tsx:
 *    as a last line of defense on the client, in case a raw error ever
 *    reaches `useChat`'s `error` state via a transport-level throw (e.g.
 *    a network failure or a non-2xx HTTP response body) that never went
 *    through the backend mapping above.
 */
/**
 * Marker prefix for errors we deliberately construct ourselves with
 * already-safe, already-friendly text (e.g. the free-tier admin kill
 * switch's "we're at capacity" message, which may include an
 * admin-configured custom reason). toFriendlyChatErrorText strips the
 * marker and returns the remainder verbatim instead of running it through
 * the generic vendor-error classifier below, so these intentional,
 * non-vendor messages don't get swallowed by the catch-all fallback.
 */
export const SAFE_CHAT_ERROR_PREFIX = "__SAFE_CHAT_ERROR__:";

export function toSafeChatError(message: string): Error {
  return new Error(`${SAFE_CHAT_ERROR_PREFIX}${message}`);
}

/**
 * Stable classification bucket for an error. Extracted out of
 * toFriendlyChatErrorText (2026-08-20) so the same classification can
 * also be used to detect REPEAT failures -- i.e. "this chat has hit this
 * same category of error before" -- without needing a second, separately
 * maintained copy of the substring rules. "aborted" is deliberately
 * excluded from repeat-failure treatment by callers: a user-initiated
 * stop is not a failure pattern worth flagging.
 */
export type ChatErrorCategory =
  | "aborted"
  | "rate_limit"
  | "quota"
  | "auth"
  | "timeout"
  | "network"
  | "provider_unavailable"
  | "unknown";

const CATEGORY_MESSAGES: Record<ChatErrorCategory, string> = {
  aborted: "The request was stopped.",
  rate_limit:
    "The AI provider is receiving too many requests right now. Please wait a moment and try again.",
  quota:
    "This model has hit its usage limit and can't respond right now. Try switching to a different model.",
  auth: "There's a temporary problem connecting to the AI provider. Please try again shortly.",
  timeout: "The request took too long and timed out. Please try again.",
  network:
    "Connection issue reaching the AI provider. Please check your connection and try again.",
  provider_unavailable:
    "The AI provider is temporarily unavailable. Please try again in a moment.",
  unknown:
    "Something went wrong while generating a response. Please try again -- if this keeps happening, try switching models.",
};

/** Classifies a raw error (or a raw error-message string pulled back out
 * of workflowRuns.errorMessage for repeat-failure comparison) into one of
 * a small fixed set of buckets, via the same substring signal used to
 * pick the user-facing text. */
export function classifyChatError(error: unknown): ChatErrorCategory {
  const signal = extractErrorSignal(error);

  if (matchesAny(signal, ["abort", "cancelled", "canceled", "stopped"])) {
    return "aborted";
  }

  if (
    matchesAny(signal, [
      "429",
      "rate limit",
      "rate-limit",
      "ratelimit",
      "too many requests",
    ])
  ) {
    return "rate_limit";
  }

  if (
    matchesAny(signal, [
      "usage limit",
      "monthly usage",
      "quota",
      "insufficient",
      "402",
      "credit",
    ])
  ) {
    return "quota";
  }

  if (
    matchesAny(signal, [
      "401",
      "403",
      "unauthorized",
      "forbidden",
      "authentication",
      "invalid api key",
      "invalid_api_key",
      "permission denied",
    ])
  ) {
    return "auth";
  }

  if (matchesAny(signal, ["timeout", "timed out", "etimedout"])) {
    return "timeout";
  }

  if (
    matchesAny(signal, [
      "fetch failed",
      "failed to fetch",
      "econnreset",
      "econnrefused",
      "enotfound",
      "socket hang up",
      "network",
    ])
  ) {
    return "network";
  }

  if (
    matchesAny(signal, [
      "500",
      "502",
      "503",
      "504",
      "bad gateway",
      "service unavailable",
      "internal server error",
    ])
  ) {
    return "provider_unavailable";
  }

  return "unknown";
}

const REPEAT_FAILURE_SUFFIX =
  " This looks like a repeating issue rather than a one-off, so retrying probably won't help -- try switching models, or let us know if it keeps happening.";

/**
 * @param isRepeatFailure When true, appends a note that this chat has hit
 * the same error category before (see countRecentFailuresWithCategory in
 * lib/db/workflow-runs.ts). Never set for "aborted" -- callers should
 * check the category first, a user-initiated stop is never a "repeating
 * issue."
 */
export function toFriendlyChatErrorText(
  error: unknown,
  isRepeatFailure = false,
): string {
  if (
    error instanceof Error &&
    error.message.startsWith(SAFE_CHAT_ERROR_PREFIX)
  ) {
    return error.message.slice(SAFE_CHAT_ERROR_PREFIX.length);
  }

  const category = classifyChatError(error);
  const base = CATEGORY_MESSAGES[category];

  if (isRepeatFailure && category !== "aborted") {
    return `${base}${REPEAT_FAILURE_SUFFIX}`;
  }

  return base;
}

/** Reduces any thrown value to a lowercased classification signal. Never
 * returned to a caller -- used only for internal substring matching. */
function extractErrorSignal(error: unknown): string {
  if (error == null) {
    return "";
  }

  if (typeof error === "string") {
    return error.toLowerCase();
  }

  if (error instanceof Error) {
    const name = error.name ?? "";
    const message = error.message ?? "";
    const statusLike = readNumericField(error, ["statusCode", "status"]);
    return `${name} ${message} ${statusLike}`.toLowerCase();
  }

  try {
    return JSON.stringify(error).toLowerCase();
  } catch {
    return "";
  }
}

function readNumericField(value: unknown, keys: string[]): string {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "number") {
      return String(candidate);
    }
  }
  return "";
}

function matchesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Raw, unsanitized error text for SERVER-SIDE-ONLY diagnostic storage
 * (currently: workflowRuns.errorMessage). NEVER pass this to a client or
 * chat UI -- it deliberately includes the same info toFriendlyChatErrorText
 * strips out (vendor message + first stack line) specifically so admins
 * can root-cause a failure after Vercel's runtime-log retention window
 * (as short as ~1hr on Hobby) has expired. Added 2026-08-20 after a real
 * incident where a repeatedly-failing turn's actual cause was permanently
 * unrecoverable once the log window passed, even though the failure was
 * clearly deterministic (same error on every retry).
 */
export function serializeErrorForDiagnostics(
  error: unknown,
  maxLen = 4000,
): string {
  let text: string;
  if (error instanceof Error) {
    const firstStackLine = error.stack?.split("\n")[1]?.trim();
    text = [
      `${error.name}: ${error.message}`,
      error.cause instanceof Error
        ? `cause: ${error.cause.name}: ${error.cause.message}`
        : undefined,
      firstStackLine,
    ]
      .filter(Boolean)
      .join(" | ");
  } else {
    try {
      text = JSON.stringify(error);
    } catch {
      text = String(error);
    }
  }
  return text.slice(0, maxLen);
}
