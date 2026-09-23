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
import type { SandboxState } from "@open-agents/sandbox";
import type { PlanUsageWindows } from "@/lib/billing/plans";
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
import { settleStepCost } from "@/lib/billing/usage-accrual";
import type { UsageAccrualState } from "@/lib/billing/usage-accrual";
import { addLanguageModelUsage } from "./usage-utils";
import { estimateStepCost } from "./gateway-metadata";
import {
  applySpendToBudgets,
  buildSubagentBudgetGuard,
  computeRealtimeSpendCap,
  estimateNextStepInputTokens,
} from "@/lib/chat/realtime-spend-cap";
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
  persistFinalAssistantMessage,
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
import { sanitizeMessageToolInputs } from "@/lib/chat/sanitize-tool-inputs";
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
  /** From user_preferences -- see hasGuidedFrontendWorkflowTrigger below
   * for the other (per-turn, phrase-based) way this can turn on. */
  guidedFrontendWorkflowEnabled: boolean;
  /** This turn's credit balance (cents) at the moment the turn started --
   * threaded into runAgentStep so it can decrement it in real time after
   * every model step and abort mid-turn on exhaustion. See the block
   * above that computes it for why admins get a value too. */
  startingBalanceCents: number;
  /** Remaining allowance of the tightest Entry-plan usage window at
   * turn start (5h/weekly/monthly), enforced mid-turn via its own
   * in-memory counter -- null when the plan has no windows. Applies to
   * admins too (owner request 2026-09-15: the admin account on the
   * Entry plan behaves like a normal subscriber for windows). */
  windowBudgetCents: number | null;
  /** True for non-admins -- controls whether runAgentStep is allowed to
   * abort the stream when the running balance hits zero. Admins are
   * still billed (see runAgentStep) but never blocked. */
  enforceCreditBlock: boolean;
};

type Writable = WritableStream<UIMessageChunk>;

