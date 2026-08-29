import { describe, expect, test } from "bun:test";
import { isSnapshotResumeUnavailableError } from "./connect.ts";

// Minimal stand-in for the real @vercel/sandbox SDK's APIError shape,
// matching the pattern used in connect-already-exists.test.ts /
// connect-quota-fallback.test.ts.
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

// Regression test for 2026-08-29: a session provisioned before the
// 2026-08-25 persistent-default flip carries a real `snapshotId` in its
// DB-persisted sandbox state forever (it's only ever cleared going
// forward by a *successful* getState() call). If the Entry Sandbox
// Snapshot Cleanup workflow has since deleted that underlying snapshot
// (anything older than 2 days), every resume attempt 400s with "Cannot
// resume sandbox: no snapshot available" before a successful getState()
// is ever reached -- so the poisoned snapshotId never gets cleared and
// the session fails identically forever. Confirmed via real production
// runtime logs: 4 distinct workflow runs for the same session, all with
// this exact error, within a few minutes.
describe("isSnapshotResumeUnavailableError", () => {
  test("matches the real production error body", () => {
    const error = new FakeAPIError(400, {
      text: "Status code 400 is not ok: Cannot resume sandbox: no snapshot available.",
    });

    expect(isSnapshotResumeUnavailableError(error)).toBe(true);
  });

  test("matches via .json alone when .text is absent", () => {
    const error = new FakeAPIError(400, {
      json: {
        error: {
          code: "bad_request",
          message: "Cannot resume sandbox: no snapshot available.",
        },
      },
    });
    expect(isSnapshotResumeUnavailableError(error)).toBe(true);
  });

  test("does not match the unrelated already-exists 400 error", () => {
    const error = new FakeAPIError(400, {
      text: "A sandbox with the name 'foo' already exists for this project.",
    });
    expect(isSnapshotResumeUnavailableError(error)).toBe(false);
  });

  test("does not match a 402 quota error", () => {
    const error = new FakeAPIError(402, {
      text: "Hobby plan usage limit exceeded for Snapshots Storage.",
    });
    expect(isSnapshotResumeUnavailableError(error)).toBe(false);
  });

  test("does not match a 404 not-found error", () => {
    expect(
      isSnapshotResumeUnavailableError(new Error("Status code 404 is not ok")),
    ).toBe(false);
  });

  test("handles non-Error thrown values", () => {
    expect(isSnapshotResumeUnavailableError("just a string")).toBe(false);
  });
});
