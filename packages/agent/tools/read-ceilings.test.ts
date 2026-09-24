import { describe, expect, test } from "bun:test";

import {
  READ_BYTE_CEILING,
  READ_MAX_LINE_CHARS,
  applyByteCeiling,
  clampLine,
  checkUnchangedRead,
  hashFileContent,
  isDevicePath,
  isLikelyBinary,
  normalizeFileContent,
  recordRead,
  resetReadDedupStoreForTests,
  selectLines,
} from "./read-ceilings";

describe("read ceilings (Command Code read-tool model)", () => {
  test("normalizeFileContent strips BOM and normalizes CRLF", () => {
    expect(normalizeFileContent("\uFEFFa\r\nb\r\n")).toBe("a\nb\n");
    expect(normalizeFileContent("a\nb")).toBe("a\nb");
  });

  test("isLikelyBinary detects NUL bytes in the head", () => {
    expect(isLikelyBinary("plain text\nwith lines")).toBe(false);
    expect(isLikelyBinary(`text\x00more`.repeat(1))).toBe(true);
    expect(isLikelyBinary(`${"x".repeat(9000)}\x00buried-past-8k`)).toBe(
      false,
    );
  });

  test("isDevicePath refuses /dev and /proc/N/fd before any I/O", () => {
    for (const p of [
      "/dev/zero",
      "/dev/stdin",
      "/dev/random",
      "/dev/sda1",
      "/proc/42/fd/3",
    ]) {
      expect(isDevicePath(p)).toBe(true);
    }
    for (const p of [
      "/home/user/dev/zero.txt",
      "/repo/proc-file.ts",
      "src/dev.ts",
    ]) {
      expect(isDevicePath(p)).toBe(false);
    }
  });

  test("clampLine clamps hostile single lines with a visible marker", () => {
    const long = "a".repeat(READ_MAX_LINE_CHARS + 500);
    const { line, clampedChars } = clampLine(long);
    expect(clampedChars).toBe(500);
    expect(line).toContain("[line clamped: 500 more chars]");
    expect(clampLine("short").clampedChars).toBe(0);
  });

  test("selectLines: positive offset reads forward within the window", () => {
    const lines = ["l1", "l2", "l3", "l4", "l5"];
    const sel = selectLines(lines, { offset: 2, limit: 2 });
    expect(sel.lines).toEqual(["l2", "l3"]);
    expect(sel.startLine).toBe(2);
    expect(sel.endLine).toBe(3);
    expect(sel.truncated).toBe(true);
  });

  test("selectLines: negative offset reads the tail", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `l${i + 1}`);
    const sel = selectLines(lines, { offset: -50 });
    expect(sel.lines.length).toBe(50);
    expect(sel.lines[0]).toBe("l51");
    expect(sel.lines[49]).toBe("l100");
    expect(sel.truncated).toBe(false);
  });

  test("selectLines: offset -50 with limit 10 reads the last 10", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `l${i + 1}`);
    const sel = selectLines(lines, { offset: -50, limit: 10 });
    expect(sel.lines.length).toBe(10);
    expect(sel.lines[0]).toBe("l51");
  });

  test("selectLines: full file within window is not truncated", () => {
    const sel = selectLines(["a", "b"]);
    expect(sel.truncated).toBe(false);
    expect(sel.startLine).toBe(1);
    expect(sel.endLine).toBe(2);
  });

  test("applyByteCeiling cuts wide content and precomputes the resume offset", () => {
    const lines = ["x".repeat(50_000), "y".repeat(50_000), "z".repeat(50_000)];
    const sel = selectLines(lines, {});
    expect(sel.truncated).toBe(false);

    const capped = applyByteCeiling(sel);
    expect(capped.lines.length).toBe(2); // 2 x 50KB fits 128KB, 3rd doesn't
    expect(capped.truncated).toBe(true);
    expect(capped.nextOffset).toBe(3);
    expect(capped.lines.join("\n").length).toBeLessThanOrEqual(
      READ_BYTE_CEILING,
    );
  });

  test("applyByteCeiling returns nextOffset null when nothing was cut", () => {
    const sel = selectLines(["a", "b", "c"]);
    expect(applyByteCeiling(sel).nextOffset).toBeNull();
  });

  test("unchanged-read dedup consumes itself on hit", () => {
    resetReadDedupStoreForTests();
    const key = "wd:/repo/src/a.ts";
    const hash = hashFileContent("stable content");

    expect(checkUnchangedRead(key, hash)).toBe(false); // first read: no
    recordRead(key, hash);

    expect(checkUnchangedRead(key, hash)).toBe(true); // re-read: unchanged
    expect(checkUnchangedRead(key, hash)).toBe(false); // consumed: full again
  });

  test("dedup misses when content changed", () => {
    resetReadDedupStoreForTests();
    const key = "wd:/repo/b.ts";
    recordRead(key, hashFileContent("v1"));
    expect(checkUnchangedRead(key, hashFileContent("v2"))).toBe(false);
  });

  test("dedup keys are per-path", () => {
    resetReadDedupStoreForTests();
    const hash = hashFileContent("same");
    recordRead("wd:/repo/c.ts", hash);
    expect(checkUnchangedRead("wd:/repo/d.ts", hash)).toBe(false);
  });
});
