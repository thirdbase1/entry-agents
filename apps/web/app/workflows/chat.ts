import {
  APICallError,
  convertToModelMessages,
  type FinishReason,
  generateId as generateIdAi,
  isToolUIPart,
  type LanguageModelUsage,
  type ModelMessage,
  pruneMessages,
  type UIMessageChunk,
} from "ai";
import {
  createMcpToolSet,
  type GithubApiResult,
  type GithubRawCliResult,
  type OpenAgentCallOptions,
  type VercelApiResult,
  type VercelCliToolResult,
} from "@open-agents/agent";
import { FatalError, getWorkflowMetadata, getWritable } from "workflow";
import { getRun } from "workflow/api";
import { assistantFileLinkPrompt } from "@/lib/assistant-file-links";
import { addLanguageModelUsage } from "./usage-utils";
import { estimateStepCost } from "./gateway-metadata";
import type {
  WebAgentCommitData,
  WebAgentCommitDataPart,
  WebAgentMessageMetadata,
  WebAgentPrData,
  WebAgentPrDataPart,
  WebAgentStepCostBreakdown,
  WebAgentStepFinishMetadata,
  WebAgentUIMessage,
} from "@/app/types";
import {
  claimActiveStream,
  closeStream,
  clearActiveStream,
  releaseUserBillingTurnStep,
  hasAutoCommitChangesStep,
  persistAssistantMessage,
  persistAssistantMessageWithToolResults,
  persistSandboxState,
  persistUserMessage,
  recordWorkflowUsage,
  refreshDiffCache,
  refreshLifecycleActivity,
  runAutoCommitStep,
  runAutoCreatePrStep,
  sendFinish,
} from "./chat-post-finish";
import { dedupeMessageReasoning } from "@/lib/chat/dedupe-message-reasoning";
import { canonicalizeMessageParts } from "@/lib/chat/canonicalize-key-order";
import {
  type ChatErrorCategory,
  classifyChatError,
  serializeErrorForDiagnostics,
  toFriendlyChatErrorText,
  toSafeChatError,
} from "@/lib/chat/friendly-error";
import { getChatById, getSessionById } from "@/lib/db/sessions";
import { getUserPreferences } from "@/lib/db/user-preferences";
import {
  sanitizeSelectedModelIdForSession,
  sanitizeUserPreferencesForSession,
} from "@/lib/model-access";
import { APP_DEFAULT_MODEL_ID, type AvailableModel } from "@/lib/models";
import type { Session as AuthSession } from "@/lib/session/types";
import type {
  WorkflowRunStatus,
  WorkflowRunStepTiming,
} from "@/lib/db/workflow-runs";
import {
  type PendingImageAttachment,
  persistImageAttachmentsToSandbox,
  resolveChatSandboxRuntime,
} from "./chat-sandbox-runtime";

type AuthSessionContext = Pick<AuthSession, "authProvider" | "user"> | null;

type Options = {
  messages: WebAgentUIMessage[];
  chatId: string;
  sessionId: string;
  userId: string;
  requestUrl: string;
  authSession: AuthSessionContext;
  selectedModelId?: string;
  modelId?: string;
  agentOptions?: Omit<OpenAgentCallOptions, "sandbox" | "skills">;
  assistantId?: string;
  inputMessagesPersisted?: boolean;
  maxSteps?: number;
  autoCommitEnabled?: boolean;
  autoCreatePrEnabled?: boolean;
};

type ChatModelRuntime = {
  selectedModelId: string;
  modelId: string;
  agentOptions: Omit<OpenAgentCallOptions, "sandbox" | "skills">;
  autoCommitEnabled: boolean;
  autoCreatePrEnabled: boolean;
  /** This turn's credit balance (cents) at the moment the turn started --
   * threaded into runAgentStep so it can decrement it in real time after
   * every model step and abort mid-turn on exhaustion. See the block
   * above that computes it for why admins get a value too. */
  startingBalanceCents: number;
  /** True for non-admins -- controls whether runAgentStep is allowed to
   * abort the stream when the running balance hits zero. Admins are
   * still billed (see runAgentStep) but never blocked. */
  enforceCreditBlock: boolean;
};

type Writable = WritableStream<UIMessageChunk>;

// The `github.commitAndPush` closure below captures live runtime state
// (sandbox connections, DB handles) and cannot cross a workflow-step
// serialization boundary -- Workflow SDK only serializes plain data
// (see workflow-sdk.dev/docs/foundations/serialization), not functions.
// Passing a closure as a step argument works fine until the workflow
// actually needs to durably suspend/resume mid-turn, at which point
// serializing that argument throws a SerializationError and silently
// kills the run (the chat then "thinks" forever with no error surfaced).
// So we thread only serializable data across the boundary here, and
// rebuild the real `commitAndPush` closure *inside* runAgentStep (which
// is already a step function with full Node/DB access).
type SerializableGithubContext = {
  hasRepo: boolean;
  repoOwner?: string;
  repoName?: string;
};
// Same reasoning as SerializableGithubContext above -- `vercel.run` is a
// closure and can't cross the workflow-to-step serialization boundary,
// so only the plain `connected` flag travels with the workflow; the real
// closure is rebuilt inside runAgentStep, right next to `commitAndPush`.
type SerializableVercelContext = {
  connected: boolean;
};
type WorkflowAgentOptions = Omit<OpenAgentCallOptions, "github" | "vercel"> & {
  github?: SerializableGithubContext;
  vercel?: SerializableVercelContext;
};

const shouldPauseForToolInteraction = (parts: WebAgentUIMessage["parts"]) =>
  parts.some(
    (part) =>
      isToolUIPart(part) &&
      (part.state === "input-available" || part.state === "approval-requested"),
  );

const DIFF_REFRESHING_TOOL_TYPES = new Set([
  "tool-write",
  "tool-edit",
  "tool-bash",
]);

function shouldRefreshDiffCacheForParts(
  parts: WebAgentUIMessage["parts"],
): boolean {
  return parts.some(
    (part) =>
      isToolUIPart(part) &&
      DIFF_REFRESHING_TOOL_TYPES.has(part.type) &&
      (part.state === "output-available" || part.state === "output-error"),
  );
}

// Owner decision (2026-08-12): image attachments are never re-sent to the
// model as raw multimodal content. Instead they're written once into the
// session's sandbox (see persistImageAttachmentsToSandbox) and the model
// only ever sees the resulting file path -- nothing else, no caption, no
// restated filename. The agent already has `read`/`bash` tools to look at
// the file itself if it's relevant to the turn.
function extractPendingImageAttachments(
  messages: WebAgentUIMessage[],
): PendingImageAttachment[] {
  const images: PendingImageAttachment[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "file" && part.mediaType.startsWith("image/")) {
        images.push({ mediaType: part.mediaType, dataUrl: part.url });
      }
    }
  }
  return images;
}

function replaceImageAttachmentsWithPaths(
  messages: WebAgentUIMessage[],
  paths: string[],
): WebAgentUIMessage[] {
  let pathIndex = 0;
  return messages.map((message) => {
    let mutated = false;
    const parts = message.parts.map((part) => {
      if (part.type === "file" && part.mediaType.startsWith("image/")) {
        const path = paths[pathIndex];
        pathIndex += 1;
        mutated = true;
        // Path only -- no other text, per owner instruction.
        return { type: "text" as const, text: path };
      }
      return part;
    });
    return mutated ? { ...message, parts } : message;
  });
}

const convertMessages = async (
  messages: WebAgentUIMessage[],
): Promise<ModelMessage[]> => {
  "use step";
  const { webAgent } = await import("@/app/config");
  const dedupedMessages = messages
    .map(dedupeMessageReasoning)
    .map(canonicalizeMessageParts);
  const modelMessages = await convertToModelMessages<WebAgentUIMessage>(
    dedupedMessages,
    {
      ignoreIncompleteToolCalls: true,
      tools: webAgent.tools,
      convertDataPart: (part) => {
        if (part.type === "data-snippet") {
          const { filename, content } = part.data;
          return {
            type: "text",
            text: JSON.stringify({ type: "snippet", filename, content }),
          };
        }
        return undefined;
      },
    },
  );

  return pruneMessages({
    messages: modelMessages,
    emptyMessages: "remove",
  });
};

/**
 * Defensive guard against AI_MissingToolResultsError (real incident,
 * 2026-08-17: a chat's turn started failing identically on every retry --
 * "Tool result is missing for tool call X" -- 4 attempts in a row, same
 * toolCallId every time, then a fatal AI_NoOutputGeneratedError once the
 * Workflow SDK's step retries ran out). Root cause: `modelMessages` is
 * appended to directly across step iterations (see
 * `modelMessages.push(...result.responseMessages)` in the main loop
 * below) using the raw AI SDK response messages, which is NOT run back
 * through `convertMessages`'s `ignoreIncompleteToolCalls: true` --
 * that sanitization only ever runs once, on the turn's ORIGINAL history
 * from the DB. If a tool-call ends up in `response.messages` without a
 * matching tool-result (e.g. the step aborted mid tool-execution from
 * real-time credit-exhaustion/turn-spend-cap billing, or any other path
 * that stops generation between the tool-call and its result), that
 * broken pair then poisons every subsequent model call for the rest of
 * the turn -- and because the Workflow SDK retries the exact same step
 * input on transient failures, it fails the identical way every retry
 * until the whole turn dies with an empty response.
 *
 * Called right after every append to `modelMessages` so the array going
 * into the next `runAgentStep` call can never contain an orphaned
 * tool-call, regardless of which path produced it. Mutates the array
 * in place (via splice) since `modelMessages` is a `const` binding to a
 * shared array across the loop.
 */
function stripDanglingToolCalls(messages: ModelMessage[]): void {
  const resultedToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          resultedToolCallIds.add(part.toolCallId);
        }
      }
    }
  }

  const sanitized = messages
    .map((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        return message;
      }
      const filteredContent = message.content.filter(
        (part) =>
          part.type !== "tool-call" || resultedToolCallIds.has(part.toolCallId),
      );
      if (filteredContent.length === message.content.length) {
        return message;
      }
      return { ...message, content: filteredContent };
    })
    .filter((message) => {
      if (message.role !== "assistant") {
        return true;
      }
      return !Array.isArray(message.content) || message.content.length > 0;
    });

  if (
    sanitized.length !== messages.length ||
    sanitized.some((message, index) => message !== messages[index])
  ) {
    messages.splice(0, messages.length, ...sanitized);
  }
}

// Owner decision (2026-08-12): permission mode (ask / autoAccept /
// fullAccess) must be changeable "anytime, per model turn" -- not frozen
// for the whole assistant response the way it used to be. The multi-step
// tool-calling loop below drives one agent step per loop iteration, so we
// re-read the live value fresh before every single step instead of baking
// it into `agentOptions` once before the loop starts. That way a mode
// change made mid-turn (while the agent is still working through tool
// calls) takes effect on the very next step, not just on the next chat
// message.
async function resolveCurrentPermissionMode(params: {
  userId: string;
  sessionId: string;
}): Promise<"ask" | "autoAccept" | "fullAccess"> {
  "use step";

  const [sessionRecord, rawPreferences] = await Promise.all([
    getSessionById(params.sessionId),
    getUserPreferences(params.userId).catch((error) => {
      console.error(
        "Failed to load user preferences for live permission mode check:",
        error,
      );
      return null;
    }),
  ]);

  return (
    sessionRecord?.permissionModeOverride ??
    rawPreferences?.defaultPermissionMode ??
    "ask"
  );
}

