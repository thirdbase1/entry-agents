import { describe, expect, test } from "bun:test";
import { APP_DEFAULT_MODEL_ID } from "@/lib/models";
import { resolveChatModelSelection } from "./model-selection";

describe("resolveChatModelSelection", () => {
  test("returns direct model ids unchanged when the model isn't reasoning-capable", () => {
    const selection = resolveChatModelSelection({
      selectedModelId: "openai/gpt-5",
      reasoningEffort: null,
      missingModelLabel: "Selected model",
    });

    expect(selection).toEqual({
      id: "openai/gpt-5",
    });
  });

  test("attaches reasoning provider options for a reasoning-capable model", () => {
    const selection = resolveChatModelSelection({
      selectedModelId: "deepseek-v4-pro",
      reasoningEffort: "high",
      missingModelLabel: "Selected model",
    });

    expect(selection).toEqual({
      id: "deepseek-v4-pro",
      providerOptionsOverrides: {
        openai: {
          reasoningEffort: "high",
          store: false,
        },
      },
    });
  });

  test("ignores reasoning effort for models that don't support it", () => {
    const selection = resolveChatModelSelection({
      selectedModelId: "openai/gpt-5",
      reasoningEffort: "high",
      missingModelLabel: "Selected model",
    });

    expect(selection).toEqual({
      id: "openai/gpt-5",
    });
  });

  test("falls back to the default model and warns when the model is disabled", () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    try {
      const selection = resolveChatModelSelection({
        selectedModelId: "kimi-k3",
        reasoningEffort: null,
        missingModelLabel: "Selected model",
      });

      expect(selection).toEqual({
        id: APP_DEFAULT_MODEL_ID,
      });
      expect(warnings).toEqual([
        [
          'Selected model "kimi-k3" resolves to disabled model. Falling back to default model.',
        ],
      ]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("uses the default model when no model id is provided", () => {
    const selection = resolveChatModelSelection({
      selectedModelId: null,
      reasoningEffort: null,
      missingModelLabel: "Selected model",
    });

    expect(selection).toEqual({
      id: APP_DEFAULT_MODEL_ID,
    });
  });
});
