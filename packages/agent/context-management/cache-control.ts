import type {
  ModelMessage,
  JSONValue,
  LanguageModel,
  SystemModelMessage,
  ToolSet,
} from "ai";

type ProviderOptions = Record<string, Record<string, JSONValue>>;

function isAnthropicModel(model: LanguageModel): boolean {
  if (typeof model === "string") {
    return model.includes("anthropic") || model.includes("claude");
  }
  return (
    model.provider === "anthropic" ||
    model.provider.includes("anthropic") ||
    model.modelId.includes("anthropic") ||
    model.modelId.includes("claude")
  );
}

const DEFAULT_CACHE_CONTROL_OPTIONS: Record<
  string,
  Record<string, JSONValue>
> = {
  anthropic: { cacheControl: { type: "ephemeral" } },
};

/**
 * Adds provider-specific cache control options to tools for optimal caching.
 *
 * For Anthropic: marks all tools with `cacheControl: { type: "ephemeral" }`.
 * For non-Anthropic models, tools are returned unchanged.
 *
 * @example
 * ```ts
 * const result = await generateText({
 *   model: anthropic('claude-3-5-haiku-latest'),
 *   tools: addCacheControl({
 *     tools: {
 *       cityAttractions: tool({
 *         parameters: z.object({ city: z.string() }),
 *         execute: async ({ city }) => `Attractions in ${city}`,
 *       }),
 *     },
 *     model,
 *   }),
 *   messages: [...],
 * });
 * ```
 */
/**
 * Wraps the agent's system instructions in a cache breakpoint for Anthropic.
 *
 * FOUND 2026-08-18: the system prompt (CORE_SYSTEM_PROMPT + model overlay --
 * ~10.5K+ tokens, per auto-compact.ts's own measurement) was the single
 * largest, most stable, most-repeated block in every request -- identical
 * across every turn of every session, and even across DIFFERENT sessions
 * for the "no sandbox yet" default agent -- yet it was never marked with a
 * cache_control breakpoint at all. Only `tools` (last tool) and `messages`
 * (last message) were ever cached; `instructions` was always passed to the
 * SDK as a plain string, which Anthropic's Messages API has no way to
 * cache (cache_control can only be set on a message/content block via
 * providerOptions, never on a bare string). This meant every single Claude
 * request reprocessed the entire system prompt from scratch: full latency,
 * full input-token price, on every turn, forever -- confirmed via
 * ai-sdk.dev's own provider docs and multiple SDK issues describing this
 * exact gap (e.g. OpenRouterTeam/ai-sdk-provider#389, laravel/ai#119).
 *
 * The SDK's `instructions` field on ToolLoopAgent accepts
 * `string | SystemModelMessage | Array<SystemModelMessage>` (confirmed in
 * ai@6.0.194's type defs) -- SystemModelMessage supports the same
 * `providerOptions` shape as any other message, so wrapping the plain
 * string as `{ role: "system", content, providerOptions }` is enough to
 * get Anthropic to actually cache it, using the SAME 1 of Anthropic's 4
 * available breakpoints budget already spent on tools/messages (well
 * within the limit).
 *
 * Non-Anthropic models get the instructions back unchanged (OpenAI/Gemini/
 * DeepSeek cache automatically based on prefix identity -- no breakpoint
 * needed, and SystemModelMessage's providerOptions would just be inert
 * extra metadata for them, so there's no reason to wrap for those).
 */
export function addCacheControl(options: {
  instructions: string;
  model: LanguageModel;
  providerOptions?: ProviderOptions;
}): string | SystemModelMessage;

export function addCacheControl<T extends ToolSet>(options: {
  tools: T;
  model: LanguageModel;
  providerOptions?: ProviderOptions;
}): T;

/**
 * Adds provider-specific cache control options to messages for optimal caching.
 *
 * For Anthropic: marks the last message with `cacheControl: { type: "ephemeral" }`
 * per their docs - "Mark the final block of the final message with cache_control
 * so the conversation can be incrementally cached."
 *
 * For non-Anthropic models, messages are returned unchanged.
 *
 * @example
 * ```ts
 * prepareStep: ({ messages, model, ...rest }) => ({
 *   ...rest,
 *   messages: addCacheControl({ messages, model }),
 * }),
 * ```
 */
export function addCacheControl(options: {
  messages: ModelMessage[];
  model: LanguageModel;
  providerOptions?: ProviderOptions;
}): ModelMessage[];

export function addCacheControl<T extends ToolSet>({
  tools,
  messages,
  instructions,
  model,
  providerOptions = DEFAULT_CACHE_CONTROL_OPTIONS,
}: {
  tools?: T;
  messages?: ModelMessage[];
  instructions?: string;
  model: LanguageModel;
  providerOptions?: ProviderOptions;
}): T | ModelMessage[] | string | SystemModelMessage {
  if (!isAnthropicModel(model)) {
    return (tools ?? messages ?? instructions)!;
  }

  if (instructions !== undefined) {
    if (!instructions) return instructions;
    return {
      role: "system",
      content: instructions,
      providerOptions,
    };
  }

  if (tools !== undefined) {
    const entries = Object.entries(tools);
    if (entries.length === 0) return tools;

    // Anthropic supports max 4 cache breakpoints - only mark the last tool
    // to avoid exceeding the limit when combined with message caching
    const lastIndex = entries.length - 1;
    return Object.fromEntries(
      entries.map(([name, tool], index) => [
        name,
        index === lastIndex
          ? {
              ...tool,
              providerOptions: {
                ...tool.providerOptions,
                ...providerOptions,
              },
            }
          : tool,
      ]),
    ) as T;
  }

  if (messages !== undefined) {
    if (messages.length === 0) return messages;
    return messages.map((message, index) =>
      index === messages.length - 1
        ? {
            ...message,
            providerOptions: {
              ...message.providerOptions,
              ...providerOptions,
            },
          }
        : message,
    );
  }

  throw new Error("Either tools, messages, or instructions must be provided");
}