async function resolveChatModelRuntime(params: {
  userId: string;
  sessionId: string;
  chatId: string;
  requestUrl: string;
  authSession: AuthSessionContext;
  workflowRunId: string;
}): Promise<ChatModelRuntime> {
  "use step";

  // Dynamic import (not a static top-of-file import) is required here:
  // model-selection.ts transitively touches the drizzle db client
  // ("postgres", a Node built-in) via lib/model-availability.ts's admin
  // kill-switch check, and the Workflow SDK's bundler pulls in a
  // statically-imported function's *entire* module graph into the
  // restricted "use workflow" bundle even when it's only ever called
  // from this "use step" function -- same reasoning as
  // performAgentCommitAndPush/checkVercelConnectedStep/etc. above.
  const { resolveChatModelSelection } =
    await import("../api/chat/_lib/model-selection");

  const [sessionRecord, chat, rawPreferences] = await Promise.all([
    getSessionById(params.sessionId),
    getChatById(params.chatId),
    getUserPreferences(params.userId).catch((error) => {
      console.error("Failed to load user preferences:", error);
      return null;
    }),
  ]);

  if (!sessionRecord) {
    throw new Error("Session not found");
  }
  if (sessionRecord.userId !== params.userId) {
    throw new Error("Unauthorized");
  }
  if (!chat || chat.sessionId !== params.sessionId) {
    throw new Error("Chat not found");
  }

  // Free-tier admin kill switch: checked once here, and re-polled by
  // startStopMonitor for the duration of the turn (see that function) so
  // an admin flipping the switch mid-response aborts the stream within
  // one poll tick instead of only blocking the *next* turn. Dynamic
  // imports here for the same reason as resolveChatModelSelection above --
  // both transitively touch the drizzle db client, which the Workflow
  // SDK bundler would otherwise pull into the restricted "use workflow"
  // graph via this "use step" function's static imports.
  const { isUserAdmin } = await import("@/lib/db/users");
  const { getFreeTierGateStatus } = await import("@/lib/db/platform-settings");
  const isAdminUser = await isUserAdmin(params.userId);
  if (!isAdminUser) {
    const gate = await getFreeTierGateStatus();
    if (!gate.enabled) {
      // Use the safe-error marker so this intentional, already-friendly
      // message reaches the user verbatim instead of being swallowed by
      // toFriendlyChatErrorText's generic vendor-error catch-all (see
      // that function's docstring -- this was previously showing as
      // "Something went wrong while generating a response" for free-tier
      // users, which is confusing and non-actionable).
      throw toSafeChatError(
        gate.reason ||
          "We're at capacity right now -- please check back in a little while.",
      );
    }
  }

  const preferences = rawPreferences
    ? sanitizeUserPreferencesForSession(
        rawPreferences,
        params.authSession,
        params.requestUrl,
      )
    : null;
  let selectedModelId =
    sanitizeSelectedModelIdForSession(
      chat.modelId,
      params.authSession,
      params.requestUrl,
    ) ??
    chat.modelId ??
    null;

  // Per-user plan gating (billing): Free plan is hard-restricted to
  // FREE_PLAN_MODEL_ID and hard-blocks once its trial credit is spent
  // (reusing the exact same free-tier-gate error marker/composer-lock UI
  // as the admin kill-switch above). Soft-cutoff (silently downgrading a
  // depleted paid account to a cheap fallback model) was REMOVED per
  // owner instruction on 2026-08-17 -- every plan now hard-blocks the
  // instant its balance hits zero instead of quietly swapping models.
  // Admins are exempt from the block (checked above), same as the
  // free-tier kill switch -- but their spend is still tracked (see
  // startingBalanceCents below, threaded into runAgentStep for
  // real-time per-step debiting during the turn).
  //
  // `startingBalanceCents` is fetched here (once per turn) and passed
  // out so runAgentStep can decrement it after every model step and
  // abort mid-turn the instant it goes to zero, instead of only
  // discovering the overspend in one lump sum after the whole turn
  // finishes (see the old chat-post-finish.ts behavior this replaces).
  let startingBalanceCents = 0;
  if (!isAdminUser) {
    const { getUserBillingState, claimUserBillingTurn } =
      await import("@/lib/billing/credit-ledger");
    const {
      getPlanDefinition,
      FREE_PLAN_MODEL_ID,
      FREE_TIER_ALLOWED_MODEL_IDS,
    } = await import("@/lib/billing/plans");

    // Claim the per-user billing-turn lock BEFORE reading the balance
    // that this turn will spend against. Without this, two concurrent
    // turns for the same user (e.g. two open chat tabs) could each read
    // the same starting balance and each be allowed to spend up to it
    // before either one's own in-memory counter (see runAgentStep)
    // notices -- a real double-spend window despite the ledger writes
    // themselves being atomic. See claimUserBillingTurn's docstring for
    // the staleness fallback that keeps a crashed workflow from
    // permanently locking a user out.
    const claimedTurn = await claimUserBillingTurn(
      params.userId,
      params.workflowRunId,
    );
    if (!claimedTurn) {
      throw toSafeChatError(
        "You already have another chat generating a response -- wait for it to finish, then try again.",
      );
    }

    const billingState = await getUserBillingState(params.userId);
    const plan = getPlanDefinition(billingState?.plan);
    const balanceCents = billingState?.creditBalanceCents ?? 0;
    startingBalanceCents = balanceCents;

    // 2026-08-19: Free-plan users can also pick any owner-sponsored $0
    // model in FREE_TIER_ALLOWED_MODEL_IDS (e.g. ling-3.0-flash-free)
    // without being force-swapped to Luna -- only fall back to Luna if
    // they haven't picked one of the allowed free models.
    if (
      plan.modelAccess === "luna-only" &&
      !FREE_TIER_ALLOWED_MODEL_IDS.includes(selectedModelId ?? "")
    ) {
      selectedModelId = FREE_PLAN_MODEL_ID;
    }

    if (balanceCents <= 0) {
      throw toSafeChatError(
        plan.modelAccess === "luna-only"
          ? "Free tier ended, upgrade your account to use Entry"
          : "You're out of credit -- add more to keep chatting.",
      );
    }
  } else {
    // Admins are never blocked, but their usage is still billed (see
    // runAgentStep) -- fetch their balance too so it stays accurate,
    // just without any gating decision riding on it.
    const { getUserBillingState } = await import("@/lib/billing/credit-ledger");
    const billingState = await getUserBillingState(params.userId);
    startingBalanceCents = billingState?.creditBalanceCents ?? 0;
  }
  const [mainModelSelection, subagentModelSelection] = await Promise.all([
    resolveChatModelSelection({
      selectedModelId,
      reasoningEffort: chat.reasoningEffort,
      missingModelLabel: "Selected model",
    }),
    preferences?.defaultSubagentModelId
      ? resolveChatModelSelection({
          selectedModelId: sanitizeSelectedModelIdForSession(
            preferences.defaultSubagentModelId,
            params.authSession,
            params.requestUrl,
          ),
          missingModelLabel: "Subagent model",
        })
      : Promise.resolve(undefined),
  ]);
  const autoCommitEnabled =
    (sessionRecord.autoCommitPushOverride ??
      preferences?.autoCommitPush ??
      false) &&
    Boolean(sessionRecord.repoOwner && sessionRecord.repoName);
  const autoCreatePrEnabled =
    autoCommitEnabled &&
    (sessionRecord.autoCreatePrOverride ?? preferences?.autoCreatePr ?? false);
  // Permission mode: session-level override wins, otherwise fall back to
  // the user's default preference, otherwise "ask". See
  // packages/agent/open-agent.ts (experimental_context.permissionMode)
  // and tools/{bash,read,write,fetch}.ts for what each mode actually
  // gates.
  const permissionMode: "ask" | "autoAccept" | "fullAccess" =
    sessionRecord.permissionModeOverride ??
    preferences?.defaultPermissionMode ??
    "ask";

  return {
    selectedModelId: selectedModelId ?? mainModelSelection.id,
    modelId: mainModelSelection.id,
    agentOptions: {
      model: mainModelSelection,
      ...(subagentModelSelection
        ? { subagentModel: subagentModelSelection }
        : {}),
      customInstructions: assistantFileLinkPrompt,
      permissionMode,
    },
    autoCommitEnabled,
    autoCreatePrEnabled,
    startingBalanceCents,
    enforceCreditBlock: !isAdminUser,
  };
}

async function persistInputMessages(
  chatId: string,
  messages: WebAgentUIMessage[],
): Promise<void> {
  "use step";

  const latestMessage = messages[messages.length - 1];
  if (!latestMessage) {
    return;
  }

  await Promise.all([
    persistUserMessage(chatId, latestMessage),
    persistAssistantMessageWithToolResults(chatId, latestMessage),
  ]);
}

function buildStepTiming(
  stepNumber: number,
  startedAt: Date,
  finishedAt: Date,
  finishReason?: string,
  rawFinishReason?: string,
): WorkflowRunStepTiming {
  return {
    stepNumber,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    finishReason,
    rawFinishReason,
  };
}

function withModelMetadata(
  metadata: WebAgentMessageMetadata | undefined,
  selectedModelId: string,
  modelId: string,
): WebAgentMessageMetadata {
  return {
    ...metadata,
    selectedModelId,
    modelId,
  };
}

/**
 * Known upstream provider "we're out of capacity" messages that come back
 * as ordinary 200 response content instead of an HTTP error (e.g. a 429 or
 * 402). We saw this in production with DeepSeek-V4-Flash via the Opencode
 * Zen gateway: the provider's own monthly token allotment ran out and it
 * replied with a short Chinese string, which finished with the
 * non-standard `finishReason: "other"` yet otherwise looked like a normal
 * successful answer -- so it was rendered verbatim to the user as if it
 * were a real reply.
 *
 * This only rewrites what gets persisted/returned from this step; it does
 * not retroactively un-stream tokens that were already flushed live to the
 * client before the step finished (streaming is token-by-token, so we only
 * know the full text and finishReason after it's done). It does prevent
 * this message from ever being saved to chat history and re-rendered as a
 * real answer on reload, and flags the message so the frontend can show a
 * "try a different model" affordance instead.
 */
const PROVIDER_QUOTA_EXHAUSTED_PATTERNS = [
  /每月token额度已不足/, // DeepSeek-V4-Flash / Opencode Zen: "monthly token quota insufficient"
  /monthly (?:token )?(?:usage |quota )?limit (?:has been |is )?reached/i,
  /insufficient_quota/i,
  /you exceeded your current quota/i,
];

function detectProviderQuotaExhaustion(
  finishReason: string | undefined,
  responseText: string,
): boolean {
  if (finishReason !== "other") return false;
  const trimmed = responseText.trim();
  if (!trimmed) return false;
  return PROVIDER_QUOTA_EXHAUSTED_PATTERNS.some((pattern) =>
    pattern.test(trimmed),
  );
}

function extractPlainText(parts: WebAgentUIMessage["parts"]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("");
}

/**
 * Replace a quota-exhausted provider message's text parts with a clear,
 * user-facing explanation and mark it in metadata. Preserves every other
 * part (tool calls, step markers, etc.) untouched.
 */
function markProviderQuotaExhausted(
  message: WebAgentUIMessage,
  modelId: string,
): WebAgentUIMessage {
  const friendlyText = `The "${modelId}" model has hit its provider-side usage limit and can't respond right now. Please switch to a different model and try again.`;
  let replaced = false;
  const parts = message.parts.map((part) => {
    if (part.type === "text") {
      if (replaced) {
        return { ...part, text: "" };
      }
      replaced = true;
      return { ...part, text: friendlyText };
    }
    return part;
  });

  return {
    ...message,
    parts,
    metadata: {
      ...message.metadata,
      providerQuotaExhausted: true,
    },
  };
}

