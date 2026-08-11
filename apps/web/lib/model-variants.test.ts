import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_VARIANT_ID_PREFIX,
  BUILT_IN_VARIANTS,
  getAllVariants,
  isBuiltInVariant,
  resolveModelSelection,
  toProviderOptionsByProvider,
  type ModelVariant,
} from "./model-variants";

describe("model variants", () => {
  test("toProviderOptionsByProvider always nests under the 'openai' key, regardless of the base model id", () => {
    // Every model call goes through a single createOpenAI()-based client
    // (see packages/agent/models.ts) pointed at entry-gateway, so the AI
    // SDK only ever reads settings back out under the literal "openai" key
    // -- never a key derived from the actual upstream model id. Flat
    // reseller ids like "kimi-k3" must map here too, not just "openai/..."
    // ids from the old Vercel-AI-Gateway-namespaced era.
    const result = toProviderOptionsByProvider("kimi-k3", {
      reasoningEffort: "high",
    });

    expect(result).toEqual({
      openai: {
        reasoningEffort: "high",
        store: false,
      },
    });
  });

  test("toProviderOptionsByProvider injects store false even when provider options are empty", () => {
    const result = toProviderOptionsByProvider("deepseek-v4-pro", {});

    expect(result).toEqual({
      openai: {
        store: false,
      },
    });
  });

  test("toProviderOptionsByProvider returns undefined when baseModelId is empty", () => {
    const result = toProviderOptionsByProvider("", {});
    expect(result).toBeUndefined();
  });

  test("toProviderOptionsByProvider forces store false even if the caller passed store true", () => {
    const result = toProviderOptionsByProvider("openai/gpt-5", {
      reasoningEffort: "medium",
      store: true,
    });

    expect(result).toEqual({
      openai: {
        reasoningEffort: "medium",
        store: false,
      },
    });
  });

  test("isBuiltInVariant returns true for built-in ids and false for user ids", () => {
    expect(isBuiltInVariant("variant:builtin:deepseek-v4-pro-high")).toBe(true);
    expect(isBuiltInVariant("variant:openai-medium")).toBe(false);
  });

  test("BUILT_IN_VARIANTS has real presets pinning a live flat model id with a genuine tunable knob", () => {
    expect(BUILT_IN_VARIANTS.map((variant) => variant.id)).toEqual([
      `${BUILT_IN_VARIANT_ID_PREFIX}deepseek-v4-pro-high`,
      `${BUILT_IN_VARIANT_ID_PREFIX}glm-5.2-high`,
    ]);
  });

  test("getAllVariants prepends built-in variants to user variants", () => {
    const userVariants: ModelVariant[] = [
      {
        id: "variant:openai-medium",
        name: "OpenAI Medium Reasoning",
        baseModelId: "openai/gpt-5",
        providerOptions: {
          reasoningEffort: "medium",
        },
      },
    ];

    const result = getAllVariants(userVariants);

    expect(result).toHaveLength(3);
    expect(result[0]?.id).toBe(`${BUILT_IN_VARIANT_ID_PREFIX}deepseek-v4-pro-high`);
    expect(result[1]?.id).toBe(`${BUILT_IN_VARIANT_ID_PREFIX}glm-5.2-high`);
    expect(result[2]).toEqual(userVariants[0]);
  });

  test("resolveModelSelection returns base model unchanged when id is not a variant", () => {
    const result = resolveModelSelection("openai/gpt-5", []);

    expect(result).toEqual({
      resolvedModelId: "openai/gpt-5",
      isMissingVariant: false,
    });
  });

  test("resolveModelSelection resolves variant to base model with provider options", () => {
    const variants: ModelVariant[] = [
      {
        id: "variant:openai-medium",
        name: "OpenAI Medium Reasoning",
        baseModelId: "openai/gpt-5",
        providerOptions: {
          reasoningEffort: "medium",
          store: false,
        },
      },
    ];

    const result = resolveModelSelection("variant:openai-medium", variants);

    expect(result).toEqual({
      resolvedModelId: "openai/gpt-5",
      providerOptionsByProvider: {
        openai: {
          reasoningEffort: "medium",
          store: false,
        },
      },
      isMissingVariant: false,
    });
  });

  test("resolveModelSelection marks missing variants", () => {
    const result = resolveModelSelection("variant:missing", []);

    expect(result).toEqual({
      resolvedModelId: "variant:missing",
      isMissingVariant: true,
    });
  });
});
