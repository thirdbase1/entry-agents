import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const sandboxRegistry = new Map<string, Record<string, unknown>>();

mock.module("ai", () => ({
  tool: <T extends Record<string, unknown>>(definition: T) => definition,
}));

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: async (state: { sandboxId?: string }) => {
    if (!state.sandboxId) {
      throw new Error("Missing sandboxId in test sandbox state.");
    }
    const sandbox = sandboxRegistry.get(state.sandboxId);
    if (!sandbox) {
      throw new Error(`Unknown test sandbox: ${state.sandboxId}`);
    }
    return sandbox;
  },
}));

const { readFileTool } = await import("./read");

type ReadCcResult = {
  success: boolean;
  path: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  contentHash: string;
  content: string;
  truncated?: boolean;
  nextOffset?: number | null;
  unchanged?: boolean;
  error?: string;
};
const { resetReadDedupStoreForTests } = await import("./read-ceilings");

const workingDirectory = await mkdtemp(path.join(tmpdir(), "read-cc-"));

function createContext() {
  const sandboxId = `sandbox-${sandboxRegistry.size + 1}`;
  sandboxRegistry.set(sandboxId, {
    workingDirectory,
    stat: (p: string) => stat(p),
    readFile: (p: string, encoding: string) =>
      readFile(p, { encoding: encoding as "utf-8" }),
  });

  return {
    sandbox: {
      state: { type: "vercel" as const, sandboxId },
      workingDirectory,
    },
    model: "test-model",
  } as never;
}

describe("readFileTool Command Code upgrades", () => {
  test("negative offset reads the tail", async () => {
    resetReadDedupStoreForTests();
    const p = path.join(workingDirectory, "tail.txt");
    await writeFile(
      p,
      Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join("\n"),
      "utf-8",
    );
    const result = (await readFileTool().execute?.(
      { filePath: p, offset: -10 },
      {
        toolCallId: "tc-1",
        messages: [],
        experimental_context: createContext(),
      } as never,
    )) as ReadCcResult;
    expect(result).toMatchObject({
      success: true,
      startLine: 91,
      endLine: 100,
    });
    expect(result.content).toContain("line-91");
    expect(result.content).toContain("line-100");
  });

  test("huge single line is clamped, not dumped", async () => {
    resetReadDedupStoreForTests();
    const p = path.join(workingDirectory, "bundle.js");
    await writeFile(p, "x".repeat(20_000), "utf-8");
    const result = (await readFileTool().execute?.(
      { filePath: p },
      {
        toolCallId: "tc-1",
        messages: [],
        experimental_context: createContext(),
      } as never,
    )) as ReadCcResult;
    expect(result.success).toBe(true);
    expect(result.content).toContain("[line clamped:");
    expect(result.content.length).toBeLessThan(5_000);
  });

  test("unchanged re-read returns the cheap notice, then content again", async () => {
    resetReadDedupStoreForTests();
    const p = path.join(workingDirectory, "dedup.txt");
    await writeFile(p, "stable", "utf-8");

    const first = (await readFileTool().execute?.(
      { filePath: p },
      {
        toolCallId: "tc-1",
        messages: [],
        experimental_context: createContext(),
      } as never,
    )) as ReadCcResult;
    expect(first.content).toContain("stable");

    const second = (await readFileTool().execute?.(
      { filePath: p },
      {
        toolCallId: "tc-1",
        messages: [],
        experimental_context: createContext(),
      } as never,
    )) as ReadCcResult;
    expect(second.unchanged).toBe(true);
    expect(second.content).toContain("unchanged since your previous read");

    const third = (await readFileTool().execute?.(
      { filePath: p },
      {
        toolCallId: "tc-1",
        messages: [],
        experimental_context: createContext(),
      } as never,
    )) as ReadCcResult;
    expect(third.content).toContain("stable");
  });

  test("empty file returns a success note, not an error", async () => {
    resetReadDedupStoreForTests();
    const p = path.join(workingDirectory, "empty.txt");
    await writeFile(p, "", "utf-8");
    const result = (await readFileTool().execute?.(
      { filePath: p },
      {
        toolCallId: "tc-1",
        messages: [],
        experimental_context: createContext(),
      } as never,
    )) as ReadCcResult;
    expect(result).toMatchObject({ success: true, totalLines: 0 });
    expect(result.content).toContain("empty");
  });

  test("binary file returns a recovery note", async () => {
    resetReadDedupStoreForTests();
    const p = path.join(workingDirectory, "blob.bin");
    await writeFile(p, `text\x00binary\x00junk`, "utf-8");
    const result = (await readFileTool().execute?.(
      { filePath: p },
      {
        toolCallId: "tc-1",
        messages: [],
        experimental_context: createContext(),
      } as never,
    )) as ReadCcResult;
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("grep -a");
  });

  test("device paths are refused before any I/O", async () => {
    const result = (await readFileTool().execute?.(
      { filePath: "/dev/zero" },
      {
        toolCallId: "tc-1",
        messages: [],
        experimental_context: createContext(),
      } as never,
    )) as ReadCcResult;
    expect(result).toMatchObject({ success: false });
    expect(result.error).toContain("refused");
  });

  test("truncated long read precomputes nextOffset", async () => {
    resetReadDedupStoreForTests();
    const p = path.join(workingDirectory, "long.txt");
    await writeFile(
      p,
      Array.from({ length: 50 }, (_, i) => `row-${i + 1}`).join("\n"),
      "utf-8",
    );
    const result = (await readFileTool().execute?.(
      { filePath: p, limit: 10 },
      {
        toolCallId: "tc-1",
        messages: [],
        experimental_context: createContext(),
      } as never,
    )) as ReadCcResult;
    expect(result).toMatchObject({
      success: true,
      truncated: true,
      nextOffset: 11,
    });
  });
});
