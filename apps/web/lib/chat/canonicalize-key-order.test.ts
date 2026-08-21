import { describe, expect, test } from "bun:test";
import {
  canonicalizeKeyOrder,
  canonicalizeMessageParts,
} from "./canonicalize-key-order";
import type { WebAgentUIMessage } from "@/app/types";

describe("canonicalizeKeyOrder", () => {
  test("sorts object keys alphabetically at every level", () => {
    const input: Record<string, unknown> = {
      zebra: 1,
      apple: 2,
      nested: { z: 1, a: 2, m: { y: 1, b: 2 } },
    };

    expect(canonicalizeKeyOrder(input)).toEqual({
      apple: 2,
      nested: { a: 2, m: { b: 2, y: 1 }, z: 1 },
      zebra: 1,
    });
    expect(Object.keys(canonicalizeKeyOrder(input))).toEqual([
      "apple",
      "nested",
      "zebra",
    ]);
  });

  test("preserves array element order", () => {
    const input = [
      { b: 1, a: 2 },
      { d: 3, c: 4 },
    ];
    const result = canonicalizeKeyOrder(input);
    expect(result).toEqual([
      { a: 2, b: 1 },
      { c: 4, d: 3 },
    ]);
    expect(result[0]).toEqual({ a: 2, b: 1 });
    expect(result[1]).toEqual({ c: 4, d: 3 });
  });

  test("two logically-identical objects with different key insertion order serialize identically after canonicalization", () => {
    const a = { type: "tool-call", input: { path: "x", content: "y" } };
    const b = { input: { content: "y", path: "x" }, type: "tool-call" };

    expect(JSON.stringify(canonicalizeKeyOrder(a))).toBe(
      JSON.stringify(canonicalizeKeyOrder(b)),
    );
  });

  test("leaves primitives, null, and dates untouched", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    expect(canonicalizeKeyOrder(42)).toBe(42);
    expect(canonicalizeKeyOrder("hello")).toBe("hello");
    expect(canonicalizeKeyOrder(null)).toBeNull();
    expect(canonicalizeKeyOrder(date)).toBe(date);
  });
});

describe("canonicalizeMessageParts", () => {
  test("canonicalizes parts but leaves other message fields untouched", () => {
    const message: WebAgentUIMessage = {
      id: "msg_1",
      role: "assistant",
      metadata: undefined as never,
      parts: [
        {
          type: "tool-invocation" as never,
          toolCallId: "call_1",
          input: { zebra: 1, apple: 2 },
        } as never,
      ],
    };

    const result = canonicalizeMessageParts(message);
    expect(result.id).toBe("msg_1");
    expect(result.role).toBe("assistant");
    expect(JSON.stringify(result.parts)).toBe(
      JSON.stringify(canonicalizeKeyOrder(message.parts)),
    );
  });
});
