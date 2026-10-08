import { describe, expect, test } from "bun:test";
import { hasRuntimeSandboxState, isSandboxActive } from "./utils";

describe("boxd runtime state", () => {
  test("treats a stable boxd machine without expiresAt as active", () => {
    const state = {
      type: "boxd" as const,
      machineId: "machine-123",
      machineName: "entry-session-hash",
    };

    expect(hasRuntimeSandboxState(state)).toBe(true);
    expect(isSandboxActive(state)).toBe(true);
  });

  test("still requires an expiry timestamp for providers that need one", () => {
    const state = {
      type: "modal" as const,
      sandboxId: "sandbox-123",
      volumeName: "entry-workspace-session",
    };

    expect(hasRuntimeSandboxState(state)).toBe(false);
    expect(isSandboxActive(state)).toBe(false);
  });
});
