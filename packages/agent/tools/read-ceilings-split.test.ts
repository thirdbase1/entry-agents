import { describe, expect, test } from "bun:test";
import { applyByteCeiling, selectLines, splitLines } from "./read-ceilings";

/**
 * Regression test for the read tool's phantom trailing line.
 *
 * Bug: read.ts built its line array with `content.split("\n")`, so every
 * file ending in the conventional trailing newline reported a line count one
 * higher than reality and emitted a blank `N: ` row. The model then reasoned
 * about a file length that did not exist -- and because the edit tool tells
 * callers to take `startLine` "from the read output", the off-by-one
 * propagated into every edit's line arithmetic.
 */
describe("splitLines", () => {
  test("a trailing newline terminates the last line, it does not add one", () => {
    expect(splitLines("one\ntwo\nthree\n")).toEqual(["one", "two", "three"]);
  });

  test("content with no trailing newline is unchanged", () => {
    expect(splitLines("one\ntwo\nthree")).toEqual(["one", "two", "three"]);
  });

  test("a genuinely blank final line survives", () => {
    // "one\ntwo\n\n" is two lines plus one empty line, not a phantom.
    expect(splitLines("one\ntwo\n\n")).toEqual(["one", "two", ""]);
  });

  test("empty content has no lines", () => {
    expect(splitLines("")).toEqual([]);
  });

  test("single trailing newline is one line, not two", () => {
    expect(splitLines("only\n")).toEqual(["only"]);
  });
});

describe("selectLines on splitLines output", () => {
  test("totalLines and endLine agree with the real file length", () => {
    const selection = selectLines(splitLines("a\nb\nc\n"), {});
    expect(selection.startLine).toBe(1);
    expect(selection.endLine).toBe(3);
    expect(selection.truncated).toBe(false);
  });

  test("a tail read of a trailing-newline file lands on the real last line", () => {
    const selection = selectLines(splitLines("a\nb\nc\n"), { offset: -2 });
    expect(selection.lines).toEqual(["b", "c"]);
    expect(selection.endLine).toBe(3);
  });
});

describe("applyByteCeiling", () => {
  test("resume offset points past the window when only the line window cut", () => {
    const selection = selectLines(
      splitLines(Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n")),
      { limit: 4 },
    );
    const capped = applyByteCeiling(selection);
    expect(capped.lines).toHaveLength(4);
    expect(capped.truncated).toBe(true);
    expect(capped.nextOffset).toBe(5);
  });

  test("resume offset never points back at a line already returned", () => {
    // Guards the infinite-loop shape: nextOffset must always be strictly
    // greater than the last line actually kept.
    const selection = selectLines(
      splitLines(Array.from({ length: 6 }, (_, i) => `l-${i}`).join("\n")),
      { limit: 3 },
    );
    const capped = applyByteCeiling(selection);
    expect(capped.nextOffset).toBeGreaterThan(capped.endLine);
  });
});
