import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

// MCP server headers (typically an Authorization value carrying a
// third-party API key) are the one genuinely sensitive part of a
// self-serve "paste any MCP server URL" config -- unlike the OAuth
// tokens better-auth already encrypts at rest for its own tables
// (encryptOAuthTokens: true in lib/auth/config.ts), these are
// arbitrary user-supplied secrets for a third-party service Entry has
// no relationship with. Encrypted here the same way, for the same
// reason: a DB dump or an overly-broad read query should never hand
// out a live third-party credential in plaintext.
//
// Deliberately reuses BETTER_AUTH_SECRET (already required, already
// treated as a secret, already rotated with the same operational care)
// via HKDF rather than requiring a brand new env var -- one less thing
// to configure, and HKDF's whole purpose is safely deriving multiple
// independent-looking keys from one secret without weakening either.

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const HKDF_INFO = "entry-agents:mcp-server-headers:v1";

function deriveKey(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET is required to encrypt/decrypt MCP server headers",
    );
  }

  return Buffer.from(hkdfSync("sha256", secret, "", HKDF_INFO, KEY_LENGTH));
}

/**
 * Encrypts a header map for storage in mcpServers.encryptedHeaders.
 * Returns null for an empty/undefined map -- servers with no auth
 * headers store null rather than an encrypted empty object.
 */
export function encryptMcpHeaders(
  headers: Record<string, string> | undefined,
): string | null {
  if (!headers || Object.keys(headers).length === 0) {
    return null;
  }

  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(headers), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // iv:authTag:ciphertext, each base64 -- self-contained, no separate
  // column needed for the IV/tag.
  return [iv, authTag, ciphertext]
    .map((buf) => buf.toString("base64"))
    .join(":");
}

/**
 * Decrypts a value produced by encryptMcpHeaders(). Only ever call
 * this server-side, immediately before opening an MCP connection --
 * never to render headers back to a client.
 */
export function decryptMcpHeaders(
  encrypted: string | null,
): Record<string, string> | undefined {
  if (!encrypted) {
    return undefined;
  }

  const [ivB64, authTagB64, ciphertextB64] = encrypted.split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted MCP header value");
  }

  const key = deriveKey();
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString("utf8")) as Record<string, string>;
}
