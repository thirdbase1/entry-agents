import {
  defaultSettingsMiddleware,
  wrapLanguageModel,
  type JSONValue,
  type LanguageModel,
} from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import type { AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";

/**
 * Shared AI provider (owner decision, 2026-08-10): all model calls in this
 * app go through Entry's own self-hosted gateway (OpenAI-compatible,
 * source in the separate `entry-gateway` service, deployed on Pxxl) --
 * NOT Vercel's AI Gateway, and not a direct call to any upstream model
 * provider. The gateway owns upstream routing (Opencode Zen today, more
 * later) behind a single API key, so adding/removing models is a config
 * change on the gateway only -- this app never needs a code change or
 * redeploy to pick up a new model.
 *
 * Env vars (set in Vercel, values come from the entry-gateway deployment):
 *   GATEWAY_BASE_URL - the entry-gateway's base URL, e.g. https://entry-gateway.pxxl.run/v1
 *   GATEWAY_API_KEY  - one of entry-gateway's GATEWAY_API_KEYS
 *
 * Model IDs are whatever entry-gateway routes (currently Opencode Zen's
 * flat catalog IDs, e.g. "grok-4.5", "kimi-k3"), not Vercel Gateway's old
 * "provider/model" namespaced IDs.
 */
export type SharedProviderModelId = string;
// Backward-compat alias -- some call sites still reference this name.
export type GatewayModelId = SharedProviderModelId;

function getSharedProviderConfig(): { baseURL: string; apiKey: string } {
  const baseURL = process.env.GATEWAY_BASE_URL;
  const apiKey = process.env.GATEWAY_API_KEY;

  if (!baseURL || !apiKey) {
    throw new Error(
      "GATEWAY_BASE_URL / GATEWAY_API_KEY must be set -- all model calls go through Entry's self-hosted gateway, not Vercel AI Gateway and not a direct provider call.",
    );
  }

  return { baseURL, apiKey };
}

/**
 * True for Claude models routed through the gateway's Anthropic Messages
 * passthrough (claude-*, currently all served by the FreeModel provider
 * at cc.freemodel.dev as of 2026-08-16, after the old "woino" reseller
 * route -- claude-sonnet-4.5/claude-haiku-4.5 -- was removed). These need
 * the real @ai-sdk/anthropic client (native Anthropic Messages protocol)
 * instead of the shared OpenAI-compatible client -- see the comment in
 * sharedProvider() for why. Exported so apps/web's model-reasoning.ts can
 * branch reasoning-effort provider options the same way (that file
 * duplicates this function locally instead of importing it, for
 * client-bundle reasons -- see its own copy's comment).
 */
export function isClaudeModelId(modelId: string): boolean {
  return modelId.includes("claude");
}

/**
 * True for Google models routed through the gateway's "google" provider
 * (gemini-3.1-flash-lite, gemini-3.5-flash-lite, gemini-3.5-flash,
 * gemma-4-26b, gemma-4-31b, gemini-3.7-flash, and any future "gemini-" or "gemma-" additions).
 * These need the real @ai-sdk/google client (native Gemini generateContent
 * protocol, POST {root}/v1beta/models/{id}:generateContent) instead of the
 * shared OpenAI-compatible client -- Google's own OpenAI-compat shim wraps
 * thinking text in literal `<thought>...</thought>` tags inside the plain
 * content string instead of a separate reasoning field (confirmed via a
 * live probe against the real Gemini OpenAI-compat endpoint, 2026-08-13),
 * so routing it through @ai-sdk/openai-compatible would leak raw thinking
 * markup straight into the visible chat text -- same class of bug as the
 * Claude/cache_control issue above, different provider.
 */
export function isGeminiModelId(modelId: string): boolean {
  return modelId.startsWith("gemini-") || modelId.startsWith("gemma-");
}

// Default legacy-thinking budget applied when no reasoning-effort override
// is present (see toReasoningProviderOptions in apps/web/lib/model-reasoning.ts
// for the low/2000, medium/8000, high/16000 effort-level budgets that
// override this per-request).
const DEFAULT_ANTHROPIC_THINKING_BUDGET = 8000;

// Every Claude model routed through FreeModel's cc.freemodel.dev
// passthrough uses Anthropic's legacy budget-based extended thinking
// (thinking: {type: "enabled", budget_tokens}), NOT the newer adaptive/
// effort-based thinking type -- confirmed via live probe 2026-08-16:
// sending thinking:{type:"adaptive"} + effort:"low"/"high" against
// claude-opus-5 came back with output_tokens_details.thinking_tokens: 0
// both times (silently a no-op through this route), while
// thinking:{type:"enabled",budget_tokens:N} produced a real "thinking"
// content block that scales with N (319 tokens at budget 2000, 409 at
// budget 16000, both on the same prompt). Also confirmed haiku-4-5
// supports legacy thinking fine (471 thinking tokens), so there's no
// per-model carve-out needed -- this applies uniformly to every claude-*
// id. If a future Claude route genuinely supports adaptive thinking,
// gate it back in per-provider (not per modelId string), since this was
// a route capability gap, not a real Claude-version capability gap.
function getAnthropicSettings(
  modelId: string,
  budgetTokens: number = DEFAULT_ANTHROPIC_THINKING_BUDGET,
): AnthropicLanguageModelOptions {
  return {
    thinking: { type: "enabled", budgetTokens },
  };
}

function isJsonObject(value: unknown): value is Record<string, JSONValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toProviderOptionsRecord(
  options: Record<string, unknown>,
): Record<string, JSONValue> {
  return options as Record<string, JSONValue>;
}

function mergeRecords(
  base: Record<string, JSONValue>,
  override: Record<string, JSONValue>,
): Record<string, JSONValue> {
  const merged: Record<string, JSONValue> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const existingValue = merged[key];

    if (isJsonObject(existingValue) && isJsonObject(value)) {
      merged[key] = mergeRecords(existingValue, value);
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

export type ProviderOptionsByProvider = Record<
  string,
  Record<string, JSONValue>
>;

export function mergeProviderOptions(
  defaults: ProviderOptionsByProvider,
  overrides?: ProviderOptionsByProvider,
): ProviderOptionsByProvider {
  if (!overrides || Object.keys(overrides).length === 0) {
    return defaults;
  }

  const merged: ProviderOptionsByProvider = { ...defaults };

  for (const [provider, providerOverrides] of Object.entries(overrides)) {
    const providerDefaults = merged[provider];

    if (!providerDefaults) {
      merged[provider] = providerOverrides;
      continue;
    }

    merged[provider] = mergeRecords(providerDefaults, providerOverrides);
  }

  return merged;
}

export interface GatewayConfig {
  baseURL: string;
  apiKey: string;
}

export interface GatewayOptions {
  config?: GatewayConfig;
  providerOptionsOverrides?: ProviderOptionsByProvider;
  appName?: string;
  appUrl?: string;
}

export type { LanguageModel, JSONValue };

export function shouldApplyOpenAIReasoningDefaults(modelId: string): boolean {
  return modelId.startsWith("openai/gpt-5");
}

function shouldApplyOpenAITextVerbosityDefaults(modelId: string): boolean {
  return modelId.startsWith("openai/gpt-5.4");
}

export function getProviderOptionsForModel(
  modelId: string,
  providerOptionsOverrides?: ProviderOptionsByProvider,
): ProviderOptionsByProvider {
  const defaultProviderOptions: ProviderOptionsByProvider = {};

  // Apply anthropic defaults. Uses isClaudeModelId (flat catalog ID match,
  // e.g. "claude-sonnet-4.5"), not a "anthropic/" prefix check -- that
  // prefix belonged to the old Vercel AI Gateway namespaced-ID scheme and
  // stopped matching anything after the 2026-08-10 migration to
  // entry-gateway's flat catalog IDs, silently disabling extended-thinking
  // settings for every Claude model since (found alongside the woino
  // caching bug, 2026-08-13).
  if (isClaudeModelId(modelId)) {
    defaultProviderOptions.anthropic = toProviderOptionsRecord(
      getAnthropicSettings(modelId),
    );
  }

  // Gemini/Gemma models: enable thinking by default (Google's models think
  // by default when the flag is supported, but the free-tier Gemma models
  // don't support thinking at all -- gating this to "gemini-" only, not
  // "gemma-", avoids sending an unsupported field the API would reject).
  // includeThoughts surfaces thought summaries through the same
  // reasoning-start/delta/end stream parts the UI's ThinkingBlock already
  // renders for every other reasoning model. sanitizeReasoningEffort's
  // explicit low/medium/high UI selection (mapped in model-reasoning.ts to
  // providerOptions.google.thinkingConfig.thinkingLevel) overrides this
  // "medium" default via providerOptionsOverrides below.
  if (modelId.startsWith("gemini-")) {
    defaultProviderOptions.google = toProviderOptionsRecord({
      thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" },
    } satisfies GoogleGenerativeAIProviderOptions);
  }

  // OpenAI model responses should never be persisted.
  if (modelId.startsWith("openai/")) {
    defaultProviderOptions.openai = toProviderOptionsRecord({
      store: false,
    } satisfies OpenAIResponsesProviderOptions);
  }

  // Apply OpenAI defaults for all GPT-5 variants to expose encrypted reasoning content.
  // This avoids Responses API failures when `store: false`, e.g.:
  // "Item with id 'rs_...' not found. Items are not persisted when `store` is set to false."
  if (shouldApplyOpenAIReasoningDefaults(modelId)) {
    defaultProviderOptions.openai = mergeRecords(
      defaultProviderOptions.openai ?? {},
      toProviderOptionsRecord({
        reasoningSummary: "detailed",
        include: ["reasoning.encrypted_content"],
      } satisfies OpenAIResponsesProviderOptions),
    );
  }

  if (shouldApplyOpenAITextVerbosityDefaults(modelId)) {
    defaultProviderOptions.openai = mergeRecords(
      defaultProviderOptions.openai ?? {},
      toProviderOptionsRecord({
        textVerbosity: "low",
      } satisfies OpenAIResponsesProviderOptions),
    );
  }

  const providerOptions = mergeProviderOptions(
    defaultProviderOptions,
    providerOptionsOverrides,
  );

  // Enforce OpenAI non-persistence even when custom provider overrides are present.
  if (modelId.startsWith("openai/")) {
    providerOptions.openai = mergeRecords(
      providerOptions.openai ?? {},
      toProviderOptionsRecord({
        store: false,
      } satisfies OpenAIResponsesProviderOptions),
    );
  }

  return providerOptions;
}

/**
 * Inert placeholder LanguageModel that never touches
 * GATEWAY_BASE_URL/GATEWAY_API_KEY or constructs a real network client.
 *
 * Used for module-scope placeholders like `defaultModel` in
 * open-agent.ts: those get immediately overridden per-request by
 * `prepareCall`, so they're never actually invoked -- but ToolLoopAgent's
 * constructor reads properties like `specificationVersion` off `model`
 * synchronously at construction time, so even a *lazy* Proxy that defers
 * sharedProvider() doesn't help (it just moves the env-var throw from
 * "module eval" to "agent construction", which still happens during
 * Next.js's build-time page-data collection, before any env var is
 * guaranteed to be set). A real, static, non-throwing stub sidesteps the
 * whole problem: it doesn't need env vars because it never makes a real
 * request. If it's ever *actually* invoked (it shouldn't be), it throws
 * a clear, specific error instead of a confusing network/env failure.
 */
export function createInertPlaceholderModel(
  modelId: SharedProviderModelId,
): LanguageModel {
  const notInvokable = () => {
    throw new Error(
      `Placeholder model "${modelId}" was invoked directly -- this should never happen. ` +
        "prepareCall() is expected to replace it with a real sharedProvider() model before any request is made.",
    );
  };

  return {
    specificationVersion: "v2",
    provider: "entry-placeholder",
    modelId,
    supportedUrls: {},
    doGenerate: notInvokable,
    doStream: notInvokable,
  } as unknown as LanguageModel;
}

export function sharedProvider(
  modelId: SharedProviderModelId,
  options: GatewayOptions = {},
): LanguageModel {
  const { config, providerOptionsOverrides, appName, appUrl } = options;

  const attributionHeaders = {
    "http-referer": appUrl ?? "https://open-agents.dev",
    "x-title": appName ?? "Entry Agent",
  };

  const { baseURL, apiKey } = config ?? getSharedProviderConfig();

  // Claude models (routed through the gateway's FreeModel provider as of
  // 2026-08-16, e.g. claude-opus-5/claude-sonnet-4-6/claude-haiku-4-5-...;
  // previously the "woino" provider's claude-sonnet-4.5/claude-haiku-4.5,
  // now removed) go over the gateway's native Anthropic Messages
  // passthrough (POST {GATEWAY_BASE_URL}/messages), NOT the shared
  // OpenAI-compatible chat endpoint. Found 2026-08-13: @ai-sdk/openai-compatible's
  // Chat Completions wire format has no field for Anthropic's
  // `cache_control` breakpoints at all -- routing Claude through it meant
  // addCacheControl()'s providerOptions.anthropic.cacheControl was
  // silently dropped on every single request, so prompt caching for every
  // Claude model never worked, regardless of what cache-control.ts did.
  // Using the real @ai-sdk/anthropic client against the gateway's native
  // /messages route lets those cache_control blocks actually reach the
  // wire and get forwarded byte-for-byte to the upstream (FreeModel ->
  // real Anthropic). authToken
  // (not apiKey) is used so the SDK sends `Authorization: Bearer <key>`,
  // matching the gateway's own bearer-token auth middleware, instead of the
  // `x-api-key` header Anthropic's own API expects (the gateway ignores
  // x-api-key -- it rebuilds upstream headers itself from route config).
  let model: LanguageModel;
  if (isClaudeModelId(modelId)) {
    const anthropicProvider = createAnthropic({
      name: "anthropic",
      baseURL,
      authToken: apiKey,
      headers: attributionHeaders,
    });
    model = anthropicProvider(modelId);
  } else if (isGeminiModelId(modelId)) {
    // Google models go over the gateway's native Gemini passthrough
    // (POST {root}/v1beta/models/{id}:generateContent, or
    // :streamGenerateContent?alt=sse while streaming), same rationale as
    // the Claude branch above: the shared OpenAI-compatible endpoint can't
    // carry Gemini's thinking output cleanly (see isGeminiModelId's
    // comment). GATEWAY_BASE_URL is the gateway's *OpenAI-compat* root
    // (".../v1"), but @ai-sdk/google always appends
    // "/models/{id}:generateContent" directly to whatever baseURL it's
    // given -- so the "/v1" suffix has to be swapped for "/v1beta" to land
    // on the gateway's actual Gemini route, not "/v1/models/...".
    // `Authorization: Bearer <key>` (added via `headers`, not `apiKey`) is
    // what the gateway's own bearer-auth middleware checks; the SDK's
    // default `x-goog-api-key` header is sent alongside but ignored by the
    // gateway, which rebuilds the real `x-goog-api-key` to Google itself
    // from its own route config (WOINO_API_KEY-style env var, here
    // GOOGLE_API_KEY) -- same pattern as the gateway ignoring Claude's
    // `x-api-key` header in the branch above.
    const geminiBaseURL = `${baseURL.replace(/\/v1$/, "")}/v1beta`;
    const googleProvider = createGoogleGenerativeAI({
      baseURL: geminiBaseURL,
      apiKey,
      headers: { ...attributionHeaders, Authorization: `Bearer ${apiKey}` },
    });
    model = googleProvider(modelId);
  } else {
    // Use @ai-sdk/openai-compatible, NOT @ai-sdk/openai, even though this is
    // a standard OpenAI Chat Completions-shaped API. Reason (found 2026-08-11):
    // Opencode Zen's reasoning models (deepseek-v4-pro, glm-5.2) return their
    // thinking text in a non-standard `reasoning_content` field on
    // choices[].delta / choices[].message -- a DeepSeek-style convention, not
    // part of real OpenAI's API. @ai-sdk/openai's chat-completions parser has
    // no code path for that field at all (it only knows OpenAI's own Responses
    // API reasoning shape), so it silently dropped every reasoning token before
    // it ever reached the UI -- the whole ThinkingBlock/"Pondering..." UI was
    // built and wired correctly, but had nothing to render.
    // @ai-sdk/openai-compatible's chat model *does* parse `reasoning_content`
    // (both delta.reasoning_content while streaming and message.reasoning_content
    // for non-streaming) into proper reasoning-start/delta/end parts.
    // `name: "openai"` keeps the providerOptions namespace as `openai` so every
    // existing `providerOptions.openai.*` call site (reasoningEffort, GPT-5
    // defaults, etc.) keeps working unchanged.
    const openCodeZen = createOpenAICompatible({
      name: "openai",
      baseURL,
      apiKey,
      headers: attributionHeaders,
    });

    model = openCodeZen.chatModel(modelId);
  }

  const providerOptions = getProviderOptionsForModel(
    modelId,
    providerOptionsOverrides,
  );

  if (Object.keys(providerOptions).length > 0) {
    model = wrapLanguageModel({
      model,
      middleware: defaultSettingsMiddleware({
        settings: { providerOptions },
      }),
    });
  }

  return model;
}

// Backward-compat alias for the handful of call sites written before the
// Vercel AI Gateway -> Opencode Zen shared-provider swap.
export const gateway = sharedProvider;