function attachLiveModelContextWindow(
  selection: OpenAgentCallOptions["model"],
  catalog: AvailableModel[],
): OpenAgentCallOptions["model"] {
  if (!selection) {
    return selection;
  }

  const modelId = typeof selection === "string" ? selection : selection.id;
  const contextWindow = catalog.find(
    (model) => model.id === modelId,
  )?.context_window;

  if (
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    // Keep the existing conservative package fallback when the gateway
    // doesn't publish a context_window for a model. This preserves
    // backwards compatibility without making a missing metadata field
    // capable of disabling the agent.
    return selection;
  }

  if (typeof selection === "string") {
    return {
      id: selection,
      contextWindow,
    };
  }

  return {
    ...selection,
    contextWindow,
  };
}

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
    .map(canonicalizeMessageParts)
    .map(sanitizeMessageToolInputs);
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
  let windowBudgetCents: number | null = null;
  let planUsageWindows: PlanUsageWindows | null = null;
  if (!isAdminUser) {
    const { enforcePlanExpiry, claimUserBillingTurn } =
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

    // OWN expiry enforcement (owner 2026-09-15: don't rely on
    // Paystack): if the paid plan's last renewal is older than the
    // grace window, this downgrades to Free RIGHT HERE and returns the
    // updated state -- the turn below then runs as a Free user. No
    // webhook delivery involved; it cannot be missed.
    const billingState = await enforcePlanExpiry(params.userId);
    const plan = getPlanDefinition(billingState?.plan);
    planUsageWindows = plan.usageWindows ?? null;
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
    // Admins are never blocked on BALANCE, but their usage is still
    // billed (see runAgentStep) -- fetch their balance too so it stays
    // accurate, just without any gating decision riding on it. Usage
    // WINDOWS still apply (owner request 2026-09-15: "yes normal") --
    // an admin on the Entry plan is treated like a normal subscriber
    // for windows; only the balance gate stays admin-exempt.
    const { getUserBillingState } = await import("@/lib/billing/credit-ledger");
    const { getPlanDefinition } = await import("@/lib/billing/plans");
    const billingState = await getUserBillingState(params.userId);
    startingBalanceCents = billingState?.creditBalanceCents ?? 0;
    planUsageWindows =
      getPlanDefinition(billingState?.plan).usageWindows ?? null;
  }

  // Entry Windows (2026-09-15, shared gate): rolling 5-hour / weekly /
  // monthly usage pacing for plans that define windows (only the Entry
  // plan today), enforced for admins and non-admins alike. Debits land
  // in credit_transactions as usage_debit rows in real time (see
  // runAgentStep), so this pre-turn sum is always complete. The
  // mid-turn budget below is a SEPARATE counter from the balance
  // budget, so a window trip and a balance trip are distinguishable
  // (refill-soon vs top-up wording) and an admin's balance privileges
  // don't accidentally re-enable a balance block they're exempt from.
  if (planUsageWindows) {
    const { getUsageWindowTotals } =
      await import("@/lib/billing/credit-ledger");
    const { findExceededUsageWindow } = await import("@/lib/billing/plans");
    const totals = await getUsageWindowTotals(params.userId);
    const exceeded = findExceededUsageWindow(totals, planUsageWindows);
    if (exceeded) {
      const limitCents =
        exceeded === "fiveHour"
          ? planUsageWindows.fiveHourLimitCents
          : exceeded === "weekly"
            ? planUsageWindows.weeklyLimitCents
            : planUsageWindows.monthlyLimitCents;
      const limitUsd = (limitCents / 100).toFixed(0);
      throw toSafeChatError(
        exceeded === "fiveHour"
          ? `Your Entry plan's 5-hour usage window is full -- $${limitUsd} of usage per rolling 5 hours. It refills continuously as your oldest usage slides out; try again in a little while.`
          : exceeded === "weekly"
            ? `Your Entry plan's weekly usage window is full -- $${limitUsd} of usage per rolling 7 days. It refills as your oldest usage slides out of the week; try again later.`
            : `Your Entry plan's monthly usage window is full -- $${limitUsd} of usage per rolling 30 days. It refills as your oldest usage slides out of the month; try again later.`,
      );
    }

    // Accuracy (2026-09-15): the turn's window budget is the tightest
    // REMAINING allowance across all windows. runAgentStep decrements
    // it after every model step and aborts the instant it hits zero, so
    // a turn stops exactly at the window edge mid-turn instead of
    // overshooting by up to one whole turn before the next pre-turn
    // gate notices.
    windowBudgetCents = Math.min(
      planUsageWindows.fiveHourLimitCents - totals.last5HoursCents,
      planUsageWindows.weeklyLimitCents - totals.last7DaysCents,
      planUsageWindows.monthlyLimitCents - totals.last30DaysCents,
    );
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
    windowBudgetCents,
    enforceCreditBlock: !isAdminUser,
    guidedFrontendWorkflowEnabled:
      preferences?.guidedFrontendWorkflowEnabled ?? false,
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

// Lets a user opt into the guided frontend workflow (see
// packages/agent/system-prompt.ts's GUIDED_FRONTEND_WORKFLOW_PROMPT) for
// a single turn even when their preferences.guidedFrontendWorkflowEnabled
// is off -- e.g. "use the guided frontend workflow to build a pricing
// page". Deliberately just a plain substring check (case-insensitive),
// same spirit as the existing "/<skill-name>" slash-command detection in
// packages/agent/system-prompt.ts -- no NLU, no session-level state.
const GUIDED_FRONTEND_WORKFLOW_TRIGGER_PHRASE = "guided frontend workflow";

function hasGuidedFrontendWorkflowTrigger(
  message: WebAgentUIMessage | undefined,
): boolean {
  if (!message || message.role !== "user") return false;
  return extractPlainText(message.parts)
    .toLowerCase()
    .includes(GUIDED_FRONTEND_WORKFLOW_TRIGGER_PHRASE);
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
  sandboxState: NonNullable<OpenAgentCallOptions["sandbox"]>["state"];
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
 * from performAgentVercelCli (which needs the *real* token, fetched
 * fresh right before actually running a CLI command -- better-auth
 * refreshes it purely from the stored (providerId, userId) refresh
 * token, no request-scoped headers involved, same as the GitHub token
 * fetch in lib/github/token.ts) since this only needs a cheap
 * existence check to decide whether to surface the tool at all.
 */
/**
 * Fetches the live model/pricing catalog for the per-turn cost pill, as
 * its own step -- same reasoning as checkVercelConnectedStep just below:
 * lib/models-with-context.ts's catalog functions can touch the drizzle
 * db client ("postgres", a Node built-in) through
 * lib/db/model-overrides.ts, a Node module the Workflow SDK's bundler
 * refuses to include in the restricted "use workflow" environment when
 * reached via a static top-of-file import -- even though the actual
 * live-pricing HTTP call itself (fetchGatewayModels, via the
 * workflow-safe hoisted `fetch`) is fine on its own. Loaded via dynamic
 * import() inside this "use step" function instead, same fix as every
 * other DB/Node-module touchpoint in this file.
 *
 * PERF + PRICING FIX 2026-09-15: this step used to call
 * fetchAvailableLanguageModels(), which (a) ran the admin kill-switch DB
 * query (filterDisabledModels -> model-overrides) on EVERY turn's
 * critical path just to price usage, and (b) per the 2026-08-17 pricing
 * lesson, using the filtered catalog for cost lookup is wrong anyway --
 * an admin disabling a model mid-conversation would silently stop its
 * usage from being priced/debited. Switched to fetchModelCostCatalog()
 * (pricing-only, unfiltered, kill-switch-free), which is both cheaper
 * per turn and correct.
 */
async function fetchModelCostCatalogStep(): Promise<AvailableModel[]> {
  "use step";

  const { fetchModelCostCatalog } = await import("@/lib/models-with-context");
  return fetchModelCostCatalog();
}

/**
 * Sandbox-dependent tool closures (commit/push, gh, vercel CLI) need a real
 * workspace connection, and the turn may have started without one. Rather
 * than a TypeError on `undefined.state`, fail as a tool error the model can
 * read and recover from -- the workspace only needs to still be coming up.
 */
function requireSandboxContext(
  agentOptions: WorkflowAgentOptions,
): NonNullable<WorkflowAgentOptions["sandbox"]> {
  if (!agentOptions.sandbox) {
    throw new Error(
      "The workspace for this session is still starting up -- provisioning runs in the background. " +
        "Retry this action once it is ready.",
    );
  }
  return agentOptions.sandbox;
}

/**
 * Workspace lifecycle control for the agent's `sandbox` tool.
 *
 * Each action maps 1:1 onto the server-side implementation the UI and the
 * scheduled sandboxLifecycleWorkflow already use -- there is deliberately no
 * second code path here, so an agent-driven provision/migrate/delete behaves
 * exactly like the button press or the cron tick the user already trusts.
 * Every step is a separate "use step" for the usual reason: these modules
 * pull in the drizzle client ("postgres") and the Vercel Sandbox SDK, which
 * the Workflow SDK's restricted "use workflow" bundle refuses to include.
 */
async function getSandboxStatusStep(
  sessionId: string,
): Promise<Record<string, unknown>> {
  "use step";

  const { getSessionById } = await import("@/lib/db/sessions");
  const { hasResumableSandboxState, canOperateOnSandbox } =
    await import("@/lib/sandbox/utils");

  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  const state = session.sandboxState;
  return {
    status: !state
      ? "missing"
      : canOperateOnSandbox(state)
        ? "running"
        : hasResumableSandboxState(state)
          ? "paused"
          : "missing",
    lifecycleState: session.lifecycleState,
    sandboxExpiresAt: session.sandboxExpiresAt ?? null,
    hasRepo: Boolean(session.repoOwner && session.repoName),
    isArchived: session.status === "archived",
  };
}

async function provisionSandboxStep(
  sessionId: string,
): Promise<Record<string, unknown>> {
  "use step";

  const { kickSandboxProvisioningWorkflow } =
    await import("@/lib/sandbox/provisioning-kick");

  // Reuses the session's own provisioning claim-lock, so a concurrent UI
  // click or lifecycle run can't double-provision.
  const kick = await kickSandboxProvisioningWorkflow(sessionId);
  return { kickStatus: kick.status, started: Boolean(kick.runId) };
}

async function reconnectSandboxStep(
  sessionId: string,
): Promise<Record<string, unknown>> {
  "use step";

  const { getSessionById } = await import("@/lib/db/sessions");
  const { hasResumableSandboxState, hasRuntimeSandboxState } =
    await import("@/lib/sandbox/utils");

  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  if (session.status === "archived") {
    throw new Error("Session is archived");
  }

  // Nothing to resume from -- say so rather than silently provisioning a
  // brand-new workspace (reconnect and provision are different intents).
  if (
    !hasRuntimeSandboxState(session.sandboxState) &&
    !hasResumableSandboxState(session.sandboxState)
  ) {
    return {
      reconnected: false,
      reason: "no-resumable-workspace",
      hint: "No paused or running workspace to reconnect to. Use the provision action instead.",
    };
  }

  // Reuses the session's own provisioning/resume path, so a reconnect behaves
  // exactly like the UI's reconnect button.
  const { provisionSessionSandbox } =
    await import("@/lib/sandbox/provisioning");
  const result = await provisionSessionSandbox({ sessionId });
  return { ...result, reconnected: true };
}

async function snapshotSandboxStep(
  sessionId: string,
): Promise<Record<string, unknown>> {
  "use step";

  const { getSessionById, updateSession } = await import("@/lib/db/sessions");
  const { connectSandbox } = await import("@open-agents/sandbox");
  const { canOperateOnSandbox, hasResumableSandboxState } =
    await import("@/lib/sandbox/utils");

  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  if (!canOperateOnSandbox(session.sandboxState)) {
    throw new Error(
      "There is no running workspace to snapshot. Start one with the provision action first.",
    );
  }

  const sandbox = await connectSandbox(session.sandboxState);
  if (!sandbox.snapshot) {
    return {
      snapshotted: false,
      reason: "unsupported",
      hint: "This sandbox does not support snapshots.",
    };
  }

  const result = await sandbox.snapshot();
  // Persist the snapshot id so a later reconnect can restore it, and move the
  // lifecycle into the same hibernated state the status route uses.
  const currentState = session.sandboxState;
  await updateSession(sessionId, {
    snapshotUrl: result.snapshotId,
    snapshotCreatedAt: new Date(),
    lifecycleState: hasResumableSandboxState(currentState)
      ? "hibernated"
      : "provisioning",
  });

  return { snapshotted: true, snapshotId: result.snapshotId };
}

async function migrateSandboxStep(
  sessionId: string,
): Promise<Record<string, unknown>> {
  "use step";

  const { getSessionById } = await import("@/lib/db/sessions");
  const { performSandboxMigration } = await import("@/lib/sandbox/migration");

  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  // A migration run owns the workspace; reusing the session's existing run
  // id keeps the safety net that force-kills in-flight commands intact.
  const result = await performSandboxMigration(
    sessionId,
    session.lifecycleRunId ?? `agent-migrate-${sessionId}`,
  );
  return { ...result };
}

async function extendSandboxStep(
  sessionId: string,
): Promise<Record<string, unknown>> {
  "use step";

  const { getSessionById } = await import("@/lib/db/sessions");
  const { connectSandbox } = await import("@open-agents/sandbox");

  const session = await getSessionById(sessionId);
  if (!session?.sandboxState) {
    throw new Error("There is no workspace to extend yet.");
  }

  const sandbox = await connectSandbox(session.sandboxState);
  if (!sandbox.extendTimeout) {
    return {
      extended: false,
      reason: "This sandbox does not support extending its timeout.",
    };
  }

  const result = await sandbox.extendTimeout(60 * 60 * 1000);
  return { extended: true, expiresAt: result.expiresAt };
}

async function deleteSandboxStep(
  sessionId: string,
): Promise<Record<string, unknown>> {
  "use step";

  const { getSessionById, updateSession } = await import("@/lib/db/sessions");
  const { connectSandbox } = await import("@open-agents/sandbox");
  const { canOperateOnSandbox, clearSandboxState, hasResumableSandboxState } =
    await import("@/lib/sandbox/utils");

  const session = await getSessionById(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }
  if (!canOperateOnSandbox(session.sandboxState)) {
    // Idempotent, matching DELETE /api/sandbox.
    return { deleted: true, alreadyStopped: true };
  }

  const sandbox = await connectSandbox(session.sandboxState);
  await sandbox.stop();

  const clearedState = clearSandboxState(session.sandboxState);
  await updateSession(sessionId, {
    sandboxState: clearedState,
    snapshotUrl: null,
    snapshotCreatedAt: null,
    lifecycleState: hasResumableSandboxState(clearedState)
      ? "hibernated"
      : "provisioning",
    sandboxExpiresAt: null,
    hibernateAfter: null,
    lifecycleRunId: null,
    lifecycleError: null,
  });

  return {
    deleted: true,
    lifecycleState: hasResumableSandboxState(clearedState)
      ? "hibernated"
      : "provisioning",
  };
}

async function checkGithubConnectedStep(userId: string): Promise<boolean> {
  "use step";

  const { getUserOctokit } = await import("@/lib/github/client");
  // A null Octokit means no usable GitHub token -- the same signal
  // hasVercelAccountLinked gives for Vercel, and deliberately NOT a token
  // refresh (better-auth refreshes from the stored (providerId, userId)
  // refresh token; no request-scoped headers involved).
  return (await getUserOctokit(userId)) !== null;
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
  // Optional since GitHub was decoupled from the session's repo: an
  // absolute API path ("/user", "/repos/{owner}/{repo}/...") needs
  // neither. Only repo-relative paths use them.
  repoOwner?: string;
  repoName?: string;
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
  // Absolute paths pass through untouched (account-level API calls with no
  // connected repository); repo-relative ones expand against the session's
  // repo, which the caller has already verified is present.
  const fullPath = rawPath.startsWith("/")
    ? rawPath
    : `/repos/${params.repoOwner ?? ""}/${params.repoName ?? ""}/${rawPath.replace(/^\/+/, "")}`;

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
//
// FIXED 2026-09-12: this used to be "sandboxed-cli-do-not-use", which
// contains hyphens. The real `vercel` CLI validates --token/VERCEL_TOKEN
// client-side with `token.match(/(\W)/g)` -- ANY non-word character
// (hyphens included) fails with "Invalid token... Must not contain:
// '-'" before the process ever makes a network call, so the
// network-egress broker never got a chance to swap in the real token.
// Confirmed via a live session: every vercel_cli call was silently
// dead on arrival despite the broker mechanism being correctly wired.
// Word-only placeholder (letters/digits/underscore) passes that regex
// and lets the real request reach the broker.
const VERCEL_CLI_PLACEHOLDER_TOKEN = "sandboxed_cli_do_not_use";

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
 *
 * FIXED 2026-09-12: this used to assume the `vercel` binary was already
 * on PATH in the sandbox base image (an old comment near
 * ENSURE_GH_CLI_INSTALLED below claimed exactly that, contrasting it
 * with `gh`, which needed its own install guard). Confirmed wrong via a
 * live session: the sandbox base image only ships node/npm/pnpm/bun/jq,
 * nothing Vercel-specific, so every vercel_cli call failed with
 * "command not found" until the agent happened to fall back to
 * vercel_api instead. Added ENSURE_VERCEL_CLI_INSTALLED, same
 * lazy-install-once-per-session pattern as ENSURE_GH_CLI_INSTALLED, via
 * `npm install -g vercel` (npm is always present, so no release-binary
 * download dance like gh needed).
 */
// Lazy, one-time-per-sandbox install guard for the `vercel` CLI -- see
// the FIXED 2026-09-12 note on performAgentVercelCli's docstring above
// for why this exists (the base sandbox image does NOT ship it, despite
// an earlier comment near ENSURE_GH_CLI_INSTALLED claiming otherwise).
// Unlike gh (no package manager guarantee, needs a release-binary
// download), npm is always available here, so a simple global install
// is enough. Cheap no-op on every call after the first thanks to
// `command -v`.
const ENSURE_VERCEL_CLI_INSTALLED =
  "command -v vercel >/dev/null 2>&1 || npm install -g vercel >/dev/null 2>&1";

async function performAgentVercelCli(params: {
  userId: string;
  sandboxState: NonNullable<OpenAgentCallOptions["sandbox"]>["state"];
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
  const command = `${ENSURE_VERCEL_CLI_INSTALLED}; VERCEL_TOKEN=${shellEscapeForVercelEnv(VERCEL_CLI_PLACEHOLDER_TOKEN)} vercel ${params.args}${scopeFlag}`;

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
// isn't guaranteed to ship the GitHub CLI (and, as of 2026-09-12, we
// know it doesn't ship the Vercel CLI either -- see
// ENSURE_VERCEL_CLI_INSTALLED / performAgentVercelCli's docstring above
// for that fix; this comment used to claim otherwise, which was wrong),
// so this downloads the static release binary straight from GitHub's
// own release assets (no apt/sudo dependency, works regardless of the
// base image's package manager) the first time it's missing, then
// reuses it for the rest of the session.
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
  sandboxState: NonNullable<OpenAgentCallOptions["sandbox"]>["state"];
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
  // AGENT-FIRST (owner 2026-09-19): the model turn must start -- and be
  // able to finish -- whether or not the workspace came up. This used to be
  // awaited unconditionally before the first agent step, so any
  // provisioning failure, timeout, or migration wait killed the turn
  // outright and the user got no reply at all.
  //
  // resolveChatSandboxRuntime still kicks provisioning and reaps its
  // result, so when it rejects we simply carry on with no sandbox: the
  // workspace tools then self-heal on their own via
  // sandboxLifecycleHooks.beforeCommand()'s live-state read the moment
  // provisioning finishes, and the user keeps getting answers meanwhile.
  const runtimePromise = resolveChatSandboxRuntime({
    userId: options.userId,
    sessionId: options.sessionId,
  }).catch((error) => {
    console.error(
      `[workflow] Sandbox runtime unavailable for session ${options.sessionId}; continuing without a workspace:`,
      error,
    );
    return null;
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
  // Account-level GitHub connectivity -- deliberately independent of
  // whether this session has a repo linked. Owner request: the agent must
  // be able to work with the user's GitHub (issues, PRs, reviews, anything
  // via the api action) even in a chat with no connected repository.
  // Best-effort: a failed lookup just hides the toolset rather than
  // failing the turn.
  const githubConnectedPromise = checkGithubConnectedStep(options.userId).catch(
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
          if (!runtime) {
            // No workspace yet -- keep the attachments as they are rather
            // than dropping them or failing the turn. The model still gets
            // a usable reply; the upload just happens next time it has a
            // workspace to write into.
            return convertMessages(options.messages);
          }
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
  let sandboxState: SandboxState | undefined;
  let shouldRefreshCachedDiff = false;

  try {
    const [
      ,
      runtime,
      modelRuntime,
      modelMessages,
      ,
      vercelConnected,
      githubConnected,
    ] = await Promise.all([
      activeStreamClaimPromise,
      runtimePromise,
      modelRuntimePromise,
      modelMessagesPromise,
      inputMessagesPersistPromise,
      vercelConnectedPromise,
      githubConnectedPromise,
    ]);
    selectedModelId = options.selectedModelId ?? modelRuntime.selectedModelId;
    modelId = options.modelId ?? modelRuntime.modelId;
    let remainingBalanceCents = modelRuntime.startingBalanceCents;
    let remainingWindowBudgetCents = modelRuntime.windowBudgetCents;
    let creditExhausted = false;
    let windowExhausted = false;
    let turnSpendCapped = false;
    pendingAssistantResponse = {
      ...pendingAssistantResponse,
      metadata: withModelMetadata(
        pendingAssistantResponse.metadata,
        selectedModelId,
        modelId,
      ),
    };

    const hasRepo = Boolean(runtime?.repoOwner && runtime?.repoName);
    // NOTE: `github` here is intentionally the serializable-only shape
    // (no `commitAndPush` closure) -- see WorkflowAgentOptions above.
    // The real closure is rebuilt inside runAgentStep, right before it's
    // needed, so it never has to cross a workflow-step serialization
    // boundary.
    // Preference wins by default; an explicit trigger phrase in this
    // turn's latest user message can only turn it ON, never off -- so a
    // user with the preference disabled can still opt in per-turn, but
    // there's no way to accidentally disable someone else's standing
    // preference via message text.
    const guidedFrontendWorkflow =
      modelRuntime.guidedFrontendWorkflowEnabled ||
      hasGuidedFrontendWorkflowTrigger(latestMessage);
    const agentOptions: WorkflowAgentOptions = {
      ...modelRuntime.agentOptions,
      ...options.agentOptions,
      // The gateway's live catalog is the single runtime source of truth
      // for model context windows. Pass it into the agent selection so
      // prepareStep/auto-compaction never falls back to a stale hardcoded
      // window when a newly-added gateway model has its metadata set.
      model: attachLiveModelContextWindow(
        options.agentOptions?.model ?? modelRuntime.agentOptions.model,
        modelCostCatalog,
      ),
      ...(options.agentOptions?.subagentModel !== undefined ||
      modelRuntime.agentOptions.subagentModel !== undefined
        ? {
            subagentModel: attachLiveModelContextWindow(
              options.agentOptions?.subagentModel ??
                modelRuntime.agentOptions.subagentModel,
              modelCostCatalog,
            ),
          }
        : {}),
      // Optional: absent when the workspace is not ready yet (see
      // runtimePromise above). Every workspace tool resolves its own
      // connection per call and recovers from the session's live state, so
      // a missing sandbox here degrades those tools -- never the turn.
      ...(runtime
        ? {
            sandbox: {
              state: runtime.sandboxState,
              workingDirectory: runtime.workingDirectory,
              currentBranch: runtime.currentBranch,
              environmentDetails: runtime.environmentDetails,
            },
          }
        : {}),
      ...(runtime && runtime.skills.length > 0
        ? { skills: runtime.skills }
        : {}),
      ...(guidedFrontendWorkflow ? { guidedFrontendWorkflow: true } : {}),
      // Only surface the GitHub toolset when the user's account is
      // actually connected. `hasRepo` inside it stays false for a chat
      // with no linked repository -- the tool then gates per action
      // instead of blacking out the whole toolset, so github_api still
      // works account-wide (the whole point of decoupling it).
      ...(githubConnected
        ? {
            github: {
              hasRepo,
              repoOwner: runtime?.repoOwner,
              repoName: runtime?.repoName,
            },
          }
        : {}),
      vercel: {
        connected: vercelConnected,
      },
      // Workspace lifecycle control for the agent's `sandbox` tool. Built
      // from plain data (see the Serializable* types above) and the steps
      // defined near performAgentCommitAndPush -- the agent can act on the
      // session's own workspace without any new permission surface: every
      // action is the same server-side call the UI button makes.
      sandboxControl: {
        status: () => getSandboxStatusStep(options.sessionId),
        provision: () => provisionSandboxStep(options.sessionId),
        reconnect: () => reconnectSandboxStep(options.sessionId),
        migrate: () => migrateSandboxStep(options.sessionId),
        snapshot: () => snapshotSandboxStep(options.sessionId),
        extend: () => extendSandboxStep(options.sessionId),
        delete: () => deleteSandboxStep(options.sessionId),
      },
    };
    sandboxState = runtime?.sandboxState;

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
        // COMPACT TELEMETRY SCOPE (2026-09-17): the sink wraps the model
        // stream INSIDE runAgentStep ("use step"), not here in the
        // workflow function -- see runAgentStep for why (the Workflow
        // SDK's restricted bundle rejects the module graphs the sink's
        // static imports would pull in from workflow scope).
        result = await runAgentStep(
          modelMessages,
          originalMessagesForStep,
          assistantId,
          writable,
          workflowRunId,
          options.chatId,
          options.sessionId,
          options.userId,
          runtime?.sessionTitle ?? "",
          selectedModelId,
          modelId,
          stepAgentOptions,
          step + 1,
          modelCostCatalog,
          remainingBalanceCents,
          modelRuntime.enforceCreditBlock,
          remainingWindowBudgetCents,
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
      remainingWindowBudgetCents = result.remainingWindowBudgetCents;
      creditExhausted = creditExhausted || result.creditExhausted;
      windowExhausted = windowExhausted || result.windowExhausted;
      turnSpendCapped = turnSpendCapped || result.turnSpendCapped;

      if (result.stepUsage) {
        totalUsage = totalUsage
          ? addLanguageModelUsage(totalUsage, result.stepUsage)
          : result.stepUsage;
      }

      if (creditExhausted || windowExhausted || turnSpendCapped) {
        // Real-time billing (see runAgentStep) already aborted the
        // in-flight model call -- the running balance hit zero, an
        // Entry-plan usage window filled, or this turn alone crossed
        // MAX_TURN_SPEND_CENTS. Either way, stop the outer step loop
        // too instead of starting another step.
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

    if (windowExhausted) {
      // Distinct from creditExhausted: an Entry-plan usage window
      // filled mid-turn. The account may still have balance, so
      // telling the user to top up would be wrong -- the client
      // explains that the window refills continuously instead.
      pendingAssistantResponse = {
        ...pendingAssistantResponse,
        metadata: {
          ...pendingAssistantResponse.metadata,
          windowExhausted: true,
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
    // This final persist ALSO clears activeStreamId in the same
    // transaction (upstream open-agents #845) — atomic, so a refresh can
    // never replay the response into the transcript a second time.
    await Promise.all([
      persistFinalAssistantMessage(
        options.chatId,
        pendingAssistantResponse,
        workflowRunId,
      ),
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
    const repoOwner = runtime?.repoOwner;
    const repoName = runtime?.repoName;
    let didUpdateGitData = false;

    let autoCommitResult: Awaited<ReturnType<typeof runAutoCommitStep>> | null =
      null;

    const canAutoCommit =
      finishedNaturally &&
      (options.autoCommitEnabled ?? modelRuntime.autoCommitEnabled) &&
      sandboxState != null &&
      repoOwner != null &&
      repoName != null;

    if (canAutoCommit && sandboxState) {
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
          sessionTitle: runtime?.sessionTitle ?? "",
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
      sandboxState &&
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
          sessionTitle: runtime?.sessionTitle ?? "",
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
  windowBudgetCents: number | null,
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
  let remainingWindowBudgetCents = windowBudgetCents;
  let creditExhausted = false;
  let windowExhausted = false;
  // Real-time subagent budget guard (framework SubagentBudgetGuard):
  // shares these same in-memory counters with the main model, so
  // subagent spend eats the same window/balance budgets mid-turn
  // instead of landing only at chat-post-finish. spendCents mirrors
  // the main-model finish-step mutation below (flags + turn abort);
  // it writes NO ledger rows -- the durable subagent debit still
  // happens at chat-post-finish, so there is no double-billing.
  const subagentBudgetGuard = buildSubagentBudgetGuard({
    getWindowRemainingCents: () => remainingWindowBudgetCents,
    getBalanceRemainingCents: () => remainingBalanceCents,
    getEnforceCreditBlock: () => enforceCreditBlock,
    spendCents: (costCents) => {
      const state = applySpendToBudgets({
        remainingWindowBudgetCents,
        remainingBalanceCents,
        enforceCreditBlock,
        costCents,
      });
      remainingWindowBudgetCents = state.remainingWindowBudgetCents;
      remainingBalanceCents = state.remainingBalanceCents;
      if (state.exhaustedReason === "window") {
        windowExhausted = true;
      }
      if (state.exhaustedReason === "credit") {
        creditExhausted = true;
      }
      if (state.exhaustedReason) {
        // Stop the parent turn too: no further main-model steps are
        // affordable either. (The task tool aborts the subagent with
        // its LOCAL controller first, so its partial summary still
        // flows back through the tool result before this propagates.)
        abortController.abort();
      }
      return state;
    },
    getCost: (subagentModelId) =>
      modelCostCatalog.find((m) => m.id === subagentModelId)?.cost,
  });
  // Tripped when this turn's cumulative cost (totalMessageCost, which
  // persists across outer-loop step calls via message metadata -- see
  // the assignment below) crosses MAX_TURN_SPEND_CENTS, regardless of
  // how much account balance remains.
  let turnSpendCapped = false;
  // Per-turn sub-cent accrual state, threaded through every step so
  // fractional cost is never dropped between the ledger's integer
  // cents. Declared outside the try below because the finish-step
  // handler (and the flush in `finally`) both live past that scope.
  const usageAccrual: UsageAccrualState = { carryCents: 0 };
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

    // REAL-TIME SPEND CAPPING (owner 2026-09-15: "make the usage for
    // the entry plan real time so it doesn't miscalculate -- user can
    // drain more than their usage"). The finish-step handler below only
    // reacts AFTER a step finishes; a step starting just under the limit
    // could overshoot it by its full cost. Here, BEFORE the model call:
    //  1. if even the estimated INPUT doesn't fit the remaining
    //     window/balance budget, abort this step without spending
    //     (the AbortError path below returns the same exhausted flags
    //     the reactive path sets, so the outer loop + client notice
    //     stay identical);
    //  2. otherwise clamp the model's maxOutputTokens so the worst-case
    //     OUTPUT fits what's left. Residual overshoot shrinks from one
    //     whole step to input-estimate error (cents).
    const lastStepBreakdown = existingStepBreakdown.at(-1);
    const estimatedInputTokens = estimateNextStepInputTokens(
      lastStepBreakdown?.usage,
      // LAZY (perf): the stringify only runs on the FIRST step of a
      // turn (no measured baseline); every later step is O(1) off the
      // last step's real token count.
      () => JSON.stringify(messages).length,
    );
    const spendCap = computeRealtimeSpendCap({
      remainingWindowBudgetCents,
      remainingBalanceCents,
      enforceCreditBlock,
      estimatedInputTokens,
      lastStepUsage: lastStepBreakdown?.usage,
      cost: modelCostCatalog.find((m) => m.id === modelId)?.cost,
    });
    if (spendCap.blockReason === "window") {
      windowExhausted = true;
      abortController.abort();
      throw new DOMException(
        "Entry usage window exhausted before step start",
        "AbortError",
      );
    }
    if (spendCap.blockReason === "credit") {
      creditExhausted = true;
      abortController.abort();
      throw new DOMException(
        "Credit balance exhausted before step start",
        "AbortError",
      );
    }

    // Rebuild the real `commitAndPush` closure here, inside the step --
    // it was intentionally left out of `agentOptions` (see
    // WorkflowAgentOptions) because functions cannot cross the
    // workflow-to-step serialization boundary. This runs with full
    // Node/DB access since we're already inside a step.
    const githubContext = agentOptions.github;
    const vercelContext = agentOptions.vercel;
    const fullAgentOptions: OpenAgentCallOptions = {
      ...agentOptions,
      billingGuard: subagentBudgetGuard,
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
              const sandbox = requireSandboxContext(agentOptions);
              return performAgentCommitAndPush({
                sandboxState: sandbox.state,
                userId,
                sessionId,
                sessionTitle,
                repoOwner: githubContext.repoOwner,
                repoName: githubContext.repoName,
                ...(commitMessage ? { commitMessage } : {}),
              });
            },
            request: async (input) => {
              // Absolute API paths need no repository at all -- that is
              // what makes github_api usable account-wide. Repo-relative
              // paths still expand against the connected repo, and fall
              // through to the tool's own error when there isn't one.
              if (
                !input.path.startsWith("/") &&
                (!githubContext.repoOwner || !githubContext.repoName)
              ) {
                return {
                  success: false,
                  error:
                    "No repository is connected to this session, and this path is repo-relative. Use an absolute path (e.g. '/user', '/repos/{owner}/{repo}/pulls') to act on the user's GitHub account directly.",
                };
              }
              return performAgentGithubApiRequest({
                userId,
                ...(githubContext.repoOwner && githubContext.repoName
                  ? {
                      repoOwner: githubContext.repoOwner,
                      repoName: githubContext.repoName,
                    }
                  : {}),
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
              const sandbox = requireSandboxContext(agentOptions);
              return performAgentGithubCli({
                userId,
                sandboxState: sandbox.state,
                workingDirectory: sandbox.workingDirectory,
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
              const sandbox = requireSandboxContext(agentOptions);
              return performAgentVercelCli({
                userId,
                sandboxState: sandbox.state,
                workingDirectory: sandbox.workingDirectory,
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
        beforeCommand: async () => {
          const { getSessionById } = await import("@/lib/db/sessions");
          const { hasResumableSandboxState } =
            await import("@/lib/sandbox/utils");
          const deadline = Date.now() + 180_000;
          let waitedForMigration = false;
          let migrationRunId: string | undefined;

          while (true) {
            const current = await getSessionById(sessionId);
            if (!current) {
              throw new Error(
                "Session disappeared while preparing a sandbox operation",
              );
            }
            if (
              current.status === "archived" ||
              current.lifecycleState === "archived"
            ) {
              throw new Error("Session is archived");
            }

            if (current.lifecycleState !== "migrating") {
              // No (usable) workspace yet is a normal agent-first state,
              // not an error -- but it still has to fail this tool call
              // with a readable message. Two reasons, both fatal if
              // ignored:
              //  1. a TypeError on `.state` instead of a sentence;
              //  2. connectSandbox() on a state with no sandboxName would
              //     CREATE a brand-new, untracked sandbox rather than
              //     waiting for this session's provisioning run.
              // hasResumableSandboxState is the exact predicate for
              // "connecting will resume an existing workspace, not make
              // one" (see lib/sandbox/utils.ts).
              const gateState =
                current.sandboxState ?? agentOptions.sandbox?.state;
              if (!gateState || !hasResumableSandboxState(gateState)) {
                throw new Error(
                  "The workspace for this session is still starting up -- provisioning runs in the background. " +
                    "Retry this tool once it is ready.",
                );
              }
              return {
                sandboxState: gateState,
                ...(waitedForMigration ? { waitedForMigration: true } : {}),
                ...(migrationRunId ? { migrationRunId } : {}),
              };
            }

            waitedForMigration = true;
            migrationRunId = current.lifecycleRunId ?? migrationRunId;

            if (Date.now() >= deadline) {
              throw new Error(
                "Sandbox migration is still running; command execution was held to avoid targeting the retiring sandbox.",
              );
            }

            await new Promise((resolve) => setTimeout(resolve, 750));
          }
        },
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
          return current?.sandboxState ?? agentOptions.sandbox?.state ?? null;
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
      const { getComposioMcpServerConfig } = await import("@/lib/mcp/composio");
      const rawEnabledServers = await getEnabledMcpServersForRequest(userId);
      // SECURITY FIX (2026-08-27, pentest finding): resolveAndAssertPublic
      // used to run only at MCP-server save-time (lib/db/mcp-servers.ts),
      // never again before the real connection here -- a classic
      // DNS-rebinding SSRF gap (attacker's domain resolves public at
      // save-time, then to a private/internal address by the time a chat
      // turn actually connects). Re-check every self-serve server's URL
      // fresh, right before connecting, and silently drop any that now
      // resolve privately -- same "log and skip, don't fail the turn"
      // philosophy as a server that's simply unreachable.
      const { resolveAndAssertPublic } = await import("@/lib/mcp/url-safety");
      const enabledServers = (
        await Promise.all(
          rawEnabledServers.map(async (server) => {
            try {
              await resolveAndAssertPublic(server.url);
              return server;
            } catch (error) {
              console.warn(
                `[workflow] Dropping MCP server "${server.name}" for user ${userId}: URL failed pre-connect SSRF re-check:`,
                error,
              );
              return null;
            }
          }),
        )
      ).filter(
        (server): server is (typeof rawEnabledServers)[number] =>
          server !== null,
      );
      // Composio (see lib/mcp/composio.ts) is a built-in MCP server,
      // resolved the same way as a self-serve one and merged into the
      // same combined server list -- createMcpToolSet() doesn't care
      // which source a server config came from. Never throws: absent
      // COMPOSIO_API_KEY or any SDK failure resolves to null.
      const composioServer = await getComposioMcpServerConfig(userId);
      const combinedServers = composioServer
        ? [...enabledServers, composioServer]
        : enabledServers;
      if (combinedServers.length > 0) {
        mcpToolSet = await createMcpToolSet(combinedServers);
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

    // COMPACT TELEMETRY SCOPE (moved inside this "use step" function
    // 2026-09-17): every auto-compaction firing inside this step (main
    // model or a subagent it launches) reports through this sink into
    // the compaction_events analytics table. This wrapping used to live
    // in the workflow function body around the runAgentStep call, but
    // the Workflow SDK's restricted "use workflow" bundle rejects the
    // module graphs the sink's imports pull in from workflow scope
    // (node:async_hooks from the agent package, postgres/nanoid from
    // lib/db/compaction -- and transitively the whole agent package).
    // Dynamic imports + wrapping the stream consumption here keeps
    // every emitCompactionEvent firing inside the sink while staying
    // step-scoped. Scoped per STEP, not per turn, so a workflow
    // suspend/resume between steps can never lose the AsyncLocalStorage
    // context. Fire-and-forget inside the sink -- telemetry can never
    // break the model step (see compaction-telemetry.ts).
    const { runWithCompactionSink } = await import("@open-agents/agent");
    const { recordCompactionEvent } = await import("@/lib/db/compaction");

    const result = await runWithCompactionSink(
      (event) =>
        recordCompactionEvent(event, {
          userId,
          chatId,
          sessionId,
        }),
      async () => {
        const stream = await webAgent.stream({
          messages,
          options: spendCap.maxOutputTokens
            ? { ...fullAgentOptions, maxOutputTokens: spendCap.maxOutputTokens }
            : fullAgentOptions,
          abortSignal: abortController.signal,
        });

        for await (const part of stream.toUIMessageStream<WebAgentUIMessage>({
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

                // Sub-cent accrual: the ledger only holds whole cents,
                // but a step's real cost usually isn't one -- rounding
                // here is what made every sub-cent step (cheap model,
                // short answer) bill literally nothing. The accumulator
                // carries the remainder forward so the whole cent only
                // reaches the ledger once it has truly accrued.
                const stepCostCents = settleStepCost(usageAccrual, stepCost);
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

                  // Entry-plan rolling usage windows: a SEPARATE in-memory
                  // counter, decremented for windowed users regardless of
                  // admin (owner request 2026-09-15) -- admins are exempt
                  // from the balance block above but NOT from windows.
                  // Aborting here marks windowExhausted so the client says
                  // "window refills continuously", never "top up".
                  if (remainingWindowBudgetCents !== null && !windowExhausted) {
                    remainingWindowBudgetCents -= stepCostCents;
                    if (remainingWindowBudgetCents <= 0) {
                      windowExhausted = true;
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
        return stream;
      },
    );

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
      remainingWindowBudgetCents,
      creditExhausted,
      windowExhausted,
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
        remainingWindowBudgetCents,
        creditExhausted,
        windowExhausted,
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
