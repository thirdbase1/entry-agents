import {
  defaultSettingsMiddleware,
  wrapLanguageModel,
  type JSONValue,
  type LanguageModel,
} from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
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

function supportsAdaptiveAnthropicThinking(modelId: string): boolean {
  return modelId.includes("4.6") || modelId.includes("4.7");
}

// Models with adaptive thinking support use effort control.
// Older models use the legacy extended thinking API with a budget.
function getAnthropicSettings(modelId: string): AnthropicLanguageModelOptions {
  if (supportsAdaptiveAnthropicThinking(modelId)) {
    return {
      effort: "medium",
      thinking: { type: "adaptive" },
    } satisfies AnthropicLanguageModelOptions;
  }

  return {
    thinking: { type: "enabled", budgetTokens: 8000 },
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

  // Apply anthropic defaults
  if (modelId.startsWith("anthropic/")) {
    defaultProviderOptions.anthropic = toProviderOptionsRecord(
      getAnthropicSettings(modelId),
    );
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
 * entry-agent.ts: those get immediately overridden per-request by
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
    "http-referer": appUrl ?? "https://entry.dev",
    "x-title": appName ?? "Entry",
  };

  const { baseURL, apiKey } = config ?? getSharedProviderConfig();

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

  let model: LanguageModel = openCodeZen.chatModel(modelId);

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
