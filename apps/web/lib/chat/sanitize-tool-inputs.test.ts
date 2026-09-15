import { describe, expect, it } from "bun:test";
import { sanitizeToolInputs } from "./sanitize-tool-inputs";
import type { WebAgentUIMessage } from "@/app/types";

function msg(parts: unknown[]): WebAgentUIMessage {
  return { id: "m1", role: "assistant", parts: parts as never } as WebAgentUIMessage;
}

describe("sanitizeToolInputs", () => {
  it("leaves valid tool inputs untouched", () => {
    const part = {
      type: "tool-bash",
      toolCallId: "call_1",
      state: "output-available",
      input: { command: "ls" },
    };
    const out = sanitizeToolInputs([msg([part])]);
    expect(out[0].parts[0] as unknown).toBe(part as unknown);
  });

  it("repairs a truncated-rawInput output-error part with {}", () => {
    // Exact shape of the 2026-09-14 incident: input never materialized,
    // rawInput is a truncated invalid JSON string.
    const part = {
      type: "tool-bash",
      toolCallId: "call_2",
      state: "output-error",
      rawInput: '{"command": "ls -la && cat package.json 2',
      errorText: "Something went wrong",
    };
    const out = sanitizeToolInputs([msg([part])]);
    const repaired = out[0].parts[0] as Record<string, unknown>;
    expect(repaired.input).toEqual({});
  });

  it("parses a valid rawInput string into input", () => {
    const part = {
      type: "tool-read",
      toolCallId: "call_3",
      state: "output-error",
      rawInput: '{"filePath":"a.ts"}',
      errorText: "boom",
    };
    const out = sanitizeToolInputs([msg([part])]);
    const repaired = out[0].parts[0] as Record<string, unknown>;
    expect(repaired.input).toEqual({ filePath: "a.ts" });
  });

  it("promotes a parsed-object rawInput to input", () => {
    const part = {
      type: "tool-todo_write",
      toolCallId: "call_4",
      state: "output-error",
      rawInput: { todos: [] },
      errorText: "boom",
    };
    const out = sanitizeToolInputs([msg([part])]);
    const repaired = out[0].parts[0] as Record<string, unknown>;
    expect(repaired.input).toEqual({ todos: [] });
  });

  it("repairs a missing-input output-available part", () => {
    const part = {
      type: "tool-grep",
      toolCallId: "call_5",
      state: "output-available",
      output: { found: 0 },
    };
    const out = sanitizeToolInputs([msg([part])]);
    const repaired = out[0].parts[0] as Record<string, unknown>;
    expect(repaired.input).toEqual({});
  });

  it("handles dynamic-tool parts and ignores non-tool parts", () => {
    const dynamic = {
      type: "dynamic-tool",
      toolCallId: "call_6",
      state: "output-error",
      rawInput: "not json at all",
    };
    const text = { type: "text", text: "hello" };
    const out = sanitizeToolInputs([msg([dynamic, text])]);
    const repaired = out[0].parts[0] as Record<string, unknown>;
    expect(repaired.input).toEqual({});
    expect(out[0].parts[1] as unknown).toBe(text as unknown);
  });

  it("does not mutate messages without tool parts", () => {
    const original = msg([{ type: "text", text: "hi" }]);
    const out = sanitizeToolInputs([original]);
    expect(out[0]).toBe(original);
  });
});
