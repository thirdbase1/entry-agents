import { isAllowedWebUrl, isPrivateHost } from "@open-agents/agent";
import { lookup } from "node:dns/promises";

// MCP connections in the self-serve "paste any MCP server URL" path
// are opened directly from this Next.js server (not from inside a
// user sandbox, unlike web_fetch) -- so a malicious/misconfigured URL
// is a direct SSRF vector against Entry's own infrastructure, not just
// the public internet. Two layers:
//
// 1. isAllowedWebUrl (shared with web_fetch): rejects non-http(s) and
//    hostnames that are *already* an obviously private/loopback
//    literal at write time.
// 2. resolveAndAssertPublic: re-resolves DNS right before actually
//    connecting and rejects if ANY resolved address is private --
//    closes the DNS-rebinding gap where a hostname that looked public
//    at save-time later resolves to an internal address.
//
// SECURITY FIX (2026-08-27, pentest finding): this file used to carry
// its own hand-rolled isPrivateIpv4/isPrivateIpv6 instead of reusing
// web_fetch's isPrivateHost. Its IPv6 check only pattern-matched
// "::ffff:127.", "::ffff:10.", and "::ffff:169.254." prefixes, so an
// attacker-controlled domain with an AAAA record like
// "::ffff:192.168.1.1" or "::ffff:172.16.0.1" sailed through as
// "public" even though it's an IPv4-mapped private address. Now reuses
// the single, properly bitwise-parsed isPrivateHost from
// packages/agent/tools/fetch.ts (also used by the web_fetch tool) so
// there's one source of truth for "is this address private" instead
// of two implementations that can silently drift apart.
//
// This is a time-of-check, not a fully IP-pinned connection -- a
// narrow TOCTOU window between this check and the MCP client's own
// connect remains (same residual class of risk most SSRF guards
// accept without a custom IP-pinned dispatcher). Revisit with an
// IP-pinned fetch/dispatcher if this ever looks like a real attack
// surface in practice rather than a theoretical one.

export class UnsafeMcpServerUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeMcpServerUrlError";
  }
}

/**
 * Throws UnsafeMcpServerUrlError if the URL is malformed, non-http(s),
 * or resolves (right now) to any private/loopback/link-local address.
 * Call this at both save-time and immediately before every connection
 * attempt -- DNS answers can change between the two.
 */
export async function resolveAndAssertPublic(url: string): Promise<void> {
  if (!isAllowedWebUrl(url)) {
    throw new UnsafeMcpServerUrlError(
      "URL must be http(s) and point at a public host",
    );
  }

  const { hostname } = new URL(url);

  let addresses: string[];
  try {
    const results = await lookup(hostname, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    throw new UnsafeMcpServerUrlError(`Could not resolve host: ${hostname}`);
  }

  if (addresses.length === 0 || addresses.some((addr) => isPrivateHost(addr))) {
    throw new UnsafeMcpServerUrlError(
      "URL resolves to a private or internal address",
    );
  }
}
