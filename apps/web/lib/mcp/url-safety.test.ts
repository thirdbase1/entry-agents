import { describe, expect, mock, test } from "bun:test";

// SECURITY REGRESSION TEST (2026-08-27, pentest finding): the previous
// hand-rolled isPrivateIpv6 in this file's implementation only pattern
// matched "::ffff:127.", "::ffff:10.", and "::ffff:169.254." prefixes,
// so a DNS answer of e.g. "::ffff:192.168.1.1" or "::ffff:172.16.0.1"
// (an IPv4-mapped-IPv6 address in a private range) sailed through as
// "public". Mock the DNS lookup so this is deterministic instead of
// depending on controlling a real domain's DNS records.
mock.module("node:dns/promises", () => ({
  lookup: async (hostname: string) => {
    if (hostname === "evil-ipv6-mapped-private.example.com") {
      return [{ address: "::ffff:192.168.1.1", family: 6 }];
    }
    if (hostname === "evil-ipv6-mapped-private-172.example.com") {
      return [{ address: "::ffff:172.16.0.1", family: 6 }];
    }
    if (
      hostname === "totally-public.example.com" ||
      hostname === "example.com"
    ) {
      return [{ address: "93.184.216.34", family: 4 }];
    }
    throw new Error(`unmocked hostname in test: ${hostname}`);
  },
}));

const { resolveAndAssertPublic, UnsafeMcpServerUrlError } =
  await import("./url-safety");

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

  test("rejects a hostname whose DNS answer is an IPv4-mapped IPv6 address in a private range (192.168.x.x)", async () => {
    await expect(
      resolveAndAssertPublic("http://evil-ipv6-mapped-private.example.com/mcp"),
    ).rejects.toThrow(UnsafeMcpServerUrlError);
  });

  test("rejects a hostname whose DNS answer is an IPv4-mapped IPv6 address in a private range (172.16.x.x)", async () => {
    await expect(
      resolveAndAssertPublic(
        "http://evil-ipv6-mapped-private-172.example.com/mcp",
      ),
    ).rejects.toThrow(UnsafeMcpServerUrlError);
  });

  test("allows a hostname whose DNS answer is a genuinely public IPv4 address", async () => {
    await expect(
      resolveAndAssertPublic("http://totally-public.example.com/mcp"),
    ).resolves.toBeUndefined();
  });
});
