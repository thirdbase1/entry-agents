import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { getToolTimeoutMs } from "./tool-timeouts";

describe("getToolTimeoutMs", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("returns the default when no override is configured", () => {
    expect(getToolTimeoutMs("bash", 120_000)).toBe(120_000);
  });

  it("reads a numeric override from TOOL_TIMEOUT_<NAME>_MS", () => {
    process.env.TOOL_TIMEOUT_BASH_MS = "300000";
    expect(getToolTimeoutMs("bash", 120_000)).toBe(300_000);
  });

  it("matches the env key case-insensitively via the tool name", () => {
    process.env.TOOL_TIMEOUT_WEB_FETCH_MS = "60000";
    expect(getToolTimeoutMs("web_fetch", 30_000)).toBe(60_000);
  });

  it("ignores invalid overrides and falls back to the default", () => {
    for (const bad of ["", "   ", "abc", "0", "-5", "NaN"]) {
      process.env.TOOL_TIMEOUT_BASH_MS = bad;
      expect(getToolTimeoutMs("bash", 120_000)).toBe(120_000);
    }
  });
});
