import type { WebAgentUIMessage } from "@/app/types";

/**
 * Deeply rebuilds an arbitrary JSON-compatible value with object keys sorted
 * alphabetically at every level. Arrays keep their original element order
 * (order is semantically meaningful there); only object *key* order changes,
 * which JSON semantics never assign meaning to.
 *
 * WHY THIS EXISTS (found 2026-08-21 investigating why gpt-5.6-* FreeModel
 * calls were nowhere near the >70% cache-hit target despite growing
 * conversation history that should be a byte-stable, cacheable prefix):
 * Postgres `jsonb` does NOT preserve object key insertion order on
 * round-trip -- confirmed directly: inserting
 * `{"zebra":1,"apple":2,"mango":3,"banana":4,"tool_call_id":"x","type":"y","input":{...}}`
 * and reading it back reordered the top-level keys to
 * `{"type":...,"apple":...,"input":...,"mango":...,"zebra":...,"banana":...,"tool_call_id":...}`
 * -- an internal storage order, unrelated to insertion or alphabetical
 * order. `chat_messages.parts` is a `jsonb` column, and any tool-call
 * `input` / tool-result `output` object nested in a message's parts is
 * exactly the kind of object this reorders.
 *
 * Every chat turn resends the *entire* prior message history to the model
 * (see `convertMessages` in app/workflows/chat.ts) -- OpenAI-style
 * implicit/automatic prompt caching for gpt-5.6-* is a byte-exact PREFIX
 * match. If a single nested object's key order differs from how it was
 * serialized the first time (e.g. because that message was hydrated from
 * a jsonb column on a page load/resume rather than kept in the same
 * in-memory JS object that originally produced the tool call), the
 * serialized JSON text at that point differs, and every token from there
 * onward in that request misses cache -- even though the *content* is
 * identical. This exactly matched production data: cache-hit ratio
 * fluctuated wildly turn-to-turn within the same session (0% right next
 * to 70-90%) with no correlation to elapsed time, which pointed at a
 * structural serialization gap rather than TTL/routing luck.
 *
 * Fix: canonicalize (deep, alphabetical key sort) every message's `parts`
 * right before handing them to `convertToModelMessages`, regardless of
 * whether that message just came fresh from the model or was reloaded
 * from the database. As long as the SAME canonicalization is applied
 * every time, the serialized bytes are deterministic and stable across
 * storage round-trips, so the prefix matches request after request.
 */
export function canonicalizeKeyOrder<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeKeyOrder(item)) as unknown as T;
  }

  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalizeKeyOrder(
        (value as Record<string, unknown>)[key],
      );
    }
    return result as unknown as T;
  }

  return value;
}

/**
 * Applies `canonicalizeKeyOrder` to a message's `parts` array only --
 * leaves `role`, `id`, `metadata`, etc. untouched (those aren't serialized
 * into the model-facing prompt content the same way, and metadata like
 * `id` ordering is irrelevant to this fix's purpose).
 */
export function canonicalizeMessageParts(
  message: WebAgentUIMessage,
): WebAgentUIMessage {
  return {
    ...message,
    parts: canonicalizeKeyOrder(message.parts),
  };
}
