import { describe, expect, test } from "bun:test";
import { isFriendlyChatErrorText } from "./friendly-error";

describe("isFriendlyChatErrorText", () => {
  test("matches an exact friendly error string", () => {
    expect(
      isFriendlyChatErrorText(
        "The request was stopped.",
      ),
    ).toBe(true);
  });

  test("matches with surrounding whitespace", () => {
    expect(
      isFriendlyChatErrorText(
        "  The AI provider is temporarily unavailable. Please try again in a moment.  ",
      ),
    ).toBe(true);
  });

  test("matches with the repeat-failure suffix appended", () => {
    expect(
      isFriendlyChatErrorText(
        "The request took too long and timed out. Please try again. This looks like a repeating issue rather than a one-off, so retrying probably won't help -- try switching models, or let us know if it keeps happening.",
      ),
    ).toBe(true);
  });

  test("does not match real assistant text", () => {
    expect(
      isFriendlyChatErrorText(
        "I've updated your config file and restarted the server.",
      ),
    ).toBe(false);
  });

  test("does not match empty or whitespace-only text", () => {
    expect(isFriendlyChatErrorText("")).toBe(false);
    expect(isFriendlyChatErrorText("   ")).toBe(false);
  });

  test("does not match text that merely mentions an error string later", () => {
    expect(
      isFriendlyChatErrorText(
        "Here's what happened: The request was stopped. But I retried and it worked.",
      ),
    ).toBe(false);
  });
});
