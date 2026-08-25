import { isAllowedWebUrl } from "@open-agents/agent";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
// This is a time-of-check, not a fully IP-pinned connection -- a
// narrow TOCTOU window between this check and the MCP client's own
// connect remains (same residual class of risk most SSRF guards
// accept without a custom IP-pinned dispatcher). Revisit with an
// IP-pinned fetch/dispatcher if this ever looks like a real attack
// surface in practice rather than a theoretical one.

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fe80:") || // link-local
    normalized.startsWith("fc") || // unique local (fc00::/7)
    normalized.startsWith("fd") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:169.254.")
  );
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return isPrivateIpv4(address);
  }
  if (version === 6) {
    return isPrivateIpv6(address);
  }
  return true; // not a recognizable literal IP -- treat as unsafe
}

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

  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new UnsafeMcpServerUrlError(
      "URL resolves to a private or internal address",
    );
  }
}
