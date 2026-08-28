import { describe, expect, test } from "bun:test";
import { isSandboxAlreadyExistsError } from "./connect.ts";

// Minimal stand-in for the real @vercel/sandbox SDK's APIError shape,
// matching the pattern used in connect-quota-fallback.test.ts.
class FakeAPIError extends Error {
  text?: string;
  json?: unknown;
  constructor(status: number, body: { text?: string; json?: unknown }) {
    super(`Status code ${status} is not ok`);
    this.name = "FakeAPIError";
    this.text = body.text;
    this.json = body.json;
  }
}

// Regression test for 2026-08-28: found via the sandboxes.lifecycleError
// column (Vercel's runtime logs only ever showed the bare "Status code
// 400 is not ok") that a real session's sandbox provisioning failed
// identically 5 times within a minute with the SDK's raw response body:
// {"error":{"code":"bad_request","message":"A sandbox with the name
// '<name>' already exists for this project. Use GET /sandboxes/:name to
// resume it or delete it first."}}. Root cause: connectNamedSandbox's
// initial connect() call fails on a STOPPED (not deleted) sandbox with a
// "sandbox is stopped"-shaped error, which isSandboxNotFoundError
// correctly treats as "gone" for the 410/expired-snapshot case it was
// built for -- but a stopped sandbox is not actually gone, so the
// createIfMissing fallback's create() call then collides with the name
// Vercel still has on record, forever, on every retry.
describe("isSandboxAlreadyExistsError", () => {
  test("matches the real production error body", () => {
    const error = new FakeAPIError(400, {
      text: JSON.stringify({
        error: {
          code: "bad_request",
          message:
            "A sandbox with the name 'session_hRtb7C9Uy_mYOZaKO7fvz' already exists for this project. Use GET /sandboxes/:name to resume it or delete it first.",
        },
      }),
    });

    // Sanity check: this is exactly the bug -- .message alone gives no clue.
    expect(error.message).toBe("Status code 400 is not ok");
    expect(isSandboxAlreadyExistsError(error)).toBe(true);
  });

  test("matches via .json alone when .text is absent", () => {
    const error = new FakeAPIError(400, {
      json: {
        error: {
          code: "bad_request",
          message: "A sandbox with the name 'foo' already exists",
        },
      },
    });
    expect(isSandboxAlreadyExistsError(error)).toBe(true);
  });

  test("does not match an unrelated 400 error", () => {
    const error = new FakeAPIError(400, {
      text: JSON.stringify({
        error: { code: "bad_request", message: "Invalid source branch" },
      }),
    });
    expect(isSandboxAlreadyExistsError(error)).toBe(false);
  });

  test("does not match a 402 quota error", () => {
    const error = new FakeAPIError(402, {
      text: "Hobby plan usage limit exceeded for Snapshots Storage.",
    });
    expect(isSandboxAlreadyExistsError(error)).toBe(false);
  });

  test("does not match a 404 not-found error", () => {
    expect(
      isSandboxAlreadyExistsError(new Error("Status code 404 is not ok")),
    ).toBe(false);
  });

  test("handles non-Error thrown values", () => {
    expect(isSandboxAlreadyExistsError("just a string")).toBe(false);
  });
});
