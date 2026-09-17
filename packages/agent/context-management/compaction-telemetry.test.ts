import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { createInertPlaceholderModel } from "../models";
import {
  AUTO_COMPACT_THRESHOLD,
  maybeCompactMessages,
  PROTECTED_RECENT_MESSAGES,
} from "./auto-compact";
import {
  emitCompactionEvent,
  runWithCompactionSink,
  type CompactionEvent,
} from "./compaction-telemetry";

const model = createInertPlaceholderModel("unknown-model-x" as never);

/** Message history large enough to cross the compaction threshold. */
function buildOversizedHistory(): ModelMessage[] {
  const messages: ModelMessage[] = [];
  // Seed enough messages to get past PROTECTED_RECENT_MESSAGES before
  // the bulky tool results (the tail N are protected, not compacted).
  // 48 iterations x ~9K-char tool results ≈ ~126K estimated tokens,
  // past the 95% line of the 128K default window (~121.6K).
  for (let i = 0; i < 48; i++) {
    messages.push({ role: "user", content: `message ${i}` });
    // ~5K chars per tool result ≈ ~1.3K tokens; 60 of these ≈ ~80K tokens
    messages.push({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: `call-${i}`, toolName: "read", input: { path: `file-${i}.ts` } },
      ],
    });
    messages.push({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call-${i}`,
          toolName: "read",
          output: { type: "text", value: "x".repeat(9000) },
        },
      ],
    });
  }
  return messages;
}

test("AUTO_COMPACT_THRESHOLD is 0.95 (owner change 2026-09-17)", () => {
  expect(AUTO_COMPACT_THRESHOLD).toBe(0.95);
});

test("emitCompactionEvent no-ops without a sink and never throws", () => {
  expect(() => {
    emitCompactionEvent({
      preCompactTokens: 1,
      postCompactTokens: 1,
      contextWindowTokens: 1,
      threshold: 0.95,
      compactedToolCalls: 0,
      compactedAnonymousToolResults: 0,
      modelId: "test",
    });
  }).not.toThrow();
});

test("oversized history compacts and reports through the in-scope sink", async () => {
  const events: CompactionEvent[] = [];
  const history = buildOversizedHistory();
  expect(history.length).toBeGreaterThan(PROTECTED_RECENT_MESSAGES);

  let result: ModelMessage[] = [];
  await runWithCompactionSink(async (event) => {
    events.push(event);
  }, async () => {
    result = maybeCompactMessages({ messages: history, model });
  });

  // Compaction actually fired -- payloads collapsed in place, so the
  // serialized footprint must shrink (message count may stay equal).
  expect(JSON.stringify(result).length).toBeLessThan(
    JSON.stringify(history).length,
  );
  // ...exactly once, and with sensible payloads.
  expect(events.length).toBe(1);
  const ev = events[0];
  expect(ev).toBeDefined();
  if (!ev) throw new Error("no compaction event captured");
  expect(ev.threshold).toBe(AUTO_COMPACT_THRESHOLD);
  expect(ev.preCompactTokens).toBeGreaterThan(ev.postCompactTokens);
  expect(ev.contextWindowTokens).toBeGreaterThan(0);
  expect(ev.modelId).toBe("unknown-model-x");
});

test("small history compacts nothing and reports nothing", async () => {
  const events: CompactionEvent[] = [];
  const history: ModelMessage[] = Array.from({ length: PROTECTED_RECENT_MESSAGES + 10 }, (_, i) => ({
    role: "user" as const,
    content: `tiny message ${i}`,
  }));

  let result: ModelMessage[] = [];
  await runWithCompactionSink(async (event) => {
    events.push(event);
  }, async () => {
    result = maybeCompactMessages({ messages: history, model });
  });

  expect(result.length).toBe(history.length);
  expect(events.length).toBe(0);
});

test("sink failures are swallowed and do not break compaction", async () => {
  const history = buildOversizedHistory();
  let result: ModelMessage[] = [];
  await runWithCompactionSink(async () => {
    throw new Error("sink exploded");
  }, async () => {
    result = maybeCompactMessages({ messages: history, model });
  });

  // Compaction still completed even though the sink rejected.
  expect(JSON.stringify(result).length).toBeLessThan(
    JSON.stringify(history).length,
  );
});
