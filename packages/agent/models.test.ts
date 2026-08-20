import { describe, expect, mock, test } from "bun:test";
import type { ProviderOptionsByProvider } from "./models";

const createGatewayCalls: Array<Record<string, unknown>> = [];
// Real per-provider client factories the shared provider actually calls
// (see sharedProvider()'s isClaudeModelId/isGeminiModelId branches in
// models.ts) -- "createGateway" above is a relic of the old Vercel AI
// Gateway SDK and isn't called anywhere in the current implementation,
// so the attribution-header tests below exercise these instead.
const createOpenAICompatibleCalls: Array<Record<string, unknown>> = [];

mock.module("ai", () => {
  const gateway = (modelId: string) => ({ modelId });

  return {
    createGateway: (settings?: Record<string, unknown>) => {
      createGatewayCalls.push(settings ?? {});
      return gateway;
    },
    defaultSettingsMiddleware: (_settings: unknown) => ({
      kind: "default-settings-middleware",
    }),
    gateway,
    wrapLanguageModel: ({ model }: { model: unknown }) => model,
  };
});

mock.module("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: (settings?: Record<string, unknown>) => {
    createOpenAICompatibleCalls.push(settings ?? {});
    return { chatModel: (modelId: string) => ({ modelId }) };
  },
}));

mock.module("@ai-sdk/devtools", () => ({
  devToolsMiddleware: () => ({ kind: "devtools-middleware" }),
}));

const {
  gateway,
  getProviderOptionsForModel,
  mergeProviderOptions,
  shouldApplyOpenAIReasoningDefaults,
} = await import("./models");

describe("shouldApplyOpenAIReasoningDefaults", () => {
  test("returns true for existing GPT-5 variants", () => {
    expect(shouldApplyOpenAIReasoningDefaults("openai/gpt-5.3")).toBe(true);
    expect(shouldApplyOpenAIReasoningDefaults("openai/gpt-5.4")).toBe(true);
  });

  test("returns true for future GPT-5 variants", () => {
    expect(shouldApplyOpenAIReasoningDefaults("openai/gpt-5.9")).toBe(true);
  });

  test("returns false for non-GPT-5 OpenAI models", () => {
    expect(shouldApplyOpenAIReasoningDefaults("openai/gpt-4o")).toBe(false);
  });
});

describe("getProviderOptionsForModel", () => {
  // Renamed + updated 2026-08-20: these described a future adaptive/
  // effort-based thinking mode this file was written in anticipation
  // of. getAnthropicSettings() in models.ts documents a live probe
  // (2026-08-16) that found the gateway's Claude passthrough silently
  // no-ops thinking:{type:"adaptive"} (0 thinking tokens either way),
  // so it was deliberately reverted to legacy budget-based thinking for
  // every claude-* id, not just older ones -- there's no per-version
  // carve-out in the real code, so 4.6/4.7 behave identically to 4.5.
  test("applies legacy budget-based thinking defaults to Anthropic 4.6 models", () => {
    const result = getProviderOptionsForModel("anthropic/claude-sonnet-4.6");

    expect(result).toEqual({
      anthropic: {
        thinking: { type: "enabled", budgetTokens: 8000 },
      },
    });
  });

  test("applies legacy budget-based thinking defaults to Anthropic 4.7 models", () => {
    const result = getProviderOptionsForModel("anthropic/claude-opus-4.7");

    expect(result).toEqual({
      anthropic: {
        thinking: { type: "enabled", budgetTokens: 8000 },
      },
    });
  });

  test("preserves legacy thinking defaults for older Anthropic models", () => {
    const result = getProviderOptionsForModel("anthropic/claude-opus-4.5");

    expect(result).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 8000,
        },
      },
    });
  });

  test("merges OpenAI defaults with custom variant options", () => {
    const result = getProviderOptionsForModel("openai/gpt-5", {
      openai: {
        reasoningEffort: "medium",
      },
    });

    expect(result).toEqual({
      openai: {
        reasoningSummary: "detailed",
        include: ["reasoning.encrypted_content"],
        reasoningEffort: "medium",
        store: false,
      },
    });
  });

  test("applies low text verbosity defaults to GPT-5.4 snapshots", () => {
    const result = getProviderOptionsForModel("openai/gpt-5.4-2026-03-05");

    expect(result).toEqual({
      openai: {
        reasoningSummary: "detailed",
        include: ["reasoning.encrypted_content"],
        store: false,
        textVerbosity: "low",
      },
    });
  });

  test("preserves store false and encrypted reasoning content for the built-in GPT-5.4 variant", () => {
    const result = getProviderOptionsForModel("openai/gpt-5.4", {
      openai: {
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
      },
    });

    expect(result).toEqual({
      openai: {
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
        store: false,
        textVerbosity: "low",
      },
    });
  });

  test("enforces store false for OpenAI models even when variant overrides it", () => {
    const result = getProviderOptionsForModel("openai/gpt-5", {
      openai: {
        store: true,
      },
    });

    expect(result).toEqual({
      openai: {
        reasoningSummary: "detailed",
        include: ["reasoning.encrypted_content"],
        store: false,
      },
    });
  });

  test("applies store false to non-GPT-5 OpenAI models", () => {
    const result = getProviderOptionsForModel("openai/gpt-4o");

    expect(result).toEqual({
      openai: {
        store: false,
      },
    });
  });
});

