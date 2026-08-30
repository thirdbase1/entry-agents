import { describe, expect, test } from "bun:test";
import { getContextWindowForModel } from "./context-windows";

describe("getContextWindowForModel", () => {
  test("glm-5.3-flash uses B.AI's documented 1M window, not the 128k fallback", () => {
    // Found 2026-08-30: glm-5.3-flash was missing from the table, so it
    // silently used DEFAULT_CONTEXT_WINDOW (128k) and auto-compaction
    // fired on every turn of a long session at "~200% of 128k" even
    // though the real window is 1M.
    expect(getContextWindowForModel("glm-5.3-flash")).toBe(1_000_000);
  });

  test("glm-5.2 keeps its separate reseller-cap value", () => {
    expect(getContextWindowForModel("glm-5.2")).toBe(200_000);
  });

  test("deepseek-v4-flash-vision-exp uses B.AI's documented 1M window", () => {
    expect(getContextWindowForModel("deepseek-v4-flash-vision-exp")).toBe(
      1_000_000,
    );
  });

  test("qwen3.8-flash uses the 256k native window", () => {
    expect(getContextWindowForModel("qwen3.8-flash")).toBe(256_000);
  });

  test("deepseek-v4-flash keeps its conservative 128k value", () => {
    expect(getContextWindowForModel("deepseek-v4-flash")).toBe(128_000);
  });

  test("unrecognized claude ids fall back to the safe 200k family floor", () => {
    expect(getContextWindowForModel("claude-opus-9-snapshot-2030")).toBe(
      200_000,
    );
  });

  test("fully unknown models use the conservative 128k default", () => {
    expect(getContextWindowForModel("totally-unknown-model")).toBe(128_000);
  });
});