function getSetupErrorMessage(error: unknown, isRepeatFailure = false): string {
  if (error instanceof Error) {
    if (error.message.includes("Connect GitHub")) {
      return "Connect GitHub to access this repository, then try again.";
    }

    if (error.message === "Session is archived") {
      return "This session is archived. Unarchive it to continue.";
    }
  }

  // Anything else (gateway/provider failures, transport errors, unexpected
  // exceptions) goes through the same sanitizer used for in-stream errors
  // -- never surface the raw error text here either.
  return toFriendlyChatErrorText(error, isRepeatFailure);
}

/**
 * Checks whether this chat has recently failed with the same error
 * category before -- feeds isRepeatFailure into getSetupErrorMessage /
 * toFriendlyChatErrorText so a deterministic, repeating failure reads
 * differently to the user than a one-off transient blip. Never throws;
 * a lookup failure just means we fall back to the generic message.
 */
async function checkIsRepeatFailureStep(
  chatId: string,
  errorCategory: ChatErrorCategory,
  excludeRunId: string,
): Promise<boolean> {
  "use step";

  // Dynamic import (not a static top-of-file import) is required here:
  // countRecentFailuresWithCategory transitively touches the drizzle db
  // client ("postgres", a Node built-in) via lib/db/client.ts, and the
  // Workflow SDK's bundler pulls in a statically-imported function's
  // *entire* module graph into the restricted "use workflow" bundle even
  // from within this "use step" function -- same reasoning as
  // resolveChatModelRuntime/checkVercelConnectedStep/etc. above.
  const { countRecentFailuresWithCategory } =
    await import("@/lib/db/workflow-runs");

  try {
    const priorFailureCount = await countRecentFailuresWithCategory(
      chatId,
      errorCategory,
      excludeRunId,
    );
    return priorFailureCount > 0;
  } catch (lookupError) {
    console.error(
      "[workflow] Failed to check for repeat failure:",
      lookupError,
    );
    return false;
  }
}

