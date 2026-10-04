import { describe, expect, test } from "bun:test";
import type { ModalSandboxState } from "./utils";
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
  const state: ModalSandboxState = {
    type: "modal",
    volumeName: "entry-workspace-session_test",
    expiresAt: Date.now() + 60_000,
  };

  test("keeps the volume through a hard 404 so the workspace survives", () => {
    // The unlike-the-old-world behaviour: Modal's volume is the durable
    // workspace, so a NotFound (the container was reaped) must NOT wipe it
    // -- only the runtime fields are cleared. Losing the volume here would
    // orphan the session's files.
    const cleared = clearUnavailableSandboxState(
      state,
      "Sandbox sb-dead not found",
    );

    expect(cleared).toEqual({
      type: "modal",
      volumeName: "entry-workspace-session_test",
    });
  });

  test("preserves the resume handle for non-404 unavailable errors", () => {
    const cleared = clearUnavailableSandboxState(state, "sandbox is stopped");

    expect(cleared).toEqual({
      type: "modal",
      volumeName: "entry-workspace-session_test",
    });
  });
});
