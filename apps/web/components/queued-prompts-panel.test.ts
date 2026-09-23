import { describe, expect, test } from "bun:test";
import { shouldCommitOnBlur } from "./queued-prompts-panel";

/**
 * Regression test for the queued-prompt edit lifecycle.
 *
 * Bug: the textarea committed on blur, and the browser fires blur BEFORE the
 * click that follows it. So pressing Cancel actually SAVED the draft -- the
 * blur handler committed before Cancel's click handler ever ran, and the user
 * had no way to discard an edit. Fixed by having the action buttons claim the
 * blur (shouldCommitOnBlur returns false for a claimed blur).
 */
describe("shouldCommitOnBlur", () => {
  test("commits when a row is being edited and nothing claimed the blur", () => {
    expect(
      shouldCommitOnBlur({ editingId: "p1", claimedByAction: false }),
    ).toBe(true);
  });

  test("does NOT commit when an explicit action claimed the blur", () => {
    // This is the Cancel case: the claim must win over the blur.
    expect(shouldCommitOnBlur({ editingId: "p1", claimedByAction: true })).toBe(
      false,
    );
  });

  test("does not commit when no row is being edited", () => {
    expect(
      shouldCommitOnBlur({ editingId: null, claimedByAction: false }),
    ).toBe(false);
    expect(shouldCommitOnBlur({ editingId: null, claimedByAction: true })).toBe(
      false,
    );
  });
});
