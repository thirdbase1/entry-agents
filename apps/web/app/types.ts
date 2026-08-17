import type {
  DynamicToolUIPart,
  FinishReason,
  InferUITools,
  LanguageModelUsage,
  ToolUIPart,
  UIMessage,
} from "ai";
import type { webAgent } from "./config";

export type WebAgent = typeof webAgent;
export type WebAgentCallOptions = Parameters<
  WebAgent["generate"]
>["0"]["options"];

export type WebAgentStepFinishMetadata = {
  finishReason: FinishReason;
  rawFinishReason?: string;
};

export type WebAgentStepCostBreakdown = {
  /** 1-indexed step number within this assistant turn. */
  stepNumber: number;
  /** The model that actually produced this step (may differ from the requested modelId on fallback). */
  modelId?: string;
  finishReason: FinishReason;
  rawFinishReason?: string;
  usage?: LanguageModelUsage;
  /** Gateway/catalog-estimated cost of this single step, in USD. */
  cost?: number;
  /** Names of tools invoked during this step, if any (e.g. ["bash", "write"]). */
  toolCallNames?: string[];
};

export type WebAgentMessageMetadata = {
  selectedModelId?: string;
  modelId?: string;
  lastStepUsage?: LanguageModelUsage;
  totalMessageUsage?: LanguageModelUsage;
  /** Gateway-reported cost of the most recent step, in USD. */
  lastStepCost?: number;
  /** Cumulative gateway-reported cost across every step of the message, in USD. */
  totalMessageCost?: number;
  lastStepFinishReason?: FinishReason;
  lastStepRawFinishReason?: string;
  stepFinishReasons?: WebAgentStepFinishMetadata[];
  /** Full per-step cost/usage breakdown for the "what made up this cost" dropdown. */
  stepBreakdown?: WebAgentStepCostBreakdown[];
  /**
   * True when the upstream model provider reported its own quota/capacity
   * as exhausted (e.g. a monthly token cap on the provider's side) but
   * returned it as ordinary 200 response content instead of an HTTP error.
   * See detectProviderQuotaExhaustion in workflows/chat.ts -- without this
   * flag that provider-side message would otherwise render verbatim as if
   * it were a real assistant answer.
   */
  providerQuotaExhausted?: boolean;
  /**
   * True when this turn was cut short mid-generation because the user's
   * credit balance hit zero (real-time per-step billing in
   * runAgentStep). Distinct from providerQuotaExhausted -- this is the
   * user's own account balance, not the upstream provider's. Drives the
   * "you're out of credit" notice in session-chat-content.tsx.
   */
  creditExhausted?: boolean;
  /**
   * True when this single turn's own cumulative cost crossed the
   * MAX_TURN_SPEND_CENTS circuit-breaker in app/workflows/chat.ts,
   * independent of the account's remaining balance (protects against a
   * runaway multi-tool-call loop burning most/all of a plan's credit in
   * one turn). Drives the "this response got expensive, stopped early"
   * notice in session-chat-content.tsx.
   */
  turnSpendCapped?: boolean;
};

export type WebAgentGitDataStatus = "pending" | "success" | "error" | "skipped";

export type WebAgentCommitData = {
  status: WebAgentGitDataStatus;
  committed?: boolean;
  pushed?: boolean;
  commitMessage?: string;
  commitSha?: string;
  url?: string;
  error?: string;
};

export type WebAgentPrData = {
  status: WebAgentGitDataStatus;
  created?: boolean;
  syncedExisting?: boolean;
  prNumber?: number;
  url?: string;
  error?: string;
  skipReason?: string;
  requiresManualCreation?: boolean;
};

export type WebAgentSnippetData = {
  content: string;
  filename: string;
};

export type WebAgentWorkspaceStatusData = {
  status: "setting-up";
  message: string;
};

export type WebAgentDataParts = {
  commit: WebAgentCommitData;
  pr: WebAgentPrData;
  snippet: WebAgentSnippetData;
  "workspace-status": WebAgentWorkspaceStatusData;
};

// All types derived from the agent
export type WebAgentTools = WebAgent["tools"];
export type WebAgentUITools = InferUITools<WebAgentTools>;
export type WebAgentUIMessage = UIMessage<
  WebAgentMessageMetadata,
  WebAgentDataParts,
  WebAgentUITools
>;
export type WebAgentUIMessagePart = WebAgentUIMessage["parts"][number];
export type WebAgentCommitDataPart = Extract<
  WebAgentUIMessagePart,
  { type: "data-commit" }
>;
export type WebAgentPrDataPart = Extract<
  WebAgentUIMessagePart,
  { type: "data-pr" }
>;
export type WebAgentSnippetDataPart = Extract<
  WebAgentUIMessagePart,
  { type: "data-snippet" }
>;
export type WebAgentUIToolPart =
  | DynamicToolUIPart
  | ToolUIPart<WebAgentUITools>;