function isStepTimingError(
  error: unknown,
): error is Error & { stepTiming: WorkflowRunStepTiming } {
  return (
    error instanceof Error &&
    "stepTiming" in error &&
    typeof error.stepTiming === "object" &&
    error.stepTiming !== null
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

function summarizeContentTypes(content: unknown): unknown {
  if (Array.isArray(content)) {
    return content.slice(0, 8).map((part) => {
      if (isObjectRecord(part) && typeof part.type === "string") {
        return part.type;
      }

      return typeof part;
    });
  }

  if (typeof content === "string") {
    return ["text"];
  }

  if (content === undefined) {
    return undefined;
  }

  return [typeof content];
}

function summarizeRequestTool(tool: unknown): unknown {
  if (!isObjectRecord(tool)) {
    return tool === undefined ? undefined : { type: typeof tool };
  }

  return compactRecord({
    type: typeof tool.type === "string" ? tool.type : undefined,
    name: typeof tool.name === "string" ? tool.name : undefined,
    strict: typeof tool.strict === "boolean" ? tool.strict : undefined,
  });
}

function summarizeRequestInputItem(item: unknown): unknown {
  if (!isObjectRecord(item)) {
    return { type: typeof item };
  }

  return compactRecord({
    type:
      typeof item.type === "string"
        ? item.type
        : typeof item.role === "string"
          ? "message"
          : undefined,
    role: typeof item.role === "string" ? item.role : undefined,
    contentTypes: summarizeContentTypes(item.content),
  });
}

function summarizeRequestBody(body: unknown): unknown {
  if (!isObjectRecord(body)) {
    return body === undefined ? undefined : { type: typeof body };
  }

  const input = Array.isArray(body.input) ? body.input : undefined;
  const tools = Array.isArray(body.tools) ? body.tools : undefined;

  return compactRecord({
    model: typeof body.model === "string" ? body.model : undefined,
    stream: typeof body.stream === "boolean" ? body.stream : undefined,
    store: typeof body.store === "boolean" ? body.store : undefined,
    previousResponseId:
      typeof body.previous_response_id === "string"
        ? body.previous_response_id
        : undefined,
    maxOutputTokens:
      typeof body.max_output_tokens === "number"
        ? body.max_output_tokens
        : undefined,
    maxCompletionTokens:
      typeof body.max_completion_tokens === "number"
        ? body.max_completion_tokens
        : undefined,
    temperature:
      typeof body.temperature === "number" ? body.temperature : undefined,
    topP: typeof body.top_p === "number" ? body.top_p : undefined,
    truncation:
      typeof body.truncation === "string" ? body.truncation : undefined,
    toolChoice: body.tool_choice,
    parallelToolCalls:
      typeof body.parallel_tool_calls === "boolean"
        ? body.parallel_tool_calls
        : undefined,
    reasoning: isObjectRecord(body.reasoning) ? body.reasoning : undefined,
    text: isObjectRecord(body.text) ? body.text : undefined,
    include: Array.isArray(body.include) ? body.include : undefined,
    inputCount: input?.length,
    inputSummary: input?.slice(0, 6).map(summarizeRequestInputItem),
    toolsCount: tools?.length,
    tools: tools?.slice(0, 6).map(summarizeRequestTool),
  });
}

function summarizeResponseOutputItem(item: unknown): unknown {
  if (!isObjectRecord(item)) {
    return { type: typeof item };
  }

  return compactRecord({
    type: typeof item.type === "string" ? item.type : undefined,
    status: typeof item.status === "string" ? item.status : undefined,
    role: typeof item.role === "string" ? item.role : undefined,
    id: typeof item.id === "string" ? item.id : undefined,
    contentTypes: summarizeContentTypes(item.content),
  });
}

function summarizeResponseBody(body: unknown): unknown {
  if (!isObjectRecord(body)) {
    return body === undefined ? undefined : { type: typeof body };
  }

  const output = Array.isArray(body.output) ? body.output : undefined;

  return compactRecord({
    id: typeof body.id === "string" ? body.id : undefined,
    status: typeof body.status === "string" ? body.status : undefined,
    incompleteDetails: isObjectRecord(body.incomplete_details)
      ? body.incomplete_details
      : undefined,
    error: body.error,
    outputCount: output?.length,
    outputSummary: output?.slice(0, 8).map(summarizeResponseOutputItem),
    usage: isObjectRecord(body.usage) ? body.usage : undefined,
    serviceTier:
      typeof body.service_tier === "string" ? body.service_tier : undefined,
  });
}

function stringifyDebugPayload(value: unknown): string {
  const seen = new WeakSet<object>();

  return (
    JSON.stringify(
      value,
      (_key, currentValue) => {
        if (typeof currentValue === "bigint") {
          return currentValue.toString();
        }

        if (typeof currentValue === "object" && currentValue !== null) {
          if (seen.has(currentValue)) {
            return "[Circular]";
          }

          seen.add(currentValue);
        }

        return currentValue;
      },
      2,
    ) ?? "undefined"
  );
}

function buildGitHubCommitUrl(
  repoOwner: string,
  repoName: string,
  commitSha: string,
): string {
  return `https://github.com/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/commit/${encodeURIComponent(commitSha)}`;
}

function buildCommitData(
  result: Awaited<ReturnType<typeof runAutoCommitStep>>,
  repoOwner: string,
  repoName: string,
): WebAgentCommitData {
  if (result.error) {
    return {
      status: "error",
      committed: result.committed,
      pushed: result.pushed,
      commitMessage: result.commitMessage,
      commitSha: result.commitSha,
      url:
        result.pushed && result.commitSha
          ? buildGitHubCommitUrl(repoOwner, repoName, result.commitSha)
          : undefined,
      error: result.error,
    };
  }

  if (result.committed) {
    return {
      status: "success",
      committed: result.committed,
      pushed: result.pushed,
      commitMessage: result.commitMessage,
      commitSha: result.commitSha,
      url:
        result.pushed && result.commitSha
          ? buildGitHubCommitUrl(repoOwner, repoName, result.commitSha)
          : undefined,
    };
  }

  return {
    status: "skipped",
    committed: false,
    pushed: false,
  };
}

function buildPrData(
  result: Awaited<ReturnType<typeof runAutoCreatePrStep>>,
): WebAgentPrData {
  if (result.error) {
    return {
      status: "error",
      created: result.created,
      syncedExisting: result.syncedExisting,
      prNumber: result.prNumber,
      url: result.prUrl,
      error: result.error,
    };
  }

  if (result.skipped) {
    return {
      status: "skipped",
      created: result.created,
      syncedExisting: result.syncedExisting,
      prNumber: result.prNumber,
      url: result.prUrl,
      skipReason: result.skipReason,
    };
  }

  return {
    status: "success",
    created: result.created,
    syncedExisting: result.syncedExisting,
    prNumber: result.prNumber,
    url: result.prUrl,
  };
}

function upsertAssistantDataPart(
  message: WebAgentUIMessage,
  part: WebAgentCommitDataPart | WebAgentPrDataPart,
): WebAgentUIMessage {
  const nextParts = [...message.parts];
  const existingIndex = nextParts.findIndex(
    (messagePart) =>
      messagePart.type === part.type && messagePart.id === part.id,
  );

  if (existingIndex >= 0) {
    nextParts[existingIndex] = part;
  } else {
    nextParts.push(part);
  }

  return {
    ...message,
    parts: nextParts,
  };
}

async function sendDataPart(
  writable: Writable,
  part: WebAgentCommitDataPart | WebAgentPrDataPart,
) {
  "use step";
  const writer = writable.getWriter();
  try {
    await writer.write(part);
  } finally {
    writer.releaseLock();
  }
}

/**
 * Runs the actual GitHub commit/push work for the agent's
 * `github_commit_and_push` tool as a step, NOT inline in the workflow
 * function. `performAutoCommit` (and everything it touches -- the
 * sandbox client, git helpers, the GitHub App/Octokit client) pulls in
 * Node.js built-ins (`path`, and `nanoid` transitively) that the
 * Workflow SDK's bundler refuses to include in the restricted
 * "use workflow" environment, even behind a dynamic `import()`. Steps
 * run in a normal Node.js function environment with no such
 * restriction, so this needs to be its own step, called from the
 * workflow's `github.commitAndPush` closure below rather than inlined
 * there. Takes/returns only plain, serializable data (sandbox *state*,
 * not the connected client) since step boundaries are checkpointed.
 */
async function performAgentCommitAndPush(params: {
  sandboxState: OpenAgentCallOptions["sandbox"]["state"];
  userId: string;
  sessionId: string;
  sessionTitle: string;
  repoOwner: string;
  repoName: string;
  commitMessage?: string;
}): Promise<{
  committed: boolean;
  pushed: boolean;
  commitSha?: string;
  commitUrl?: string;
  error?: string;
}> {
  "use step";

  const { connectSandbox } = await import("@open-agents/sandbox");
  const { performAutoCommit } = await import("@/lib/chat/auto-commit-direct");

  const sandbox = await connectSandbox(params.sandboxState);
  const result = await performAutoCommit({
    sandbox,
    userId: params.userId,
    sessionId: params.sessionId,
    sessionTitle: params.sessionTitle,
    repoOwner: params.repoOwner,
    repoName: params.repoName,
    ...(params.commitMessage ? { commitMessage: params.commitMessage } : {}),
  });
  return {
    committed: result.committed,
    pushed: result.pushed,
    commitSha: result.commitSha,
    commitUrl: result.commitUrl,
    error: result.error,
  };
}

/**
 * Cheap Vercel-account-linked check for the agent's `vercel_cli` tool,
 * run as its own step -- same reasoning as performAgentCommitAndPush
 * above: hasVercelAccountLinked's module touches the drizzle db client
 * ("postgres") and, transitively via lib/auth/config, "nanoid", both
 * Node built-ins the Workflow SDK's bundler refuses to include in the
 * restricted "use workflow" environment even behind a dynamic import()
 * -- the target function itself has to carry the "use step" directive
 * for the bundler to extract it instead of inlining it. Kept separate
 * from performAgentVercelCli (which needs the *real* token, refreshed
 * via next/headers -- request-scoped, so only meaningful right before
 * actually running a CLI command) since this only needs a cheap
 * existence check to decide whether to surface the tool at all.
 */
/**
 * Fetches the live model/pricing catalog for the per-turn cost pill, as
 * its own step -- same reasoning as checkVercelConnectedStep just below:
 * lib/models-with-context.ts's fetchAvailableLanguageModels() filters
 * out disabled models via lib/model-availability.ts's admin kill-switch
 * check, which now touches the drizzle db client ("postgres", a Node
 * built-in) through lib/db/model-overrides.ts. That's a Node module the
 * Workflow SDK's bundler refuses to include in the restricted
 * "use workflow" environment when reached via a static top-of-file
 * import -- even though the actual live-pricing HTTP call itself
 * (fetchGatewayModels, via the workflow-safe hoisted `fetch`) is fine on
 * its own. Loaded via dynamic import() inside this "use step" function
 * instead, same fix as every other DB/Node-module touchpoint in this
 * file.
 */
async function fetchModelCostCatalogStep(): Promise<AvailableModel[]> {
  "use step";

  const { fetchAvailableLanguageModels } =
    await import("@/lib/models-with-context");
  return fetchAvailableLanguageModels();
}

async function checkVercelConnectedStep(userId: string): Promise<boolean> {
  "use step";

  const { hasVercelAccountLinked } = await import("@/lib/vercel/token");
  return hasVercelAccountLinked(userId);
}

/**
 * Runs one generic GitHub REST API call for the agent's `github_cli`
 * tool's 'api' action, as a step -- same reasoning as
 * performAgentCommitAndPush: the Octokit client pulls in Node built-ins
 * the Workflow SDK's restricted "use workflow" bundler won't include, so
 * this has to be its own step. Deliberately generic (method + path +
 * params, not a fixed set of endpoints) so the agent can do essentially
 * anything the GitHub API supports -- list/create/update/close/merge
 * PRs and issues, comments, reviews, labels, branches, releases -- not
 * just whatever handful of actions we thought to hardcode.
 */
async function performAgentGithubApiRequest(params: {
  userId: string;
  repoOwner: string;
  repoName: string;
  method: string;
  path: string;
  params?: Record<string, unknown>;
}): Promise<GithubApiResult> {
  "use step";

  const { getUserOctokit } = await import("@/lib/github/client");

  const octokit = await getUserOctokit(params.userId);
  if (!octokit) {
    return {
      success: false,
      error: "No GitHub token available for this repository.",
    };
  }

  const rawPath = params.path.trim();
  const fullPath = rawPath.startsWith("/")
    ? rawPath
    : `/repos/${params.repoOwner}/${params.repoName}/${rawPath.replace(/^\/+/, "")}`;

  try {
    const response = await octokit.request(
      `${params.method} ${fullPath}`,
      params.params ?? {},
    );
    return { success: true, status: response.status, data: response.data };
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? (error as { status?: number }).status
        : undefined;
    return {
      success: false,
      status,
      error:
        error instanceof Error ? error.message : "GitHub API request failed",
    };
  }
}

function shellEscapeForVercelEnv(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

// Deliberately not the real token -- just enough for the Vercel CLI's own
// local "am I logged in" check to pass so it doesn't drop into an
// interactive browser-login flow instead of running the command. The
// actual Authorization header sent to api.vercel.com is overwritten with
// the real token by the sandbox's network-egress credential broker (see
// setVercelAuthToken), so this placeholder value is never actually
// presented to Vercel and is harmless even if it leaked.
const VERCEL_CLI_PLACEHOLDER_TOKEN = "sandboxed-cli-do-not-use";

/**
 * Runs an arbitrary Vercel CLI command for the agent's `vercel_cli` tool
 * as a step, same reasoning as the two steps above. Fetches a fresh
 * per-user Vercel OAuth token (better-auth auto-refreshes it) plus the
 * Vercel project already linked to this repo, then brokers the real
 * token at the sandbox's network-egress layer for api.vercel.com only
 * (see setVercelAuthToken / buildCredentialBrokeringPolicy in
 * packages/sandbox/vercel/sandbox.ts -- the same zero-exposure mechanism
 * already used for GitHub) instead of setting it as an env var on the
 * exec'd process. The sandbox -- where the agent's own bash tool has
 * full shell access -- never has the real token in its process
 * environment, filesystem, or command history; only a harmless
 * placeholder value is ever visible there. The network policy is always
 * cleared in a `finally` immediately after the command completes, even
 * on error/timeout.
 */
async function performAgentVercelCli(params: {
  userId: string;
  sandboxState: OpenAgentCallOptions["sandbox"]["state"];
  workingDirectory: string;
  repoOwner?: string;
  repoName?: string;
  args: string;
}): Promise<VercelCliToolResult> {
  "use step";

  const { connectSandbox } = await import("@open-agents/sandbox");
  const { getUserVercelToken } = await import("@/lib/vercel/token");
  const { getVercelProjectLinkByRepo } =
    await import("@/lib/db/vercel-project-links");

  let token: string | null;
  try {
    token = await getUserVercelToken(params.userId);
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? `Failed to read Vercel credentials: ${error.message}`
          : "Failed to read Vercel credentials.",
    };
  }

  if (!token) {
    return {
      success: false,
      error: "No Vercel account is connected for this user.",
    };
  }

  const projectLink =
    params.repoOwner && params.repoName
      ? await getVercelProjectLinkByRepo(
          params.userId,
          params.repoOwner,
          params.repoName,
        )
      : null;

  const sandbox = await connectSandbox(params.sandboxState);

  if (!sandbox.setVercelAuthToken) {
    return {
      success: false,
      error:
        "This sandbox doesn't support secure Vercel CLI credential brokering.",
    };
  }

  const scopeFlag = projectLink?.teamSlug
    ? ` --scope=${shellEscapeForVercelEnv(projectLink.teamSlug)}`
    : "";
  const command = `VERCEL_TOKEN=${shellEscapeForVercelEnv(VERCEL_CLI_PLACEHOLDER_TOKEN)} vercel ${params.args}${scopeFlag}`;

  await sandbox.setVercelAuthToken(token);
  try {
    const result = await sandbox.exec(command, params.workingDirectory, 120000);

    // Defense in depth only -- the real token should never reach the
    // sandbox process or its output at all (see comment above), but this
    // still guards against it accidentally echoing the placeholder or
    // any stray env dump.
    const redact = (text: string) =>
      text
        ? text
            .split(token)
            .join("[REDACTED]")
            .split(VERCEL_CLI_PLACEHOLDER_TOKEN)
            .join("[REDACTED]")
        : text;

    return {
      success: result.success,
      exitCode: result.exitCode,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr),
    };
  } finally {
    await sandbox
      .setVercelAuthToken(undefined)
      .catch((error) =>
        console.warn(
          "[performAgentVercelCli] failed to clear Vercel CLI credential broker:",
          error,
        ),
      );
  }
}

// Deliberately not the real token -- same reasoning as
// VERCEL_CLI_PLACEHOLDER_TOKEN above, just for `gh`'s own local
// "am I logged in" check. The real Authorization header sent to
// api.github.com/github.com/uploads.github.com/codeload.github.com is
// overwritten with the real scoped installation token by the sandbox's
// existing GitHub credential broker (withTemporaryGitHubAuth /
// setGitHubAuthToken -- the same mechanism auto-commit-direct.ts already
// uses for git push), so this placeholder is never actually presented to
// GitHub and is harmless even if it leaked.
const GITHUB_CLI_PLACEHOLDER_TOKEN = "sandboxed-cli-do-not-use";

// One-time-per-command install guard for `gh` -- the sandbox base image
// isn't guaranteed to ship the GitHub CLI (unlike `vercel`, which the
// base image already includes), so this downloads the static release
// binary straight from GitHub's own release assets (no apt/sudo
// dependency, works regardless of the base image's package manager) the
// first time it's missing, then reuses it for the rest of the session.
const ENSURE_GH_CLI_INSTALLED = [
  "command -v gh >/dev/null 2>&1 || {",
  "  GH_VER=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest",
  '    | grep -m1 tag_name | grep -oE "[0-9]+\\.[0-9]+\\.[0-9]+");',
  '  mkdir -p "$HOME/.local/bin";',
  // literal bash syntax for the shell to expand ($GH_VER), not JS
  // oxlint-disable-next-line no-template-curly-in-string
  '  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VER}/gh_${GH_VER}_linux_amd64.tar.gz" -o /tmp/gh-cli.tar.gz &&',
  "    tar -xzf /tmp/gh-cli.tar.gz -C /tmp &&",
  // literal bash syntax for the shell to expand ($GH_VER), not JS
  // oxlint-disable-next-line no-template-curly-in-string
  '    cp "/tmp/gh_${GH_VER}_linux_amd64/bin/gh" "$HOME/.local/bin/gh" &&',
  '    chmod +x "$HOME/.local/bin/gh";',
  "}",
].join(" ");

/**
 * Runs an arbitrary `gh <args>` command for the agent's `github_cli`
 * tool's 'cli' action, as a step -- same zero-token-exposure reasoning
 * as performAgentVercelCli below, reusing the exact broker mechanism
 * auto-commit-direct.ts already relies on for git push
 * (withTemporaryGitHubAuth / setGitHubAuthToken): a short-lived GitHub
 * App installation token, scoped to exactly this one repo, is injected
 * as an Authorization header at the sandbox's network-egress layer for
 * api.github.com/github.com/uploads.github.com/codeload.github.com
 * only -- the sandbox process (where the agent's own bash tool has full
 * shell access) never sees the real token, only the harmless
 * GITHUB_CLI_PLACEHOLDER_TOKEN needed for `gh`'s own local login check.
 * Minted with write access across the common gh-cli surface (contents,
 * issues, pull_requests, actions, checks, statuses, workflows) but
 * deliberately NOT 'administration' -- repo settings/deletion/transfer
 * stay out of scope for an agent-initiated CLI call. Always revoked in
 * a `finally`, even on error/timeout, same as auto-commit-direct.ts.
 */
async function performAgentGithubCli(params: {
  userId: string;
  sandboxState: OpenAgentCallOptions["sandbox"]["state"];
  workingDirectory: string;
  repoOwner: string;
  repoName: string;
  args: string;
}): Promise<GithubRawCliResult> {
  "use step";

  const { connectSandbox, withTemporaryGitHubAuth } =
    await import("@open-agents/sandbox");
  const { verifyRepoAccess } = await import("@/lib/github/access");
  const { mintInstallationToken, revokeInstallationToken } =
    await import("@/lib/github/app");

  const access = await verifyRepoAccess({
    userId: params.userId,
    owner: params.repoOwner,
    repo: params.repoName,
  });
  if (!access.ok) {
    return {
      success: false,
      error: "No GitHub access to this repository for this user.",
    };
  }

  const sandbox = await connectSandbox(params.sandboxState);
  if (!sandbox.setGitHubAuthToken) {
    return {
      success: false,
      error:
        "This sandbox doesn't support secure GitHub CLI credential brokering.",
    };
  }

  const scoped = await mintInstallationToken({
    installationId: access.installationId,
    repositoryIds: [access.repositoryId],
    permissions: {
      contents: "write",
      issues: "write",
      pull_requests: "write",
      actions: "write",
      checks: "write",
      statuses: "write",
      workflows: "write",
    },
  });

  const command = `${ENSURE_GH_CLI_INSTALLED}; export PATH="$HOME/.local/bin:$PATH"; GH_TOKEN=${GITHUB_CLI_PLACEHOLDER_TOKEN} GH_REPO=${params.repoOwner}/${params.repoName} gh ${params.args}`;

  try {
    const result = await withTemporaryGitHubAuth(sandbox, scoped.token, () =>
      sandbox.exec(command, params.workingDirectory, 120000),
    );

    // Defense in depth only -- see redact() in performAgentVercelCli.
    const redact = (text: string) =>
      text
        ? text
            .split(scoped.token)
            .join("[REDACTED]")
            .split(GITHUB_CLI_PLACEHOLDER_TOKEN)
            .join("[REDACTED]")
        : text;

    return {
      success: result.success,
      exitCode: result.exitCode,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr),
    };
  } finally {
    await revokeInstallationToken(scoped.token).catch((error) =>
      console.warn(
        "[performAgentGithubCli] failed to revoke installation token:",
        error,
      ),
    );
  }
}

