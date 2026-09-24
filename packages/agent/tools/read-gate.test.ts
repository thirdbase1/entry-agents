import { describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
const { editFileTool, writeFileTool } = await import("./write");
const { hashFileContent } = await import("./read-ceilings");
const { createReadFileState, rebuildReadFileState } = await import(
  "./read-state"
);

const workingDirectory = await mkdtemp(path.join(tmpdir(), "read-gate-"));

function createSandbox() {
  return {
    workingDirectory,
    stat: (p: string) => stat(p),
    readFile: (p: string, encoding: string) =>
      readFile(p, { encoding: encoding as BufferEncoding }),
    writeFile: (p: string, content: string, encoding: string) =>
      writeFile(p, content, { encoding: encoding as BufferEncoding }),
    mkdir: (dirPath: string, options: { recursive: boolean }) =>
      mkdir(dirPath, options),
  };
}

function createContext(sandbox: Record<string, unknown>) {
  const sandboxId = `gate-sandbox-${sandboxRegistry.size + 1}`;
  sandboxRegistry.set(sandboxId, sandbox);
  return {
    sandbox: {
      state: { type: "vercel" as const, sandboxId },
      workingDirectory,
    },
    readFileState: createReadFileState(),
    model: "test-model",
  } as never;
}

function executionOptions(experimental_context: unknown) {
  return {
    toolCallId: "tool-call-1",
    messages: [],
    experimental_context,
  } as never;
}

async function runRead(context: unknown, filePath: string) {
  return readFileTool().execute?.(
    { filePath },
    executionOptions(context),
  );
}

async function runEdit(
  context: unknown,
  filePath: string,
  oldString: string,
  newString: string,
) {
  return editFileTool().execute?.(
    { filePath, oldString, newString },
    executionOptions(context),
  );
}

async function runWrite(
  context: unknown,
  filePath: string,
  content: string,
) {
  return writeFileTool().execute?.(
    { filePath, content },
    executionOptions(context),
  );
}

describe("read-before-edit gate", () => {
  test("edit refuses a file that was never read", async () => {
    const sandbox = createSandbox();
    const context = createContext(sandbox);
    const filePath = path.join(workingDirectory, "unread.ts");
    await writeFile(filePath, "const a = 1;\n", "utf-8");

    const result = await runEdit(context, filePath, "const a = 1", "const a = 2");

    expect(result).toMatchObject({
      success: false,
      gate: "unread",
    });
    expect(
      (result as unknown as { error?: string } | undefined)?.error,
    ).toContain("File has not been read yet");
  });

  test("read then edit succeeds", async () => {
    const sandbox = createSandbox();
    const context = createContext(sandbox);
    const filePath = path.join(workingDirectory, "read-then-edit.ts");
    await writeFile(filePath, "const a = 1;\n", "utf-8");

    await runRead(context, filePath);
    const result = await runEdit(context, filePath, "const a = 1", "const a = 2");

    expect(result).toMatchObject({
      success: true,
      path: "read-then-edit.ts",
      contentHash: hashFileContent("const a = 2;\n"),
    });
    const onDisk = await readFile(filePath, "utf-8");
    expect(onDisk).toBe("const a = 2;\n");
  });

  test("edit is refused when the file changed out-of-band after the read", async () => {
    const sandbox = createSandbox();
    const context = createContext(sandbox);
    const filePath = path.join(workingDirectory, "stale.ts");
    await writeFile(filePath, "const a = 1;\n", "utf-8");

    await runRead(context, filePath);

    // Out-of-band modification (bash sed, git checkout, subagent...)
    await writeFile(filePath, "const a = 99; // changed externally\n", "utf-8");

    const result = await runEdit(context, filePath, "const a = 1", "const a = 2");
    expect(result).toMatchObject({
      success: false,
      gate: "stale",
    });
    expect(
      (result as unknown as { error?: string } | undefined)?.error,
    ).toContain("changed since it was last read");
  });

  test("consecutive edits without a re-read are allowed (edit updates its own state)", async () => {
    const sandbox = createSandbox();
    const context = createContext(sandbox);
    const filePath = path.join(workingDirectory, "chain.ts");
    await writeFile(filePath, "one\ntwo\nthree\n", "utf-8");

    await runRead(context, filePath);
    const first = await runEdit(context, filePath, "one", "ONE");
    const second = await runEdit(context, filePath, "two", "TWO");

    expect(first).toMatchObject({ success: true });
    expect(second).toMatchObject({ success: true });
    const onDisk = await readFile(filePath, "utf-8");
    expect(onDisk).toBe("ONE\nTWO\nthree\n");
  });

  test("partial reads count as reads (hash of the full file)", async () => {
    const sandbox = createSandbox();
    const context = createContext(sandbox);
    const filePath = path.join(workingDirectory, "partial.txt");
    await writeFile(
      filePath,
      Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join("\n") + "\n",
      "utf-8",
    );

    // Read only a small window
    await readFileTool().execute?.(
      { filePath, offset: 5, limit: 3 },
      executionOptions(context),
    );

    const result = await runEdit(
      context,
      filePath,
      "line-50",
      "line-50 edited",
    );
    expect(result).toMatchObject({ success: true });
  });

  test("CRLF files do not trip the stale check (hash basis is normalized)", async () => {
    const sandbox = createSandbox();
    const context = createContext(sandbox);
    const filePath = path.join(workingDirectory, "crlf.txt");
    await writeFile(filePath, "alpha\r\nbeta\r\n", "utf-8");

    await runRead(context, filePath);
    const result = await runEdit(context, filePath, "alpha", "ALPHA");

    expect(result).toMatchObject({ success: true });
    const onDisk = await readFile(filePath, "utf-8");
    expect(onDisk).toBe("ALPHA\r\nbeta\r\n");
  });

  test("empty-file reads count as reads", async () => {
    const sandbox = createSandbox();
    const context = createContext(sandbox);
    const filePath = path.join(workingDirectory, "empty.txt");
    await writeFile(filePath, "", "utf-8");

    await runRead(context, filePath);
    const result = await runWrite(context, filePath, "now populated\n");

    expect(result).toMatchObject({
      success: true,
      contentHash: hashFileContent("now populated\n"),
    });
  });
});

describe("read-before-overwrite gate (write tool)", () => {
  test("overwriting an unread existing file is refused", async () => {
    const sandbox = createSandbox();
    const context = createContext(sandbox);
    const filePath = path.join(workingDirectory, "existing.txt");
    await writeFile(filePath, "precious content\n", "utf-8");

    const result = await runWrite(context, filePath, "blind overwrite");

    expect(result).toMatchObject({
      success: false,
      gate: "unread",
    });
    const onDisk = await readFile(filePath, "utf-8");
    expect(onDisk).toBe("precious content\n"); // nothing was destroyed
  });

  test("creating a brand-new file needs no prior read", async () => {
    const sandbox = createSandbox();
    const context = createContext(sandbox);
    const result = await runWrite(
      context,
      path.join(workingDirectory, "fresh.txt"),
      "brand new\n",
    );
    expect(result).toMatchObject({ success: true });
  });

  test("overwrite after read succeeds and records the new hash", async () => {
    const sandbox = createSandbox();
    const context = createContext(sandbox);
    const filePath = path.join(workingDirectory, "overwrite.txt");
    await writeFile(filePath, "old contents\n", "utf-8");

    await runRead(context, filePath);
    const write = await runWrite(context, filePath, "new contents\n");
    expect(write).toMatchObject({
      success: true,
      contentHash: hashFileContent("new contents\n"),
    });

    // An edit right after the overwrite needs no re-read
    const edit = await runEdit(context, filePath, "new", "NEW");
    expect(edit).toMatchObject({ success: true });
  });
});

describe("state derivation from message history", () => {
  test("rebuilt state lets an edit pass without a live read", async () => {
    const sandbox = createSandbox();
    const context = createContext(sandbox);
    const filePath = path.join(workingDirectory, "derived.txt");
    await writeFile(filePath, "const x = 1;\n", "utf-8");

    // Simulate a prior turn: read output persisted in history
    const readOutput = await runRead(context, filePath);
    const state = createReadFileState();
    rebuildReadFileState(
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-read-1",
              toolName: "read",
              output: readOutput,
            },
          ],
        } as never,
      ],
      state,
    );

    // Fresh context carrying only the DERIVED state (new session run)
    const sandboxId = `gate-sandbox-${sandboxRegistry.size + 1}`;
    sandboxRegistry.set(sandboxId, sandbox);
    const resumedContext = {
      sandbox: {
        state: { type: "vercel" as const, sandboxId },
        workingDirectory,
      },
      readFileState: state,
      model: "test-model",
    } as never;

    const result = await runEdit(
      resumedContext,
      filePath,
      "const x = 1",
      "const x = 2",
    );
    expect(result).toMatchObject({ success: true });
  });

  test("a stale read in history (file changed since) is still caught", async () => {
    const sandbox = createSandbox();
    const context = createContext(sandbox);
    const filePath = path.join(workingDirectory, "derived-stale.txt");
    await writeFile(filePath, "v1\n", "utf-8");

    const readOutput = await runRead(context, filePath);
    // File changes after the read was persisted
    await writeFile(filePath, "v2\n", "utf-8");

    const state = createReadFileState();
    rebuildReadFileState(
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-read-2",
              toolName: "read",
              output: readOutput,
            },
          ],
        } as never,
      ],
      state,
    );

    const sandboxId = `gate-sandbox-${sandboxRegistry.size + 1}`;
    sandboxRegistry.set(sandboxId, sandbox);
    const resumedContext = {
      sandbox: {
        state: { type: "vercel" as const, sandboxId },
        workingDirectory,
      },
      readFileState: state,
      model: "test-model",
    } as never;

    const result = await runEdit(resumedContext, filePath, "v2", "v3");
    expect(result).toMatchObject({
      success: false,
      gate: "stale",
    });
  });
});
