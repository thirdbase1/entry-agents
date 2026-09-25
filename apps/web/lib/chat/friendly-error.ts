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
  | "usage_window"
  | "quota"
  | "auth"
  | "timeout"
  | "network"
  | "provider_unavailable"
  // Specific buckets added after the 2026-09-24 log review. Each one was
  // falling through to "unknown" and showing the user a generic
  // "Something went wrong", even though the real cause was both known and
  // actionable. Keep these ABOVE the generic buckets in
  // classifyChatError: classification is first-match-wins.
  | "blocked"
  | "model_unavailable"
  | "invalid_prompt"
  | "no_output"
  | "workspace"
  | "unknown";

const CATEGORY_MESSAGES: Record<ChatErrorCategory, string> = {
  aborted: "The request was stopped.",
  rate_limit:
    "The AI provider is receiving too many requests right now. Please wait a moment and try again.",
  usage_window:
    "This plan's usage window is full. Entry limits spend over rolling 7-day, 5-hour, and 30-day windows; each refills automatically as older usage ages out. Open Settings > Usage to see exactly when yours resets, or upgrade the plan to raise the ceiling.",
  quota:
    "This model has hit its usage limit and can't respond right now. Try switching to a different model.",
  auth: "There's a temporary problem connecting to the AI provider. Please try again shortly.",
  timeout: "The request took too long and timed out. Please try again.",
  network:
    "Connection issue reaching the AI provider. Please check your connection and try again.",
  provider_unavailable:
    "The AI provider is temporarily unavailable. Please try again in a moment.",
  blocked:
    "The model provider refused this message under its content policy, so no reply was generated. That is a refusal at the provider, not a bug -- reword the message, or pick a different model and send it again.",
  model_unavailable:
    "Your selected model isn't available on the gateway right now, so the turn couldn't start. Open Settings > Models, pick a model that works, and resend.",
  invalid_prompt:
    "This chat's stored history is no longer in a shape the model accepts -- usually an interrupted or partially-failed previous turn. Send the message again; if it keeps happening, start a new chat from this session.",
  no_output:
    "The model connected but returned an empty response. Send the message again, or switch to a different model if it repeats.",
  workspace:
    "Your workspace (sandbox) isn't reachable, so the agent has no shell or file tools for this turn. It normally comes back on its own within a minute -- resend, or open the sandbox panel and start it manually.",
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

  // ---- Specific buckets (first-match-wins; see ChatErrorCategory) ----

  // Provider content refusal (observed: HTTP 451 / type
  // "censorship_blocked" from entry-gateway). Distinct from `quota`:
  // the model did not run out of budget, it declined the content.
  if (
    matchesAny(signal, [
      "censorship",
      "content policy",
      "content you provided",
      "status code 451",
      " 451 ",
      "blocked by the provider",
    ])
  ) {
    return "blocked";
  }

  // The conversation replayed into convertToModelMessages no longer
  // satisfies the ModelMessage[] schema -- an interrupted/partial turn,
  // or a tool result carrying a type the schema rejects (a Date).
  if (
    matchesAny(signal, [
      "invalid prompt",
      "modelmessage",
      "messages do not match",
      "type validation failed",
    ])
  ) {
    return "invalid_prompt";
  }

  // Gateway has no route for the requested model (observed: "No
  // openai-chat route is configured for qwen3.8-flash" -> 404).
  if (
    matchesAny(signal, [
      "route is configured for",
      "no such model",
      "model not found",
      "is not a valid model",
      "unknown model",
    ])
  ) {
    return "model_unavailable";
  }

  // Stream ended without producing a single token.
  if (matchesAny(signal, ["no output generated", "no output"])) {
    return "no_output";
  }

  // Workspace unreachable. Checked BEFORE `auth` because a scoped Boat key
  // rejects calls with 403 "api_key_action_forbidden", which would
  // otherwise be reported as an AI-provider auth problem -- the wrong
  // subsystem entirely.
  if (
    matchesAny(signal, [
      "sandbox not initialized",
      "workspace for this session is still starting",
      "workspace is not reachable",
      "api_key_action_forbidden",
      "api_key_expired",
      "boat api error",
      "cannot perform sandbox",
      "sandbox.resume",
      "boAt_configuration",
      "boat_api_key is not set",
    ])
  ) {
    return "workspace";
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

  // Rolling usage windows (weekly / 5-hour / 30-day). Classified before
  // `quota` because those messages say "usage" too but the recovery is
  // different: wait for the window to age out or raise the plan, not
  // "switch models". Seen in production when the wrapper defeated the
  // SAFE_CHAT_ERROR path.
  if (
    matchesAny(signal, [
      "usage window",
      "window is full",
      "rolling 7 days",
      "rolling 7-day",
      "per rolling",
      "weekly usage",
      "30-day window",
      "30 days",
      "5-hour",
      "5 hour window",
    ])
  ) {
    return "usage_window";
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
  const safeMessage = extractSafeChatError(error);
  if (safeMessage !== null) {
    return safeMessage;
  }

  const category = classifyChatError(error);
  const base = CATEGORY_MESSAGES[category];

  if (isRepeatFailure && category !== "aborted") {
    return `${base}${REPEAT_FAILURE_SUFFIX}`;
  }

  return base;
}

/**
 * Find an intentionally-safe message (see SAFE_CHAT_ERROR_PREFIX) anywhere
 * in an error, not only at position 0.
 *
 * The Workflow SDK wraps step failures before they reach the caller, so the
 * real message arrives as
 *
 *   FatalError: Step ".../resolveChatModelRuntime" failed after 3 retries:
 *   __SAFE_CHAT_ERROR__:Your Entry plan's weekly usage window is full ...
 *
 * The old `message.startsWith(marker)` check therefore never matched a
 * wrapped error, the text fell through to the `unknown` bucket, and the user
 * was shown "Something went wrong while generating a response" while the
 * precise, actionable reason (a specific exhausted usage window) sat right
 * there in the message. Observed in production 2026-09-25.
 *
 * Walks the `cause` chain as well, because the SDK also re-throws the
 * original as `error.cause`.
 */
function extractSafeChatError(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; current != null && depth < 6; depth++) {
    if (typeof current === "object") {
      if (seen.has(current)) return null;
      seen.add(current);
    }

    const text =
      typeof current === "string"
        ? current
        : current instanceof Error
          ? current.message
          : null;

    if (text) {
      const index = text.indexOf(SAFE_CHAT_ERROR_PREFIX);
      if (index !== -1) {
        const payload = text.slice(index + SAFE_CHAT_ERROR_PREFIX.length).trim();
        if (payload.length > 0) {
          return payload;
        }
      }
    }

    if (typeof current !== "object" || current === null) {
      return null;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return null;
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

/**
 * True when the given text is one of the fixed friendly error strings
 * this module produces (optionally with the repeat-failure suffix
 * appended). Used by the client's hard-retry flow to distinguish an
 * assistant message that is ONLY an error notice -- e.g. the workflow's
 * setup-error message persisted when a turn dies before producing any
 * real output, which has nothing worth continuing from -- from a real
 * partial response the agent should pick up from instead of
 * regenerating.
 *
 * Admin-configured SAFE_CHAT_ERROR custom messages won't match; for
 * those, callers keep their default (regenerate) behavior, which is
 * safe: at worst we re-run a turn that produced nothing but an error
 * notice.
 */
export function isFriendlyChatErrorText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return Object.values(CATEGORY_MESSAGES).some(
    (message) => trimmed === message || trimmed.startsWith(message),
  );
}