/**
 * Generic Vercel REST API passthrough for the agent's `vercel_api`
 * tool, as its own step -- same reasoning as
 * performAgentGithubApiRequest above, mirrored for Vercel. Unlike
 * performAgentVercelCli, this never touches the sandbox at all: it's a
 * plain authenticated fetch to api.vercel.com from inside the step,
 * using the same per-user OAuth token (auto-refreshed by better-auth)
 * as the CLI tool. Useful for structured JSON reads/writes the CLI
 * doesn't expose cleanly -- full deployment/build metadata, edge
 * config, webhooks, some project settings.
 */
async function performAgentVercelApiRequest(params: {
  userId: string;
  method: string;
  path: string;
  params?: Record<string, unknown>;
}): Promise<VercelApiResult> {
  "use step";

  const { getUserVercelToken } = await import("@/lib/vercel/token");

  const token = await getUserVercelToken(params.userId);
  if (!token) {
    return {
      success: false,
      error: "No Vercel account is connected for this user.",
    };
  }

  const rawPath = params.path.trim().replace(/^\/+/, "");
  const url = new URL(`https://api.vercel.com/${rawPath}`);

  const method = params.method.toUpperCase();
  const bodyMethods = new Set(["POST", "PATCH", "PUT"]);
  let body: string | undefined;

  if (params.params) {
    if (bodyMethods.has(method)) {
      body = JSON.stringify(params.params);
    } else {
      for (const [key, value] of Object.entries(params.params)) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
    });

    const text = await response.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON response -- keep the raw text.
    }

    return { success: response.ok, status: response.status, data };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Vercel API request failed",
    };
  }
}

