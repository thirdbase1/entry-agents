import { describe, expect, test } from "bun:test";
import { resolveAndAssertPublic, UnsafeMcpServerUrlError } from "./url-safety";

describe("resolveAndAssertPublic", () => {
  test("rejects non-http(s) protocols", async () => {
    await expect(resolveAndAssertPublic("ftp://example.com")).rejects.toThrow(
      UnsafeMcpServerUrlError,
    );
  });

  test("rejects an obviously private literal host at write time", async () => {
    await expect(
      resolveAndAssertPublic("http://localhost:1234/mcp"),
    ).rejects.toThrow(UnsafeMcpServerUrlError);
    await expect(
      resolveAndAssertPublic("http://127.0.0.1/mcp"),
    ).rejects.toThrow(UnsafeMcpServerUrlError);
    await expect(
      resolveAndAssertPublic("http://169.254.169.254/latest/meta-data"),
    ).rejects.toThrow(UnsafeMcpServerUrlError);
    await expect(resolveAndAssertPublic("http://10.0.0.5/mcp")).rejects.toThrow(
      UnsafeMcpServerUrlError,
    );
    await expect(
      resolveAndAssertPublic("http://192.168.1.1/mcp"),
    ).rejects.toThrow(UnsafeMcpServerUrlError);
  });

  test("rejects a hostname that fails to resolve", async () => {
    await expect(
      resolveAndAssertPublic(
        "http://this-domain-should-not-exist-entry-mcp-test.invalid/mcp",
      ),
    ).rejects.toThrow(UnsafeMcpServerUrlError);
  });

  test("allows a real public host", async () => {
    await expect(
      resolveAndAssertPublic("https://example.com/mcp"),
    ).resolves.toBeUndefined();
  });
});
