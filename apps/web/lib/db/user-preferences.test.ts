import { describe, expect, mock, test } from "bun:test";

mock.module("./client", () => ({
  db: {},
}));

const userPreferencesModulePromise = import("./user-preferences");

describe("toUserPreferencesData", () => {
  test("returns defaults when row is undefined", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    expect(toUserPreferencesData()).toEqual({
      defaultModelId: "gpt-5.6-luna",
      defaultSubagentModelId: null,
      defaultSandboxType: "vercel",
      defaultDiffMode: "unified",
      autoCommitPush: false,
      autoCreatePr: false,
      defaultPermissionMode: "ask",
      alertsEnabled: true,
      alertSoundEnabled: true,
      publicUsageEnabled: false,
      globalSkillRefs: [],
      enabledModelIds: [],
    });
  });

  test("normalizes invalid sandbox and diff mode values to defaults", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    const result = toUserPreferencesData({
      defaultModelId: "openai/gpt-5",
      defaultSubagentModelId: "openai/gpt-5-mini",
      defaultSandboxType: "invalid" as never,
      defaultDiffMode: "invalid" as never,
      autoCommitPush: false,
      autoCreatePr: false,
      defaultPermissionMode: "ask",
      alertsEnabled: true,
      alertSoundEnabled: true,
      publicUsageEnabled: false,
      globalSkillRefs: [],
      enabledModelIds: [],
    });

    expect(result.defaultSandboxType).toBe("vercel");
    expect(result.defaultDiffMode).toBe("unified");
  });

  test("normalizes legacy hybrid sandbox types to vercel", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    const result = toUserPreferencesData({
      defaultModelId: "openai/gpt-5",
      defaultSubagentModelId: null,
      defaultSandboxType: "hybrid" as never,
      defaultDiffMode: "unified",
      autoCommitPush: false,
      autoCreatePr: false,
      defaultPermissionMode: "ask",
      alertsEnabled: true,
      alertSoundEnabled: true,
      publicUsageEnabled: false,
      globalSkillRefs: [],
      enabledModelIds: [],
    });

    expect(result.defaultSandboxType).toBe("vercel");
    expect(result.defaultDiffMode).toBe("unified");
  });

  test("drops invalid globalSkillRefs payloads", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    const result = toUserPreferencesData({
      defaultModelId: "openai/gpt-5",
      defaultSubagentModelId: null,
      defaultSandboxType: "vercel",
      defaultDiffMode: "split",
      autoCommitPush: false,
      autoCreatePr: false,
      defaultPermissionMode: "ask",
      alertsEnabled: true,
      alertSoundEnabled: true,
      publicUsageEnabled: false,
      globalSkillRefs: [
        { source: "vercel/ai", skillName: "bad name" },
      ] as never,
      enabledModelIds: [],
    });

    expect(result.globalSkillRefs).toEqual([]);
  });

  test("keeps valid globalSkillRefs payloads", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    const result = toUserPreferencesData({
      defaultModelId: "openai/gpt-5",
      defaultSubagentModelId: null,
      defaultSandboxType: "vercel",
      defaultDiffMode: "split",
      autoCommitPush: false,
      autoCreatePr: false,
      defaultPermissionMode: "ask",
      alertsEnabled: true,
      alertSoundEnabled: true,
      publicUsageEnabled: false,
      globalSkillRefs: [
        { source: "vercel/ai", skillName: "ai-sdk" },
        { source: "vercel/ai", skillName: "ai-sdk" },
      ],
      enabledModelIds: [],
    });

    expect(result.globalSkillRefs).toEqual([
      { source: "vercel/ai", skillName: "ai-sdk" },
    ]);
  });

  test("keeps publicUsageEnabled when provided", async () => {
    const { toUserPreferencesData } = await userPreferencesModulePromise;

    const result = toUserPreferencesData({
      defaultModelId: "openai/gpt-5",
      defaultSubagentModelId: null,
      defaultSandboxType: "vercel",
      defaultDiffMode: "split",
      autoCommitPush: false,
      autoCreatePr: false,
      defaultPermissionMode: "ask",
      alertsEnabled: true,
      alertSoundEnabled: true,
      publicUsageEnabled: true,
      globalSkillRefs: [],
      enabledModelIds: [],
    });

    expect(result.publicUsageEnabled).toBe(true);
  });
});
