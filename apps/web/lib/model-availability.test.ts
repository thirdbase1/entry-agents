import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const overrideSpy = mock(async () => new Set<string>());
mock.module("@/lib/db/model-overrides", () => ({
  getDisabledModelIdSet: overrideSpy,
}));

const {
  filterDisabledModels,
  isModelDisabled,
  isModelHardBlocked,
  resolveAvailableModelId,
} = await import("./model-availability");
const { APP_DEFAULT_MODEL_ID } = await import("./models");

describe("model availability", () => {
  test("disables OpenAI GPT pro models (hard block, code-level)", () => {
    expect(isModelHardBlocked("openai/gpt-5.4-pro")).toBe(true);
    expect(isModelHardBlocked("openai/gpt-5.5-pro")).toBe(true);
    expect(isModelHardBlocked("openai/gpt-5.5-pro-preview")).toBe(false);
    expect(isModelHardBlocked("openai/gpt-5.5")).toBe(false);
    expect(isModelHardBlocked("openai/o1-pro")).toBe(false);
  });

  test("isModelDisabled matches the hard block without touching the DB", async () => {
    overrideSpy.mockClear();
    expect(await isModelDisabled("openai/gpt-5.4-pro")).toBe(true);
    expect(overrideSpy).not.toHaveBeenCalled();
  });

  test("isModelDisabled checks the DB override set for non-hard-blocked models", async () => {
    overrideSpy.mockImplementationOnce(async () => new Set(["mimo-v2-pro"]));
    expect(await isModelDisabled("mimo-v2-pro")).toBe(true);
    expect(await isModelDisabled("openai/gpt-5.5")).toBe(false);
  });

  test("filters disabled models from available model lists", async () => {
    overrideSpy.mockImplementationOnce(async () => new Set<string>());
    const models = [
      { id: "openai/gpt-5.5", name: "GPT 5.5" },
      { id: "openai/gpt-5.5-pro", name: "GPT 5.5 Pro" },
      { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6" },
    ];

    expect(await filterDisabledModels(models)).toEqual([
      { id: "openai/gpt-5.5", name: "GPT 5.5" },
      { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6" },
    ]);
  });

  test("filters admin-disabled models via the DB override set", async () => {
    overrideSpy.mockImplementationOnce(async () => new Set(["openai/gpt-5.5"]));
    const models = [
      { id: "openai/gpt-5.5", name: "GPT 5.5" },
      { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6" },
    ];

    expect(await filterDisabledModels(models)).toEqual([
      { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6" },
    ]);
  });

  test("resolves disabled model selections to the app default", async () => {
    overrideSpy.mockImplementationOnce(async () => new Set<string>());
    expect(await resolveAvailableModelId("openai/gpt-5.5-pro")).toBe(
      APP_DEFAULT_MODEL_ID,
    );
    overrideSpy.mockImplementationOnce(async () => new Set<string>());
    expect(await resolveAvailableModelId("openai/gpt-5.5")).toBe(
      "openai/gpt-5.5",
    );
  });
});
