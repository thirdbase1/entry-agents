import { describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { createReadFileState, rebuildReadFileState } from "./read-state";

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: async (state: {
    sandboxId?: string;
    workingDirectory?: string;
  }) => {
    const workingDirectory = state.workingDirectory ?? "/repo";
    return {
      workingDirectory,
      stat: (p: string) => stat(p),
      readFile: (p: string, e: BufferEncoding) => readFile(p, { encoding: e }),
      writeFile: (p: string, c: string, e: BufferEncoding) =>
        writeFile(p, c, { encoding: e }),
      mkdir: (d: string, o?: { recursive?: boolean }) => mkdir(d, o),
    };
  },
}));

const { readFileTool } = await import("./read");
const { editFileTool, writeFileTool } = await import("./write");

function executionOptions(experimental_context: unknown) {
  return { toolCallId: "tool-call-1", messages: [], experimental_context };
}

/**
 * Builds the shape the AI SDK hands prepareStep on a later step: a
 * ModelMessage whose tool content carries the raw tool output object.
 * Cast once, here, instead of sprinkling `as` through every test.
 */
function toolResultMessage(toolName: string, output: unknown): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call-1", toolName, output }],
  } as unknown as ModelMessage;
}

function contextFor(workingDirectory: string) {
  return {
    sandbox: {
      state: { type: "vercel" as const, sandboxId: "x", workingDirectory },
      workingDirectory,
    },
    model: "test-model",
    readFileState: createReadFileState(),
  };
}

describe("read gate lifecycle", () => {
  test("in-step: read then edit succeeds", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gate-"));
    await writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree", "utf-8");
    const context = contextFor(dir);
    await readFileTool().execute?.(
      { filePath: "a.txt" },
      executionOptions(context),
    );
    const edit = await editFileTool().execute?.(
      { filePath: "a.txt", oldString: "two", newString: "TWO" },
      executionOptions(context),
    );
    expect(edit).toMatchObject({ success: true });
  });

  test("cross-step: rebuild from the read tool-result restores the gate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gate-"));
    await writeFile(path.join(dir, "b.txt"), "alpha\nbeta\nomega", "utf-8");
    const read = await readFileTool().execute?.(
      { filePath: "b.txt" },
      executionOptions(contextFor(dir)),
    );
    const rebuilt = rebuildReadFileState(
      [toolResultMessage("read", read)],
      createReadFileState(),
    );
    const edit = await editFileTool().execute?.(
      { filePath: "b.txt", oldString: "beta", newString: "BETA" },
      executionOptions({ ...contextFor(dir), readFileState: rebuilt }),
    );
    expect(edit).toMatchObject({ success: true });
  });

  test("write then edit without an intervening read is allowed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gate-"));
    const context = contextFor(dir);
    await writeFileTool().execute?.(
      { filePath: "fresh.txt", content: "hello\nworld" },
      executionOptions(context),
    );
    const edit = await editFileTool().execute?.(
      { filePath: "fresh.txt", oldString: "hello", newString: "HELLO" },
      executionOptions(context),
    );
    expect(edit).toMatchObject({ success: true });
  });

  test("REGRESSION: re-reading a DIFFERENT range returns those lines, not the notice", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gate-"));
    await writeFile(
      path.join(dir, "d.txt"),
      "one\ntwo\nthree\nfour\nfive",
      "utf-8",
    );
    const context = contextFor(dir);

    await readFileTool().execute?.(
      { filePath: "d.txt" },
      executionOptions(context),
    );
    const ranged = await readFileTool().execute?.(
      { filePath: "d.txt", offset: 4, limit: 2 },
      executionOptions(context),
    );

    expect(ranged).toMatchObject({ success: true });
    expect((ranged as { unchanged?: boolean }).unchanged).toBeUndefined();
    expect((ranged as { content: string }).content).toContain("4: four");
    expect((ranged as { content: string }).content).toContain("5: five");
    expect((ranged as { content: string }).content).not.toContain("1: one");
  });

  test("re-reading the SAME range still short-circuits to the notice", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gate-"));
    await writeFile(path.join(dir, "e.txt"), "one\ntwo\nthree", "utf-8");
    const context = contextFor(dir);

    await readFileTool().execute?.(
      { filePath: "e.txt" },
      executionOptions(context),
    );
    const again = await readFileTool().execute?.(
      { filePath: "e.txt" },
      executionOptions(context),
    );

    expect(again).toMatchObject({ success: true, unchanged: true });
  });
});
