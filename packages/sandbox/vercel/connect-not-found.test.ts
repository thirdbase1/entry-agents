import { describe, expect, test } from "bun:test";
import { isSandboxNotFoundError } from "./connect.ts";

// Gates the createIfMissing fresh-recreate fallback in connectVercel.
// Regression test for 2026-08-23: a sandbox whose resume snapshot had
// expired surfaced as "Status code 410 is not ok" from the Vercel Sandbox
// SDK, not 404 -- this previously fell through the check entirely (only
// matched 404/"not found"), so the error was rethrown instead of
// triggering a fresh git-clone recreate, hard-crashing provisioning in
// production (3 real runs failed this way before the fix).
describe("isSandboxNotFoundError", () => {
  test("matches a 404 status code error", () => {
    expect(isSandboxNotFoundError(new Error("Status code 404 is not ok"))).toBe(
      true,
    );
  });

  test("matches a 410 Gone status code error (the regression case)", () => {
    expect(isSandboxNotFoundError(new Error("Status code 410 is not ok"))).toBe(
      true,
    );
  });

  test("matches a plain 'not found' message", () => {
    expect(isSandboxNotFoundError(new Error("sandbox not found"))).toBe(true);
  });

  test("matches 'sandbox is stopped'", () => {
    expect(isSandboxNotFoundError(new Error("Sandbox is stopped"))).toBe(true);
  });

  test("matches 'sandbox probe failed'", () => {
    expect(isSandboxNotFoundError(new Error("sandbox probe failed"))).toBe(
      true,
    );
  });

  test("matches 'expected a stream of command data'", () => {
    expect(
      isSandboxNotFoundError(
        new Error("Expected a stream of command data but got EOF"),
      ),
    ).toBe(true);
  });

  test("does not match unrelated errors", () => {
    expect(isSandboxNotFoundError(new Error("Status code 500 is not ok"))).toBe(
      false,
    );
    expect(isSandboxNotFoundError(new Error("network timeout"))).toBe(false);
  });

  test("handles non-Error thrown values", () => {
    expect(isSandboxNotFoundError("status code 410 is not ok")).toBe(true);
    expect(isSandboxNotFoundError({ some: "object" })).toBe(false);
  });
});
