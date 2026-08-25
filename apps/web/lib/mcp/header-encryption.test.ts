import { describe, expect, test } from "bun:test";
import { decryptMcpHeaders, encryptMcpHeaders } from "./header-encryption";

process.env.BETTER_AUTH_SECRET ??= "test-secret-do-not-use-in-prod";

describe("encryptMcpHeaders / decryptMcpHeaders", () => {
  test("round-trips a header map", () => {
    const headers = { Authorization: "Bearer sk-test-123" };
    const encrypted = encryptMcpHeaders(headers);
    expect(encrypted).not.toBeNull();
    expect(encrypted).not.toContain("sk-test-123");
    expect(decryptMcpHeaders(encrypted)).toEqual(headers);
  });

  test("returns null for undefined or empty headers", () => {
    expect(encryptMcpHeaders(undefined)).toBeNull();
    expect(encryptMcpHeaders({})).toBeNull();
  });

  test("decryptMcpHeaders returns undefined for null input", () => {
    expect(decryptMcpHeaders(null)).toBeUndefined();
  });

  test("throws on malformed ciphertext instead of returning garbage", () => {
    expect(() => decryptMcpHeaders("not-a-real-ciphertext")).toThrow();
  });

  test("tampering with ciphertext is detected (GCM auth tag)", () => {
    const encrypted = encryptMcpHeaders({ "X-Api-Key": "secret" });
    const tampered = `${encrypted?.slice(0, -4)}abcd`;
    expect(() => decryptMcpHeaders(tampered)).toThrow();
  });
});
