import { describe, expect, test } from "bun:test";
import { getMigrationRetryBackoffMs } from "./migration-backoff";

describe("getMigrationRetryBackoffMs", () => {
  test("starts at the base delay on the first failure", () => {
    expect(getMigrationRetryBackoffMs(1)).toBe(30 * 1000);
  });

  test("doubles per consecutive failure", () => {
    expect(getMigrationRetryBackoffMs(2)).toBe(60 * 1000);
    expect(getMigrationRetryBackoffMs(3)).toBe(120 * 1000);
  });

  test("caps at the configured max instead of growing unbounded", () => {
    expect(getMigrationRetryBackoffMs(4)).toBe(120 * 1000);
    expect(getMigrationRetryBackoffMs(10)).toBe(120 * 1000);
  });

  test("treats a failureCount below 1 the same as the first failure", () => {
    expect(getMigrationRetryBackoffMs(0)).toBe(30 * 1000);
  });
});
