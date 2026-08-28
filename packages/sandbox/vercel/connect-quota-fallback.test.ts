import { describe, expect, test } from "bun:test";
import {
  isSnapshotStorageQuotaExceededError,
  isSandboxNotFoundError,
} from "./connect.ts";

// Minimal stand-in for the real @vercel/sandbox SDK's APIError shape
// (api-client/api-error.js): extends Error but keeps `.message` generic
// ("Status code N is not ok") and carries the actual response body on
// separate `.text`/`.json` properties instead of folding it into message.
class FakeAPIError extends Error {
  text?: string;
  json?: unknown;
  constructor(status: number, body: { text?: string; json?: unknown }) {
    super(`Status code ${status} is not ok`);
    this.text = body.text;
    this.json = body.json;
  }
}

// Regression test for 2026-08-24: found via real production runtime logs
// that persistent sandbox creation was still hard-failing with the bare
// "Status code 402 is not ok" FatalError, never triggering the
// non-persistent fallback added the same day. Root cause:
// isSnapshotStorageQuotaExceededError only inspected `error.message`,
// but the SDK's APIError deliberately keeps `.message` generic and puts
// the real "Hobby plan usage limit exceeded for Snapshots Storage..."
// text on `.text`/`.json` instead. toErrorMessage() now folds those in.
describe("isSnapshotStorageQuotaExceededError (real SDK APIError shape)", () => {
  test("matches the real production error via .text, even though .message is generic", () => {
    const error = new FakeAPIError(402, {
      text: JSON.stringify({
        code: "payment_required",
        message:
          "Hobby plan usage limit exceeded for Snapshots Storage. Limit will be reset on 2026-09-01T00:00:00.000Z. Please upgrade to a Pro plan to continue using Vercel Sandbox, or delete unused snapshots.",
      }),
      json: {
        code: "payment_required",
        message: "Hobby plan usage limit exceeded for Snapshots Storage.",
      },
    });

    // Sanity check: this is exactly the bug -- .message alone gives no clue.
    expect(error.message).toBe("Status code 402 is not ok");
    expect(isSnapshotStorageQuotaExceededError(error)).toBe(true);
  });

  test("matches via .json alone when .text is absent", () => {
    const error = new FakeAPIError(402, {
      json: { code: "payment_required", message: "snapshots storage limit" },
    });
    expect(isSnapshotStorageQuotaExceededError(error)).toBe(true);
  });

  test("does not match an unrelated real 402 APIError", () => {
    const error = new FakeAPIError(402, {
      text: JSON.stringify({
        code: "payment_required",
        message: "Card declined",
      }),
    });
    expect(isSnapshotStorageQuotaExceededError(error)).toBe(false);
  });

  test("does not match unrelated errors", () => {
    expect(
      isSnapshotStorageQuotaExceededError(
        new Error("Status code 500 is not ok"),
      ),
    ).toBe(false);
    expect(
      isSnapshotStorageQuotaExceededError(new Error("network timeout")),
    ).toBe(false);
  });

  test("handles non-Error thrown values", () => {
    expect(
      isSnapshotStorageQuotaExceededError(
        "hobby plan usage limit exceeded for snapshots storage",
      ),
    ).toBe(true);
    expect(isSnapshotStorageQuotaExceededError({ some: "object" })).toBe(false);
  });
});

// Guard against regressing the existing 404/410 detector while extending
// toErrorMessage to also read .text/.json -- it must keep matching purely
// off `.message` for errors that don't carry those extra properties.
describe("isSandboxNotFoundError (unaffected by the toErrorMessage change)", () => {
  test("still matches a plain 404 Error with no .text/.json", () => {
    expect(isSandboxNotFoundError(new Error("Status code 404 is not ok"))).toBe(
      true,
    );
  });

  test("still matches a real APIError-shaped 410", () => {
    const error = new FakeAPIError(410, { text: "Gone" });
    expect(isSandboxNotFoundError(error)).toBe(true);
  });
});