export async function runAgentWorkflow(options: Options) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const writable = getWritable<UIMessageChunk>();

  const latestMessage = options.messages.at(-1);

  if (latestMessage == null) {
    throw new Error("runAgentWorkflow requires at least one message");
  }

  const assistantId =
    latestMessage.role === "assistant"
      ? latestMessage.id
      : (options.assistantId ?? generateIdAi());

  const inputMessagesPersistPromise = options.inputMessagesPersisted
    ? Promise.resolve()
    : persistInputMessages(options.chatId, options.messages);
  const modelRuntimePromise = resolveChatModelRuntime({
    userId: options.userId,
    sessionId: options.sessionId,
    chatId: options.chatId,
    requestUrl: options.requestUrl,
    authSession: options.authSession,
    workflowRunId,
  });
  const runtimePromise = resolveChatSandboxRuntime({
    userId: options.userId,
    sessionId: options.sessionId,
  });
  // Cheap existence check only (no live token refresh -- see
  // hasVercelAccountLinked's own comment on why) so the workflow can
  // decide whether to surface the vercel_cli tool at all, mirroring how
  // `hasRepo` below is derived from plain columns rather than a live
  // GitHub API call. Best-effort: if this fails, just hide the tool
  // rather than failing the whole turn.
  //
  // Routed through its own tiny step (checkVercelConnectedStep, defined
  // below) rather than calling hasVercelAccountLinked directly from this
  // "use workflow" function: that module's static imports (drizzle db
  // client -> "postgres", better-auth config -> "nanoid") are Node-only
  // and the workflow bundler pulls in a statically-imported function's
  // *entire* module graph even when unused by that one function, which
  // fails the build. Every other DB/Node-module touchpoint in this file
  // (performAgentCommitAndPush, performAgentGithubApiRequest,
  // performAgentVercelCli) already avoids this via dynamic import()
  // inside a "use step" function -- same fix here.
  const vercelConnectedPromise = checkVercelConnectedStep(options.userId).catch(
    () => false,
  );

  // Fast path (the common case, no attachments): convert messages straight
  // away, fully in parallel with sandbox resolution below. Only when there
  // are image attachments do we need to wait on the sandbox first, since
  // they get written into it before conversion (see
  // extractPendingImageAttachments above).
  const pendingImageAttachments = extractPendingImageAttachments(
    options.messages,
  );
  const modelMessagesPromise: Promise<ModelMessage[]> =
    pendingImageAttachments.length === 0
      ? convertMessages(options.messages)
      : runtimePromise.then(async (runtime) => {
          const paths = await persistImageAttachmentsToSandbox({
            sandboxState: runtime.sandboxState,
            images: pendingImageAttachments,
          });
          const messagesWithPaths = replaceImageAttachmentsWithPaths(
            options.messages,
            paths,
          );
          return convertMessages(messagesWithPaths);
        });

  // Self-register this workflow's runId onto the chat as the very first step.
  // The HTTP POST handler also writes this (via compareAndSetChatActiveStreamId
  // after `start()` returns), but that write is best-effort and can be lost
  // when the client disconnects early and the function is torn down before
  // it runs. Persisting from inside the workflow guarantees that as long as
  // the workflow is running, the chat row points at it and the client can
  // resume on refresh.
  const activeStreamClaimPromise = claimActiveStream(
    options.chatId,
    workflowRunId,
    writable,
    assistantId,
  );
  const activeStreamClaim = await activeStreamClaimPromise;
  if (activeStreamClaim === "conflict") {
    // Another workflow claimed the slot while this run was queued or starting.
    // Exit before emitting chunks or persisting messages so only the owning
    // workflow can mutate this chat.
    await Promise.allSettled([
      runtimePromise,
      modelMessagesPromise,
      inputMessagesPersistPromise,
      modelRuntimePromise,
    ]);
    await closeStream(writable);
    return;
  }

  let selectedModelId = APP_DEFAULT_MODEL_ID;
  let modelId = APP_DEFAULT_MODEL_ID;

  // Live pricing catalog from entry-gateway (see gateway-metadata.ts) --
  // used to price every step below since our shared provider doesn't emit
  // Vercel-Gateway-shaped cost metadata. Best-effort: if the gateway is
  // briefly unreachable, cost tracking degrades to undefined for this
  // turn rather than failing the whole chat request.
  const modelCostCatalog = await fetchModelCostCatalogStep().catch((error) => {
    console.error(
      "Failed to fetch entry-gateway model/pricing catalog for cost tracking:",
      error,
    );
    return [];
  });

  let pendingAssistantResponse: WebAgentUIMessage =
    latestMessage.role === "assistant"
      ? {
          ...latestMessage,
          metadata: withModelMetadata(
            latestMessage.metadata,
            selectedModelId,
            modelId,
          ),
          parts: [...latestMessage.parts],
        }
      : {
          role: "assistant",
          id: assistantId,
          parts: [],
          metadata: withModelMetadata(undefined, selectedModelId, modelId),
        };

  let originalMessagesForStep: WebAgentUIMessage[] = [latestMessage];

  const runStartedAt = new Date();
  const previousResponseMessage =
    latestMessage.role === "assistant" ? latestMessage : undefined;
  const stepTimings: WorkflowRunStepTiming[] = [];
  let wasAborted = false;
  let exhaustedMaxSteps = false;
  let totalUsage: LanguageModelUsage | undefined;
  let finalFinishReason: FinishReason | undefined;
  let streamClosed = false;
  let workflowStatus: WorkflowRunStatus = "completed";
  let caughtError: unknown;
  let isRepeatFailure = false;
  let sandboxState: OpenAgentCallOptions["sandbox"]["state"] | undefined;
  let shouldRefreshCachedDiff = false;

  try {
    const [, runtime, modelRuntime, modelMessages, , vercelConnected] =
      await Promise.all([
        activeStreamClaimPromise,
        runtimePromise,
        modelRuntimePromise,
        modelMessagesPromise,
        inputMessagesPersistPromise,
        vercelConnectedPromise,
      ]);
    selectedModelId = options.selectedModelId ?? modelRuntime.selectedModelId;
    modelId = options.modelId ?? modelRuntime.modelId;
    let remainingBalanceCents = modelRuntime.startingBalanceCents;
    let creditExhausted = false;
    let turnSpendCapped = false;
    pendingAssistantResponse = {
      ...pendingAssistantResponse,
      metadata: withModelMetadata(
        pendingAssistantResponse.metadata,
        selectedModelId,
        modelId,
      ),
    };

    const hasRepo = Boolean(runtime.repoOwner && runtime.repoName);
    // NOTE: `github` here is intentionally the serializable-only shape
    // (no `commitAndPush` closure) -- see WorkflowAgentOptions above.
    // The real closure is rebuilt inside runAgentStep, right before it's
    // needed, so it never has to cross a workflow-step serialization
    // boundary.
    const agentOptions: WorkflowAgentOptions = {
      ...modelRuntime.agentOptions,
      ...options.agentOptions,
      sandbox: {
        state: runtime.sandboxState,
        workingDirectory: runtime.workingDirectory,
        currentBranch: runtime.currentBranch,
        environmentDetails: runtime.environmentDetails,
      },
      ...(runtime.skills.length > 0 ? { skills: runtime.skills } : {}),
      github: {
        hasRepo,
        repoOwner: runtime.repoOwner,
        repoName: runtime.repoName,
      },
      vercel: {
        connected: vercelConnected,
      },
    };
    sandboxState = runtime.sandboxState;

    for (
      let step = 0;
      options.maxSteps === undefined || step < options.maxSteps;
      step++
    ) {
      let result: Awaited<ReturnType<typeof runAgentStep>>;

      // Refresh permission mode fresh for this specific step -- see
      // resolveCurrentPermissionMode above. Everything else about
      // agentOptions (sandbox, model, skills) stays fixed for the turn;
      // only the approval-gating mode is allowed to change mid-flight.
      // An explicit caller-supplied override (options.agentOptions,
      // rarely used) still wins, matching the precedence `agentOptions`
      // was built with above.
      const livePermissionMode = options.agentOptions?.permissionMode
        ? agentOptions.permissionMode
        : await resolveCurrentPermissionMode({
            userId: options.userId,
            sessionId: options.sessionId,
          });
      const stepAgentOptions: WorkflowAgentOptions = {
        ...agentOptions,
        permissionMode: livePermissionMode,
      };

      try {
        result = await runAgentStep(
          modelMessages,
          originalMessagesForStep,
          assistantId,
          writable,
          workflowRunId,
          options.chatId,
          options.sessionId,
          options.userId,
          runtime.sessionTitle,
          selectedModelId,
          modelId,
          stepAgentOptions,
          step + 1,
          modelCostCatalog,
          remainingBalanceCents,
          modelRuntime.enforceCreditBlock,
        );
      } catch (error) {
        if (isStepTimingError(error)) {
          stepTimings.push(error.stepTiming);
        }
        throw error;
      }

      stepTimings.push(result.stepTiming);
      pendingAssistantResponse =
        result.responseMessage ?? pendingAssistantResponse;
      shouldRefreshCachedDiff =
        shouldRefreshCachedDiff ||
        shouldRefreshDiffCacheForParts(pendingAssistantResponse.parts);
      originalMessagesForStep = [pendingAssistantResponse];
      modelMessages.push(...result.responseMessages);
      // See stripDanglingToolCalls's own comment above -- guards against
      // AI_MissingToolResultsError poisoning every subsequent step of
      // this same turn.
      stripDanglingToolCalls(modelMessages);
      wasAborted = wasAborted || result.stepWasAborted;
      finalFinishReason = result.finishReason;
      remainingBalanceCents = result.remainingBalanceCents;
      creditExhausted = creditExhausted || result.creditExhausted;
      turnSpendCapped = turnSpendCapped || result.turnSpendCapped;

      if (result.stepUsage) {
        totalUsage = totalUsage
          ? addLanguageModelUsage(totalUsage, result.stepUsage)
          : result.stepUsage;
      }

      if (creditExhausted || turnSpendCapped) {
        // Real-time billing (see runAgentStep) already aborted the
        // in-flight model call -- either the running balance hit zero,
        // or this turn alone crossed MAX_TURN_SPEND_CENTS. Either way,
        // stop the outer step loop too instead of starting another
        // step.
        break;
      }

      const shouldContinue =
        result.finishReason === "tool-calls" &&
        !shouldPauseForToolInteraction(
          result.responseMessage?.parts ?? pendingAssistantResponse.parts,
        );

      if (!shouldContinue) {
        break;
      }

      if (options.maxSteps !== undefined && step + 1 >= options.maxSteps) {
        exhaustedMaxSteps = true;
        break;
      }
    }

    if (sandboxState) {
      await refreshLifecycleActivity(options.sessionId);
    }

    if (totalUsage) {
      pendingAssistantResponse = {
        ...pendingAssistantResponse,
        metadata: {
          ...pendingAssistantResponse.metadata,
          totalMessageUsage: totalUsage,
        },
      };
    }

    if (creditExhausted) {
      // Surfaced so the client can render a dedicated "you're out of
      // credit" notice (see session-chat-content.tsx) distinct from the
      // generic "The request was stopped." abort text -- real-time
      // billing in runAgentStep already stopped generation the instant
      // the balance hit zero.
      pendingAssistantResponse = {
        ...pendingAssistantResponse,
        metadata: {
          ...pendingAssistantResponse.metadata,
          creditExhausted: true,
        },
      };
    }

    if (turnSpendCapped) {
      // Distinct from creditExhausted: the account still has balance,
      // but this one turn alone crossed MAX_TURN_SPEND_CENTS (runaway
      // multi-tool-call loop protection). Surfaced so the client can
      // tell the user why generation stopped instead of just going
      // silent mid-answer.
      pendingAssistantResponse = {
        ...pendingAssistantResponse,
        metadata: {
          ...pendingAssistantResponse.metadata,
          turnSpendCapped: true,
        },
      };
    }

    // Persist completed model output before post-finish work so it is not lost
    // if later automation fails. Sandbox state can persist in parallel.
    await Promise.all([
      persistAssistantMessage(options.chatId, pendingAssistantResponse),
      ...(sandboxState
        ? [persistSandboxState(options.sessionId, sandboxState)]
        : []),
    ]);

    const finishedNaturally =
      !wasAborted &&
      finalFinishReason !== undefined &&
      finalFinishReason !== "tool-calls";
    const commitPartId = `${assistantId}:commit`;
    const prPartId = `${assistantId}:pr`;
    const repoOwner = runtime.repoOwner;
    const repoName = runtime.repoName;
    let didUpdateGitData = false;

    let autoCommitResult: Awaited<ReturnType<typeof runAutoCommitStep>> | null =
      null;

    const canAutoCommit =
      finishedNaturally &&
      (options.autoCommitEnabled ?? modelRuntime.autoCommitEnabled) &&
      sandboxState != null &&
      repoOwner != null &&
      repoName != null;

    if (canAutoCommit) {
      const hasAutoCommitChanges = await hasAutoCommitChangesStep({
        sandboxState,
      });

      if (hasAutoCommitChanges) {
        const pendingCommitPart: WebAgentCommitDataPart = {
          type: "data-commit",
          id: commitPartId,
          data: { status: "pending" },
        };
        pendingAssistantResponse = upsertAssistantDataPart(
          pendingAssistantResponse,
          pendingCommitPart,
        );
        await sendDataPart(writable, pendingCommitPart);
        autoCommitResult = await runAutoCommitStep({
          userId: options.userId,
          sessionId: options.sessionId,
          sessionTitle: runtime.sessionTitle,
          repoOwner,
          repoName,
          sandboxState,
        });

        const resolvedCommitPart: WebAgentCommitDataPart = {
          type: "data-commit",
          id: commitPartId,
          data: buildCommitData(autoCommitResult, repoOwner, repoName),
        };
        pendingAssistantResponse = upsertAssistantDataPart(
          pendingAssistantResponse,
          resolvedCommitPart,
        );
        await sendDataPart(writable, resolvedCommitPart);
        didUpdateGitData = true;
        shouldRefreshCachedDiff = true;
      } else {
        autoCommitResult = {
          committed: false,
          pushed: false,
        };
      }
    }

    const canAutoCreatePr =
      autoCommitResult != null &&
      !autoCommitResult.error &&
      (autoCommitResult.pushed || !autoCommitResult.committed);

    if (
      canAutoCommit &&
      (options.autoCreatePrEnabled ?? modelRuntime.autoCreatePrEnabled)
    ) {
      if (canAutoCreatePr) {
        const pendingPrPart: WebAgentPrDataPart = {
          type: "data-pr",
          id: prPartId,
          data: { status: "pending" },
        };
        pendingAssistantResponse = upsertAssistantDataPart(
          pendingAssistantResponse,
          pendingPrPart,
        );
        await sendDataPart(writable, pendingPrPart);
        const autoPrResult = await runAutoCreatePrStep({
          userId: options.userId,
          sessionId: options.sessionId,
          sessionTitle: runtime.sessionTitle,
          repoOwner,
          repoName,
          sandboxState,
        });

        const resolvedPrPart: WebAgentPrDataPart = {
          type: "data-pr",
          id: prPartId,
          data: buildPrData(autoPrResult),
        };
        pendingAssistantResponse = upsertAssistantDataPart(
          pendingAssistantResponse,
          resolvedPrPart,
        );
        await sendDataPart(writable, resolvedPrPart);
        didUpdateGitData = true;
        shouldRefreshCachedDiff = true;
      } else {
        const skippedPrPart: WebAgentPrDataPart = {
          type: "data-pr",
          id: prPartId,
          data: {
            status: "skipped",
            skipReason:
              autoCommitResult?.error ??
              "Auto-commit did not leave origin in sync with HEAD",
          },
        };
        pendingAssistantResponse = upsertAssistantDataPart(
          pendingAssistantResponse,
          skippedPrPart,
        );
        await sendDataPart(writable, skippedPrPart);
        didUpdateGitData = true;
      }
    }

    if (didUpdateGitData) {
      await persistAssistantMessage(options.chatId, pendingAssistantResponse);
    }

    await Promise.all([
      clearActiveStream(options.chatId, workflowRunId),
      releaseUserBillingTurnStep(options.userId, workflowRunId),
      sendFinish(writable).then(() => closeStream(writable)),
      ...(sandboxState && shouldRefreshCachedDiff
        ? [refreshDiffCache(options.sessionId, sandboxState)]
        : []),
    ]);
    streamClosed = true;

    workflowStatus = wasAborted
      ? "aborted"
      : exhaustedMaxSteps
        ? "failed"
        : "completed";
  } catch (error) {
    workflowStatus = wasAborted ? "aborted" : "failed";
    caughtError = error;

    // Aborts are user-initiated, never a "repeating issue." For anything
    // else, check whether this chat has already failed with the same
    // error category recently -- lets both the setup-error text below
    // and the final thrown error (see the `if (caughtError)` block after
    // the try/finally) tell the user this looks deterministic rather
    // than a one-off, instead of the generic "please try again."
    const errorCategory = classifyChatError(error);
    if (errorCategory !== "aborted") {
      isRepeatFailure = await checkIsRepeatFailureStep(
        options.chatId,
        errorCategory,
        workflowRunId,
      );
    }

    if (pendingAssistantResponse.parts.length === 0 && !streamClosed) {
      const errorText = getSetupErrorMessage(error, isRepeatFailure);
      pendingAssistantResponse = {
        ...pendingAssistantResponse,
        parts: [{ type: "text", text: errorText }],
      };
      await sendTextMessage(writable, "setup-error", errorText);
      await persistAssistantMessage(options.chatId, pendingAssistantResponse);
    }
  } finally {
    try {
      // On unexpected errors, still clear the active stream and close
      // so the chat is never permanently marked as streaming.
      if (!streamClosed) {
        await Promise.all([
          clearActiveStream(options.chatId, workflowRunId),
          releaseUserBillingTurnStep(options.userId, workflowRunId),
          sendFinish(writable).then(() => closeStream(writable)),
        ]);
      }
    } finally {
      const runFinishedAt = new Date();
      await recordWorkflowUsage(
        options.userId,
        modelId,
        totalUsage,
        pendingAssistantResponse,
        previousResponseMessage,
        {
          workflowRunId,
          chatId: options.chatId,
          sessionId: options.sessionId,
          status: workflowStatus,
          startedAt: runStartedAt.toISOString(),
          finishedAt: runFinishedAt.toISOString(),
          totalDurationMs: runFinishedAt.getTime() - runStartedAt.getTime(),
          stepTimings,
          errorMessage: caughtError
            ? serializeErrorForDiagnostics(caughtError)
            : undefined,
        },
      );
    }
  }

  if (caughtError) {
    // Log the real error server-side for debugging, but never let its raw
    // text (which can carry gateway response bodies, stack traces, or
    // other infrastructure detail) escape the workflow. Anything that
    // observes this run's failure -- the Workflow SDK's stream, a client
    // reconnect, etc. -- only ever sees the sanitized message.
    console.error("[workflow] agent run failed:", caughtError);
    throw new Error(toFriendlyChatErrorText(caughtError, isRepeatFailure), {
      cause: caughtError,
    });
  }
}

// Last-resort backstop, NOT the primary fix. The primary fix for
// runaway multi-tool-call turns is the "Tool-Call Economy" section in
// packages/agent/system-prompt.ts (no blind retries, capped
// verification loops, no redundant re-reads) -- that's what should stop
// a turn from spiraling into 20+ tool calls in the first place.
// This constant just caps the absolute worst case if the prompt fix
// doesn't fully prevent a loop, so one turn can never again burn
// through most/all of a plan's credit in one shot like the incident
// where two turns with 21-24 tool calls each drained ~$9 of a user's
// $10 Plus-plan grant in under 25 minutes. Set high on purpose so it
// never interferes with legitimate heavy single-turn work -- it should
// almost never fire.
const MAX_TURN_SPEND_CENTS = 500;

