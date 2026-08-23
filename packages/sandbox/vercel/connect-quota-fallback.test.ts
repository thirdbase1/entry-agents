import { describe, expect, test } from "bun:test";
import { isSnapshotStorageQuotaExceededError } from "./connect.ts";

// Regression test for 2026-08-23: Vercel Hobby's Snapshot Storage quota
// (15GB) is billed per cycle. Once exceeded once, creating a PERSISTENT
// (auto-snapshotting) sandbox is blocked with a real 402 until the next
// monthly reset -- confirmed by reproducing the exact error body against
// Vercel's own API:
//   {"code":"payment_required","message":"Hobby plan usage limit exceeded
//   for Snapshots Storage. Limit will be reset on 2026-09-01T00:00:00.000Z.
//   Please upgrade to a Pro plan to continue using Vercel Sandbox, or
//   delete unused snapshots."}
// Deleting existing snapshots afterward does NOT clear this mid-cycle, so
// connectVercel/connectNamedSandbox degrade to a non-persistent create
// instead of hard-failing provisioning for the rest of the cycle.
describe("isSnapshotStorageQuotaExceededError", () => {
  test("matches the real production error body", () => {
    const error = new Error(
      "Status code 402 is not ok: Hobby plan usage limit exceeded for Snapshots Storage. " +
        "Limit will be reset on 2026-09-01T00:00:00.000Z. Please upgrade to a Pro plan to " +
        "continue using Vercel Sandbox, or delete unused snapshots.",
    );
    expect(isSnapshotStorageQuotaExceededError(error)).toBe(true);
  });

  test("matches a plain 402 mentioning snapshot", () => {
    expect(
      isSnapshotStorageQuotaExceededError(
        new Error("Status code 402 is not ok: snapshot quota"),
      ),
    ).toBe(true);
  });

  test("does not match an unrelated 402 (e.g. real payment/billing failure)", () => {
    expect(
      isSnapshotStorageQuotaExceededError(
        new Error("Status code 402 is not ok"),
      ),
    ).toBe(false);
  });

  test("does not match unrelated errors", () => {
    expect(
      isSnapshotStorageQuotaExceededError(new Error("Status code 500 is not ok")),
    ).toBe(false);
    expect(isSnapshotStorageQuotaExceededError(new Error("network timeout"))).toBe(
      false,
    );
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
