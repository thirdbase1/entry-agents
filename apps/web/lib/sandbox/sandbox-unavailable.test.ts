import { describe, expect, test } from "bun:test";
import type { VercelSandboxState } from "./utils";
import {
  clearUnavailableSandboxState,
  isSandboxUnavailableError,
} from "./utils";

describe("isSandboxUnavailableError", () => {
  test("matches the 400 snapshot-resume failure (2026-08-30 regression)", () => {
    expect(
      isSandboxUnavailableError(
        "Status code 400 is not ok: Cannot resume sandbox: no snapshot available.",
      ),
    ).toBe(true);
  });

  test("does not match unrelated 400 errors", () => {
    expect(
      isSandboxUnavailableError(
        "Status code 400 is not ok: A sandbox with the name 'foo' already exists for this project.",
      ),
    ).toBe(false);
  });

  test("still matches the pre-existing unavailable patterns", () => {
    expect(isSandboxUnavailableError("Status code 404 is not ok")).toBe(true);
    expect(isSandboxUnavailableError("Status code 410 is not ok")).toBe(true);
    expect(isSandboxUnavailableError("sandbox is stopped")).toBe(true);
  });
});

describe("clearUnavailableSandboxState", () => {
  const state: VercelSandboxState = {
    type: "vercel",
    sandboxName: "session_test",
    snapshotId: "snap_dead",
    expiresAt: Date.now() + 60_000,
  };

  test("drops the stale snapshotId for the snapshot-resume 400", () => {
    const cleared = clearUnavailableSandboxState(
      state,
      "Status code 400 is not ok: Cannot resume sandbox: no snapshot available.",
    );

    expect(cleared).toEqual({
      type: "vercel",
      sandboxName: "session_test",
    });
  });

  test("preserves the resume handle for non-404 unavailable errors", () => {
    const cleared = clearUnavailableSandboxState(state, "sandbox is stopped");

    expect(cleared).toEqual({
      type: "vercel",
      sandboxName: "session_test",
    });
  });
});