const runAgentStep = async (
  messages: ModelMessage[],
  originalMessages: WebAgentUIMessage[],
  messageId: string,
  writable: Writable,
  workflowRunId: string,
  chatId: string,
  sessionId: string,
  userId: string,
  sessionTitle: string,
  selectedModelId: string,
  modelId: string,
  agentOptions: WorkflowAgentOptions,
  stepNumber: number,
  modelCostCatalog: AvailableModel[],
  startingBalanceCents: number,
  enforceCreditBlock: boolean,
) => {
  "use step";

  const stepStartedAt = new Date();
  const { webAgent } = await import("@/app/config");

  const abortController = new AbortController();
  const stopMonitor = startStopMonitor(workflowRunId, abortController, userId);

  // Real-time per-step billing: debited immediately after each model
  // step finishes (see the messageMetadata "finish-step" handler below)
  // instead of only once as a lump sum at the very end of the whole
  // turn (the old chat-post-finish.ts behavior). `remainingBalanceCents`
  // is a plain in-memory counter mutated synchronously inside the
  // "finish-step" callback -- messageMetadata's type signature is sync
  // (no Promise support), so the abort decision can't depend on an
  // awaited DB round-trip without risking it firing a step late. The
  // actual ledger writes are queued in `pendingDebits` and flushed with
  // Promise.all before this step function returns, so they're still
  // durably committed before any workflow checkpoint.
  let remainingBalanceCents = startingBalanceCents;
  let creditExhausted = false;
  // Tripped when this turn's cumulative cost (totalMessageCost, which
  // persists across outer-loop step calls via message metadata -- see
  // the assignment below) crosses MAX_TURN_SPEND_CENTS, regardless of
  // how much account balance remains.
  let turnSpendCapped = false;
  const pendingDebits: Promise<void>[] = [];
  // Hoisted above the try/catch/finally on purpose -- `let` inside the
  // try block would be out of scope in the `finally` below, where it
  // needs to be closed regardless of which branch ran.
  let mcpToolSet: Awaited<ReturnType<typeof createMcpToolSet>> | undefined;

  try {
    let responseMessage: WebAgentUIMessage | undefined;
    let lastStepUsage: LanguageModelUsage | undefined;
    let lastStepCost: number | undefined;
    const lastOriginalMessage = originalMessages.at(-1);
    const existingStepFinishReasons: WebAgentStepFinishMetadata[] =
      lastOriginalMessage?.role === "assistant"
        ? [...(lastOriginalMessage.metadata?.stepFinishReasons ?? [])]
        : [];
    const existingTotalMessageUsage =
      lastOriginalMessage?.role === "assistant"
        ? lastOriginalMessage.metadata?.totalMessageUsage
        : undefined;
    const existingTotalMessageCost =
      lastOriginalMessage?.role === "assistant"
        ? lastOriginalMessage.metadata?.totalMessageCost
        : undefined;
    const existingStepBreakdown: WebAgentStepCostBreakdown[] =
      lastOriginalMessage?.role === "assistant"
        ? [...(lastOriginalMessage.metadata?.stepBreakdown ?? [])]
        : [];
    let stepFinishReasons = existingStepFinishReasons;
    let totalMessageUsage = existingTotalMessageUsage;
    let totalMessageCost = existingTotalMessageCost;

    // Rebuild the real `commitAndPush` closure here, inside the step --
    // it was intentionally left out of `agentOptions` (see
    // WorkflowAgentOptions) because functions cannot cross the
    // workflow-to-step serialization boundary. This runs with full
    // Node/DB access since we're already inside a step.
    const githubContext = agentOptions.github;
    const vercelContext = agentOptions.vercel;
    const fullAgentOptions: OpenAgentCallOptions = {
      ...agentOptions,
      github: githubContext
        ? {
            hasRepo: githubContext.hasRepo,
            repoOwner: githubContext.repoOwner,
            repoName: githubContext.repoName,
            commitAndPush: async (input) => {
              if (
                !githubContext.hasRepo ||
                !githubContext.repoOwner ||
                !githubContext.repoName
              ) {
                return {
                  committed: false,
                  pushed: false,
                  error:
                    "No GitHub repository is connected to this session yet.",
                };
              }
              const commitMessage = input.commitTitle
                ? input.commitBody
                  ? `${input.commitTitle}\n\n${input.commitBody}`
                  : input.commitTitle
                : undefined;
              return performAgentCommitAndPush({
                sandboxState: agentOptions.sandbox.state,
                userId,
                sessionId,
                sessionTitle,
                repoOwner: githubContext.repoOwner,
                repoName: githubContext.repoName,
                ...(commitMessage ? { commitMessage } : {}),
              });
            },
            request: async (input) => {
              if (
                !githubContext.hasRepo ||
                !githubContext.repoOwner ||
                !githubContext.repoName
              ) {
                return {
                  success: false,
                  error:
                    "No GitHub repository is connected to this session yet.",
                };
              }
              return performAgentGithubApiRequest({
                userId,
                repoOwner: githubContext.repoOwner,
                repoName: githubContext.repoName,
                method: input.method,
                path: input.path,
                params: input.params,
              });
            },
            cli: async (input): Promise<GithubRawCliResult> => {
              if (
                !githubContext.hasRepo ||
                !githubContext.repoOwner ||
                !githubContext.repoName
              ) {
                return {
                  success: false,
                  error:
                    "No GitHub repository is connected to this session yet.",
                };
              }
              return performAgentGithubCli({
                userId,
                sandboxState: agentOptions.sandbox.state,
                workingDirectory: agentOptions.sandbox.workingDirectory,
                repoOwner: githubContext.repoOwner,
                repoName: githubContext.repoName,
                args: input.args,
              });
            },
          }
        : undefined,
      vercel: vercelContext
        ? {
            connected: vercelContext.connected,
            run: async (input) => {
              if (!vercelContext.connected) {
                return {
                  success: false,
                  error: "No Vercel account is connected for this user.",
                };
              }
              return performAgentVercelCli({
                userId,
                sandboxState: agentOptions.sandbox.state,
                workingDirectory: agentOptions.sandbox.workingDirectory,
                repoOwner: githubContext?.repoOwner,
                repoName: githubContext?.repoName,
                args: input.args,
              });
            },
            request: async (input): Promise<VercelApiResult> => {
              if (!vercelContext.connected) {
                return {
                  success: false,
                  error: "No Vercel account is connected for this user.",
                };
              }
              return performAgentVercelApiRequest({
                userId,
                method: input.method,
                path: input.path,
                params: input.params,
              });
            },
          }
        : undefined,
      // Rebuilt here for the same reason as commitAndPush above --
      // functions can't cross the workflow-step boundary. Lets the
      // sandbox-lifecycle workflow (a different process, running near
      // this session's hard duration cap) find and kill whatever bash
      // command is running right now before migrating to a fresh
      // sandbox. See SandboxLifecycleHooksContext + lib/sandbox/migration.ts.
      sandboxLifecycleHooks: {
        onCommandStart: async (info) => {
          const { updateSession } = await import("@/lib/db/sessions");
          try {
            await updateSession(sessionId, { activeSandboxCommand: info });
          } catch (error) {
            console.warn(
              `[sandbox-lifecycle] Failed to persist active command for session ${sessionId}:`,
              error,
            );
          }
        },
        onCommandEnd: async (cmdId) => {
          const { getSessionById, updateSession } =
            await import("@/lib/db/sessions");
          try {
            const current = await getSessionById(sessionId);
            // Only clear if it's still the same command -- avoids
            // clobbering a newer in-flight command's record in a race
            // where onCommandEnd for an old command resolves after a
            // new one already started (shouldn't normally happen since
            // bash tool calls are sequential per session, but cheap to
            // guard against).
            if (current?.activeSandboxCommand?.cmdId === cmdId) {
              await updateSession(sessionId, { activeSandboxCommand: null });
            }
          } catch (error) {
            console.warn(
              `[sandbox-lifecycle] Failed to clear active command for session ${sessionId}:`,
              error,
            );
          }
        },
        refreshSandboxState: async () => {
          const { getSessionById } = await import("@/lib/db/sessions");
          const current = await getSessionById(sessionId);
          // Falls back to the state already known for this step if the
          // session vanished/archived mid-retry -- exec() against a
          // stale-but-real state at least fails with a clear error
          // instead of throwing here and losing the tool result.
          return current?.sandboxState ?? agentOptions.sandbox.state;
        },
      },
    };

    // Self-serve MCP servers this user has configured (see
    // lib/db/mcp-servers.ts + packages/agent/tools/mcp.ts). Resolved
    // fresh every step -- there's no long-lived process to pool the
    // connections across steps anyway (this "use step" function can
    // resume on a different worker between steps), same reasoning as
    // why DB connections aren't cached across steps in this file.
    // Deliberately never blocks/fails the turn: a broken server is
    // logged and skipped, not surfaced as a step error.
    try {
      const { getEnabledMcpServersForRequest } =
        await import("@/lib/db/mcp-servers");
      const enabledServers = await getEnabledMcpServersForRequest(userId);
      if (enabledServers.length > 0) {
        mcpToolSet = await createMcpToolSet(enabledServers);
        if (mcpToolSet.failures.length > 0) {
          console.warn(
            `[workflow] ${mcpToolSet.failures.length} MCP server(s) failed to connect for user ${userId}:`,
            mcpToolSet.failures,
          );
          const { recordMcpServerConnectionResult } =
            await import("@/lib/db/mcp-servers");
          const { listMcpServers } = await import("@/lib/db/mcp-servers");
          const servers = await listMcpServers(userId);
          await Promise.all(
            mcpToolSet.failures.map(async (failure) => {
              const server = servers.find((s) => s.name === failure.name);
              if (server) {
                await recordMcpServerConnectionResult(server.id, failure.error);
              }
            }),
          );
        }
      }
    } catch (error) {
      console.warn(
        `[workflow] Failed to resolve MCP servers for user ${userId}, continuing without them:`,
        error,
      );
    }
    if (mcpToolSet?.tools && Object.keys(mcpToolSet.tools).length > 0) {
      fullAgentOptions.extraTools = mcpToolSet.tools;
    }

    const result = await webAgent.stream({
      messages,
      options: fullAgentOptions,
      abortSignal: abortController.signal,
    });

    for await (const part of result.toUIMessageStream<WebAgentUIMessage>({
      originalMessages,
      generateMessageId: () => messageId,
      sendStart: false,
      sendFinish: false,
      // Never let raw provider/gateway error text (Opencode Zen, upstream
      // model APIs, etc.) reach the client as an in-stream "error" chunk --
      // route it through the same sanitizer used for setup/transport
      // failures below.
      onError: toFriendlyChatErrorText,
      messageMetadata: ({ part: streamPart }) => {
        if (streamPart.type === "finish-step") {
          lastStepUsage = streamPart.usage;
          if (streamPart.usage) {
            totalMessageUsage = totalMessageUsage
              ? addLanguageModelUsage(totalMessageUsage, streamPart.usage)
              : streamPart.usage;
          }
          const stepCost = estimateStepCost(
            streamPart.providerMetadata,
            modelId,
            streamPart.usage,
            modelCostCatalog,
          );
          if (stepCost !== undefined) {
            lastStepCost = stepCost;
            totalMessageCost = (totalMessageCost ?? 0) + stepCost;

            const stepCostCents = Math.round(stepCost * 100);
            if (stepCostCents > 0) {
              // Fire the ledger write now (queued, flushed before this
              // step function returns) -- see the pendingDebits comment
              // above for why this can't simply be awaited right here.
              pendingDebits.push(
                (async () => {
                  const { debitUsage } =
                    await import("@/lib/billing/credit-ledger");
                  try {
                    await debitUsage(userId, stepCostCents, {
                      modelId,
                      description: `Usage: ${modelId}`,
                    });
                  } catch (error) {
                    console.error(
                      "[workflow] Failed to debit credit ledger in real time:",
                      error,
                    );
                  }
                })(),
              );

              if (enforceCreditBlock) {
                remainingBalanceCents -= stepCostCents;
                if (remainingBalanceCents <= 0 && !creditExhausted) {
                  creditExhausted = true;
                  // Stop the model mid-turn the instant the balance is
                  // spent -- the outer step loop (runAgentWorkflow) also
                  // checks `creditExhausted` on the returned result so it
                  // never starts another (now-unaffordable) step.
                  abortController.abort();
                }
              }

              // Per-turn cost circuit-breaker: independent of the
              // account-balance check above, never let one turn spend
              // past MAX_TURN_SPEND_CENTS. totalMessageCost already
              // accumulates across every step of this turn (see its
              // declaration above), including steps from earlier calls
              // to runAgentStep for this same message.
              if (
                !turnSpendCapped &&
                Math.round((totalMessageCost ?? 0) * 100) >=
                  MAX_TURN_SPEND_CENTS
              ) {
                turnSpendCapped = true;
                abortController.abort();
              }
            }
          }
          stepFinishReasons = [
            ...stepFinishReasons,
            {
              finishReason: streamPart.finishReason,
              rawFinishReason: streamPart.rawFinishReason,
            },
          ];
          return {
            selectedModelId,
            modelId,
            lastStepUsage,
            totalMessageUsage,
            lastStepCost,
            totalMessageCost,
            lastStepFinishReason: streamPart.finishReason,
            lastStepRawFinishReason: streamPart.rawFinishReason,
            stepFinishReasons,
          } satisfies WebAgentMessageMetadata;
        }
        return undefined;
      },
      onFinish: ({ responseMessage: finishedResponseMessage }) => {
        responseMessage = finishedResponseMessage;
      },
    })) {
      const writer = writable.getWriter();
      await writer.write(part);
      writer.releaseLock();
    }

    if (responseMessage == null) {
      throw new Error("Agent stream finished without a response message");
    }

    responseMessage = {
      ...responseMessage,
      metadata: withModelMetadata(
        responseMessage.metadata,
        selectedModelId,
        modelId,
      ),
    };

    const [stepUsage, finishReason, rawFinishReason, response, steps] =
      await Promise.all([
        result.totalUsage,
        result.finishReason,
        result.rawFinishReason,
        result.response,
        result.steps,
      ]);

    if (stepUsage) {
      responseMessage = {
        ...responseMessage,
        metadata: {
          ...responseMessage.metadata,
          totalMessageUsage: existingTotalMessageUsage
            ? addLanguageModelUsage(existingTotalMessageUsage, stepUsage)
            : stepUsage,
        },
      };
    }

    const stepsCost = steps.reduce<number | undefined>((sum, step) => {
      const cost = estimateStepCost(
        step.providerMetadata,
        modelId,
        step.usage,
        modelCostCatalog,
      );
      if (cost === undefined) {
        return sum;
      }
      return (sum ?? 0) + cost;
    }, undefined);

    // Per-step breakdown for the "what made up this cost" dropdown on the
    // usage pill -- one entry per model step in this turn, carrying the
    // model, token usage, estimated cost, and which tools it called.
    const newStepBreakdown: WebAgentStepCostBreakdown[] = steps.map((step) => ({
      stepNumber: existingStepBreakdown.length + step.stepNumber + 1,
      modelId: step.model?.modelId ?? modelId,
      finishReason: step.finishReason,
      rawFinishReason: step.rawFinishReason,
      usage: step.usage,
      cost: estimateStepCost(
        step.providerMetadata,
        modelId,
        step.usage,
        modelCostCatalog,
      ),
      toolCallNames: step.toolCalls.map((toolCall) => toolCall.toolName),
    }));
    const stepBreakdown = [...existingStepBreakdown, ...newStepBreakdown];
    responseMessage = {
      ...responseMessage,
      metadata: {
        ...responseMessage.metadata,
        stepBreakdown,
      },
    };

    if (stepsCost !== undefined) {
      const carriedCost = (existingTotalMessageCost ?? 0) + stepsCost;
      responseMessage = {
        ...responseMessage,
        metadata: {
          ...responseMessage.metadata,
          lastStepCost,
          totalMessageCost: carriedCost,
        },
      };
    }

    if (finishReason === "other") {
      const stepDiagnostics = steps.map((step) => ({
        stepNumber: step.stepNumber,
        model: step.model,
        finishReason: step.finishReason,
        rawFinishReason: step.rawFinishReason,
        usage: step.usage,
        warnings: step.warnings,
        contentTypes: step.content.map((contentPart) => contentPart.type),
        toolCalls: step.toolCalls.map((toolCall) =>
          compactRecord({
            toolName: toolCall.toolName,
            dynamic: toolCall.dynamic,
            invalid: "invalid" in toolCall ? toolCall.invalid : undefined,
            providerExecuted: toolCall.providerExecuted,
          }),
        ),
        toolResults: step.toolResults.map((toolResult) =>
          compactRecord({
            toolName: toolResult.toolName,
            dynamic: toolResult.dynamic,
            preliminary: toolResult.preliminary,
            providerExecuted: toolResult.providerExecuted,
          }),
        ),
        request: compactRecord({
          body: summarizeRequestBody(step.request.body),
        }),
        response: compactRecord({
          id: step.response.id,
          modelId: step.response.modelId,
          timestamp: step.response.timestamp.toISOString(),
          headers: step.response.headers,
          body: summarizeResponseBody(step.response.body),
          messageCount: step.response.messages.length,
        }),
        providerMetadata: step.providerMetadata,
      }));

      const debugPayload = stringifyDebugPayload({
        workflowRunId,
        chatId,
        sessionId,
        messageId,
        selectedModelId,
        modelId,
        finishReason,
        rawFinishReason,
        stepUsage,
        response,
        responseMessage,
        stepDiagnostics,
      });

      console.warn(
        `[workflow] Agent step finished with reason 'other':\n${debugPayload}`,
      );

      const responseText = extractPlainText(responseMessage.parts);
      if (detectProviderQuotaExhaustion(finishReason, responseText)) {
        console.warn(
          `[workflow] Detected provider-side quota exhaustion for model '${modelId}' -- rewriting response before it is persisted. Raw text: ${responseText}`,
        );
        responseMessage = markProviderQuotaExhausted(responseMessage, modelId);
      }
    }

    const stepFinishedAt = new Date();

    return {
      responseMessage,
      responseMessages: response.messages,
      finishReason,
      rawFinishReason,
      stepUsage,
      stepCost: stepsCost,
      stepWasAborted: false,
      remainingBalanceCents,
      creditExhausted,
      turnSpendCapped,
      stepTiming: buildStepTiming(
        stepNumber,
        stepStartedAt,
        stepFinishedAt,
        finishReason,
        rawFinishReason,
      ),
    };
  } catch (error) {
    const stepFinishedAt = new Date();

    if (isAbortError(error)) {
      const abortedFinishReason: FinishReason = "stop";
      return {
        responseMessage: undefined,
        responseMessages: [],
        finishReason: abortedFinishReason,
        rawFinishReason: undefined,
        stepUsage: undefined,
        stepCost: undefined,
        stepWasAborted: true,
        remainingBalanceCents,
        creditExhausted,
        turnSpendCapped,
        stepTiming: buildStepTiming(
          stepNumber,
          stepStartedAt,
          stepFinishedAt,
          abortedFinishReason,
        ),
      };
    }

    const errorWithStepTiming =
      error instanceof Error ? error : new Error(String(error));
    Object.assign(errorWithStepTiming, {
      stepTiming: buildStepTiming(
        stepNumber,
        stepStartedAt,
        stepFinishedAt,
        "error",
        errorWithStepTiming.name,
      ),
    });

    // Real incident, 2026-08-17: a bad-param request (reasoning_effort
    // "max" not accepted by the real upstream behind gpt-5.6-luna) threw
    // an AI_APICallError that the AI SDK itself had already correctly
    // flagged `isRetryable: false` -- but nothing here told the Workflow
    // SDK's own step-retry layer that, so it retried the identical
    // guaranteed-to-fail request 3 more times (4 attempts total) before
    // finally giving up, needlessly delaying the failure and burning a
    // model-call attempt each time for no chance of success. Any 4xx
    // APICallError the AI SDK itself marks non-retryable is exactly the
    // class of error `FatalError` exists for -- skips the Workflow SDK's
    // retries entirely so a permanent, param-level failure fails once
    // and immediately instead of 4 times.
    if (isNonRetryableApiCallError(errorWithStepTiming)) {
      // FatalError's constructor only takes a message string (see
      // node_modules/workflow's own docs -- no options/cause param), so
      // stepTiming has to be reattached manually to keep the outer
      // loop's isStepTimingError(error) pickup working the same way it
      // does for the plain-throw path above.
      const fatalError = new FatalError(errorWithStepTiming.message);
      Object.assign(fatalError, {
        stepTiming: (errorWithStepTiming as { stepTiming?: unknown })
          .stepTiming,
        cause: errorWithStepTiming,
      });
      throw fatalError;
    }

    throw errorWithStepTiming;
  } finally {
    // Flush queued real-time ledger debits before this step function
    // returns/checkpoints, regardless of which branch above ran --
    // otherwise a workflow suspend right after this call could lose an
    // in-flight (unawaited) debitUsage write.
    await Promise.all(pendingDebits);
    // Close any MCP server connections opened for this step -- see the
    // resolution block above. Safe to call even if mcpToolSet is
    // undefined (no servers were configured this step).
    await mcpToolSet?.close();
    stopMonitor.stop();
    await stopMonitor.done;
  }
};

