import { describe, expect, test } from "bun:test";
import type { UserPreferencesData } from "@/lib/db/user-preferences";
import {
  filterModelsForSession,
  sanitizeSelectedModelIdForSession,
  sanitizeUserPreferencesForSession,
} from "./model-access";

const managedTrialSession = {
  authProvider: "vercel" as const,
  user: {
    id: "user-1",
    username: "alice",
    email: "alice@example.com",
    avatar: "",
  },
};

const vercelSession = {
  authProvider: "vercel" as const,
  user: {
    id: "user-2",
    username: "vercel-user",
    email: "dev@vercel.com",
    avatar: "",
  },
};

const requestUrl = "https://open-agents.dev/api/test";

const basePreferences: UserPreferencesData = {
  defaultModelId: "kimi-k3",
  defaultSubagentModelId: "kimi-k3",
  defaultSandboxType: "vercel",
  defaultDiffMode: "unified",
  autoCommitPush: false,
  autoCreatePr: false,
  alertsEnabled: true,
  alertSoundEnabled: true,
  publicUsageEnabled: false,
  globalSkillRefs: [],
  enabledModelIds: ["kimi-k3", "openai/gpt-5"],
};

describe("model access gating", () => {
  test("filters Kimi K3 for managed trial users", () => {
    const result = filterModelsForSession(
      [{ id: "kimi-k3" }, { id: "openai/gpt-5" }],
      managedTrialSession,
      requestUrl,
    );

    expect(result).toEqual([{ id: "openai/gpt-5" }]);
  });

  test("falls back to the app default when a managed trial user selects Kimi K3", () => {
    const result = sanitizeSelectedModelIdForSession(
      "kimi-k3",
      managedTrialSession,
      requestUrl,
    );

    expect(result).toBe("deepseek-v4-flash");
  });

  test("sanitizes managed trial preferences without mutating the database shape", () => {
    const result = sanitizeUserPreferencesForSession(
      basePreferences,
      managedTrialSession,
      requestUrl,
    );

    expect(result).toMatchObject({
      defaultModelId: "deepseek-v4-flash",
      defaultSubagentModelId: "deepseek-v4-flash",
      enabledModelIds: ["openai/gpt-5"],
    });
  });

  test("leaves Vercel users unchanged", () => {
    const result = sanitizeUserPreferencesForSession(
      basePreferences,
      vercelSession,
      requestUrl,
    );

    expect(result).toEqual(basePreferences);
  });
});