describe("mergeProviderOptions", () => {
  test("returns defaults when overrides are undefined", () => {
    const defaults: ProviderOptionsByProvider = {
      openai: {
        reasoningEffort: "high",
      },
    };

    expect(mergeProviderOptions(defaults)).toEqual(defaults);
  });

  test("deep merges nested provider options", () => {
    const defaults: ProviderOptionsByProvider = {
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 8000,
        },
      },
    };

    const overrides: ProviderOptionsByProvider = {
      anthropic: {
        thinking: {
          budgetTokens: 4000,
        },
      },
    };

    expect(mergeProviderOptions(defaults, overrides)).toEqual({
      anthropic: {
        thinking: {
          type: "enabled",
          budgetTokens: 4000,
        },
      },
    });
  });

  test("adds provider overrides that do not exist in defaults", () => {
    const defaults: ProviderOptionsByProvider = {
      openai: {
        store: false,
      },
    };

    const overrides: ProviderOptionsByProvider = {
      anthropic: {
        effort: "low",
      },
    };

    expect(mergeProviderOptions(defaults, overrides)).toEqual({
      openai: {
        store: false,
      },
      anthropic: {
        effort: "low",
      },
    });
  });

  test("replaces arrays instead of deep-merging arrays", () => {
    const defaults: ProviderOptionsByProvider = {
      openai: {
        include: ["reasoning.encrypted_content"],
      },
    };

    const overrides: ProviderOptionsByProvider = {
      openai: {
        include: ["reasoning.summary"],
      },
    };

    expect(mergeProviderOptions(defaults, overrides)).toEqual({
      openai: {
        include: ["reasoning.summary"],
      },
    });
  });
});

describe("gateway attribution headers", () => {
  // Rewritten 2026-08-20: these tests used a Claude model id and
  // asserted against createGatewayCalls, but createGateway (the old
  // Vercel AI Gateway SDK entry point) isn't called anywhere in the
  // current sharedProvider() -- Claude models go through
  // @ai-sdk/anthropic's createAnthropic (a real, unmocked client) on its
  // own native-Anthropic-Messages branch, so this always silently hit
  // the real network client instead of the mock. Switched to a generic
  // model id (openai/gpt-5.3 -- matches neither isClaudeModelId nor
  // isGeminiModelId) so this exercises the actual default branch
  // (createOpenAICompatible), and asserts against that mock instead.
  // GATEWAY_BASE_URL/GATEWAY_API_KEY are also required now (added by the
  // entry-gateway migration's getSharedProviderConfig()) when no custom
  // `config` override is passed.
  const originalGatewayBaseUrl = process.env.GATEWAY_BASE_URL;
  const originalGatewayApiKey = process.env.GATEWAY_API_KEY;

  test("sends default attribution headers", () => {
    process.env.GATEWAY_BASE_URL = "https://entry-gateway.test/v1";
    process.env.GATEWAY_API_KEY = "test-gateway-key";
    createOpenAICompatibleCalls.length = 0;

    try {
      gateway("openai/gpt-5.3" as never);

      expect(createOpenAICompatibleCalls).toEqual([
        {
          name: "openai",
          baseURL: "https://entry-gateway.test/v1",
          apiKey: "test-gateway-key",
          headers: {
            "http-referer": "https://open-agents.dev",
            "x-title": "Entry Agent",
          },
        },
      ]);
    } finally {
      process.env.GATEWAY_BASE_URL = originalGatewayBaseUrl;
      process.env.GATEWAY_API_KEY = originalGatewayApiKey;
    }
  });

  test("allows overriding attribution via appName and appUrl", () => {
    process.env.GATEWAY_BASE_URL = "https://entry-gateway.test/v1";
    process.env.GATEWAY_API_KEY = "test-gateway-key";
    createOpenAICompatibleCalls.length = 0;

    try {
      gateway("openai/gpt-5.3" as never, {
        appName: "My App",
        appUrl: "https://myapp.com",
      });

      expect(createOpenAICompatibleCalls).toEqual([
        {
          name: "openai",
          baseURL: "https://entry-gateway.test/v1",
          apiKey: "test-gateway-key",
          headers: {
            "http-referer": "https://myapp.com",
            "x-title": "My App",
          },
        },
      ]);
    } finally {
      process.env.GATEWAY_BASE_URL = originalGatewayBaseUrl;
      process.env.GATEWAY_API_KEY = originalGatewayApiKey;
    }
  });

  test("passes attribution headers with custom gateway config", () => {
    createOpenAICompatibleCalls.length = 0;
    gateway("openai/gpt-5.3" as never, {
      config: { baseURL: "https://custom.api", apiKey: "sk-test" },
    });

    expect(createOpenAICompatibleCalls).toEqual([
      {
        name: "openai",
        baseURL: "https://custom.api",
        apiKey: "sk-test",
        headers: {
          "http-referer": "https://open-agents.dev",
          "x-title": "Entry Agent",
        },
      },
    ]);
  });
});