function startStopMonitor(
  runId: string,
  abortController: AbortController,
  userId: string,
) {
  let shouldStop = false;

  const done = (async () => {
    const run = getRun(runId);
    // Resolved once per turn, not re-checked per tick -- admin status
    // doesn't change mid-stream, only the free-tier gate flag does (see
    // the dynamic import below, polled every tick for that reason).
    const { isUserAdmin } = await import("@/lib/db/users");
    const isAdminUser = await isUserAdmin(userId).catch(() => true);

    while (!shouldStop && !abortController.signal.aborted) {
      let runStatus:
        | "pending"
        | "running"
        | "completed"
        | "failed"
        | "cancelled";

      try {
        runStatus = await run.status;
      } catch {
        await delay(150);
        continue;
      }

      if (runStatus === "cancelled") {
        abortController.abort();
        return;
      }

      if (!isAdminUser) {
        // Dynamic import: getFreeTierGateStatus touches the drizzle db
        // client, which must not be statically imported into this
        // "use workflow" module -- see the matching comment in
        // resolveChatModelRuntime.
        const { getFreeTierGateStatus } =
          await import("@/lib/db/platform-settings");
        const gate = await getFreeTierGateStatus().catch(() => ({
          enabled: true,
          reason: null,
        }));
        if (!gate.enabled) {
          abortController.abort();
          return;
        }
      }

      await delay(150);
    }
  })();

  return {
    stop() {
      shouldStop = true;
    },
    done,
  };
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * See the FatalError-throwing block above (2026-08-17 incident: a
 * guaranteed-to-fail bad-param request retried 4 identical times before
 * failing for good -- gpt-5.6-luna rejecting reasoning_effort "max"). An
 * AI SDK `APICallError` is authoritative here -- the SDK itself already
 * inspects the HTTP status code/response shape and sets `isRetryable`
 * accordingly (false for 4xx client errors like an unsupported param
 * value, true for 429/5xx). If some future provider/route sends back a
 * 4xx without APICallError's own retry heuristic catching it, this also
 * treats any explicit "invalid_request_error" statusCode-400 response
 * as non-retryable on its own merits, independent of `isRetryable` --
 * belt and suspenders, since a malformed request will never succeed on
 * retry regardless of what any single provider's error-classification
 * happens to set.
 */
function isNonRetryableApiCallError(error: unknown): boolean {
  if (!(error instanceof APICallError)) {
    return false;
  }
  if (error.isRetryable === false) {
    return true;
  }
  if (error.statusCode !== 400) {
    return false;
  }
  const data = error.data;
  if (isObjectRecord(data) && isObjectRecord(data.error)) {
    return data.error.type === "invalid_request_error";
  }
  return false;
}

async function sendTextMessage(writable: Writable, id: string, text: string) {
  "use step";
  const writer = writable.getWriter();
  try {
    await writer.write({ type: "text-start", id });
    await writer.write({ type: "text-delta", id, delta: text });
    await writer.write({ type: "text-end", id });
  } finally {
    writer.releaseLock();
  }
}
