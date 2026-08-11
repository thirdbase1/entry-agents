import { describe, expect, test } from "bun:test";
import {
  buildModelOptions,
  getDefaultModelOptionId,
  groupByProvider,
  withMissingModelOption,
} from "./model-options";
import type { AvailableModel } from "./models";

function createModel(input: {
  id: string;
  name?: string;
  description?: string | null;
  contextWindow?: number;
}): AvailableModel {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    context_window: input.contextWindow,
    modelType: "language",
  } as unknown as AvailableModel;
}

describe("model options", () => {
  test("buildModelOptions maps base models", () => {
    const models: AvailableModel[] = [
      createModel({
        id: "openai/gpt-5",
        name: "GPT-5",
        description: "Base model",
        contextWindow: 400_000,
      }),
    ];

    const options = buildModelOptions(models);

    expect(options).toEqual([
      {
        id: "openai/gpt-5",
        label: "GPT-5",
        shortLabel: "GPT-5",
        description: "Base model",
        contextWindow: 400_000,
        provider: "openai",
      },
    ]);
  });

  test("buildModelOptions strips provider prefix for shortLabel", () => {
    const models: AvailableModel[] = [
      createModel({
        id: "anthropic/claude-opus-4.6",
        name: "Claude Opus 4.6",
      }),
    ];

    const options = buildModelOptions(models);

    expect(options[0].shortLabel).toBe("Opus 4.6");
    expect(options[0].label).toBe("Claude Opus 4.6");
  });

  test("groupByProvider puts anthropic and openai first, preserves insertion order", () => {
    const options = [
      {
        id: "google/gemini-2.5",
        label: "Gemini 2.5",
        shortLabel: "2.5",
        provider: "google",
      },
      {
        id: "openai/gpt-5",
        label: "GPT-5",
        shortLabel: "GPT-5",
        provider: "openai",
      },
      {
        id: "anthropic/claude-opus-4.6",
        label: "Claude Opus 4.6",
        shortLabel: "Opus 4.6",
        provider: "anthropic",
      },
    ];

    const groups = groupByProvider(options);

    expect(groups.map((g) => g.provider)).toEqual([
      "anthropic",
      "openai",
      "google",
    ]);
    expect(groups[0].options[0].id).toBe("anthropic/claude-opus-4.6");
  });

  test("withMissingModelOption appends missing model option", () => {
    const result = withMissingModelOption([], "openai/removed");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "openai/removed",
      label: "openai/removed (unavailable)",
      shortLabel: "openai/removed (unavailable)",
      description: "Model no longer available",
      contextWindow: undefined,
      provider: "unknown",
    });
  });

  test("withMissingModelOption returns original list when id already exists", () => {
    const original = [
      {
        id: "openai/gpt-5",
        label: "GPT-5",
        shortLabel: "GPT-5",
        provider: "openai",
      },
    ];

    expect(withMissingModelOption(original, "openai/gpt-5")).toBe(original);
  });

  test("withMissingModelOption returns original list when modelId is missing", () => {
    const original = [
      {
        id: "openai/gpt-5",
        label: "GPT-5",
        shortLabel: "GPT-5",
        provider: "openai",
      },
    ];

    expect(withMissingModelOption(original, null)).toBe(original);
  });

  test("getDefaultModelOptionId prefers repository default model when present", () => {
    const options = [
      {
        id: "openai/gpt-5.4",
        label: "GPT-5.4",
        shortLabel: "GPT-5.4",
        provider: "anthropic",
      },
      {
        id: "openai/gpt-5",
        label: "GPT-5",
        shortLabel: "GPT-5",
        provider: "openai",
      },
    ];

    expect(getDefaultModelOptionId(options)).toBe("openai/gpt-5.4");
  });

  test("getDefaultModelOptionId falls back to first option when default is missing", () => {
    const options = [
      {
        id: "openai/gpt-5",
        label: "GPT-5",
        shortLabel: "GPT-5",
        provider: "openai",
      },
    ];

    expect(getDefaultModelOptionId(options)).toBe("openai/gpt-5");
  });
});
