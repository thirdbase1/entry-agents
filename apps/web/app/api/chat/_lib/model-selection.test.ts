import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));
mock.module("@/lib/db/model-overrides", () => ({
  getDisabledModelIdSet: mock(async () => new Set<string>()),
}));

const { APP_DEFAULT_MODEL_ID } = await import("@/lib/models");
const { resolveChatModelSelection } = await import("./model-selection");

describe("resolveChatModelSelection", () => {
  test("returns direct model ids unchanged when the model isn't reasoning-capable", async () => {
    const selection = await resolveChatModelSelection({
      selectedModelId: "openai/gpt-5",
      reasoningEffort: null,
      missingModelLabel: "Selected model",
    });

    expect(selection).toEqual({
      id: "openai/gpt-5",
    });
  });

  test("attaches reasoning provider options for a reasoning-capable model", async () => {
    const selection = await resolveChatModelSelection({
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

  test("ignores reasoning effort for models that don't support it", async () => {
    const selection = await resolveChatModelSelection({
      selectedModelId: "openai/gpt-5",
      reasoningEffort: "high",
      missingModelLabel: "Selected model",
    });

    expect(selection).toEqual({
      id: "openai/gpt-5",
    });
  });

  // Changed 2026-08-17: silent substitution was removed entirely (owner
  // instruction -- a user was invisibly moved off their selected model
  // onto a disabled default and just saw a generic error). Disabled
  // models must now throw a clear, specific error instead of resolving
  // to APP_DEFAULT_MODEL_ID.
  test("throws a clear error instead of silently falling back when the model is hard-blocked", async () => {
    await expect(
      resolveChatModelSelection({
        selectedModelId: "kimi-k3",
        reasoningEffort: null,
        missingModelLabel: "Selected model",
      }),
    ).rejects.toThrow(/kimi-k3.*currently unavailable/);
  });

  test("uses the default model when no model id is provided", async () => {
    const selection = await resolveChatModelSelection({
      selectedModelId: null,
      reasoningEffort: null,
      missingModelLabel: "Selected model",
    });

    expect(selection).toEqual({
      id: APP_DEFAULT_MODEL_ID,
    });
  });

  test("throws a clear error for an admin-disabled model from the DB override table", async () => {
    const { getDisabledModelIdSet } = await import("@/lib/db/model-overrides");
    (
      getDisabledModelIdSet as unknown as ReturnType<typeof mock>
    ).mockImplementationOnce(async () => new Set(["deepseek-v4-pro"]));

    await expect(
      resolveChatModelSelection({
        selectedModelId: "deepseek-v4-pro",
        reasoningEffort: null,
        missingModelLabel: "Selected model",
      }),
    ).rejects.toThrow(/deepseek-v4-pro.*currently unavailable/);
  });
});
