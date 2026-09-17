import { tool } from "ai";
import { z } from "zod";
import * as path from "path";
import { getSandbox, toDisplayPath } from "./utils";
import {
  checkReadGate,
  currentFileHash,
  ensureReadFileState,
} from "./read-state";
import {
  isDotEnvFilePath,
  isSensitiveDotEnvPath,
  resolveSandboxRealPath,
  resolveWorkspacePath,
} from "./path-security";

const writeInputSchema = z.object({
  filePath: z
    .string()
    .describe(
      "Workspace-relative path to the file to write (e.g., src/user.test.ts)",
    ),
  content: z.string().describe("Content to write to the file"),
});

const editInputSchema = z.object({
  filePath: z
    .string()
    .describe(
      "Workspace-relative path to the file to edit (e.g., src/auth.ts)",
    ),
  oldString: z.string().describe("The exact text to replace"),
  newString: z
    .string()
    .describe("The text to replace it with (must differ from oldString)"),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Replace all occurrences. Default: false"),
  startLine: z
    .number()
    .optional()
    .describe("Line number where oldString starts (for diff display)"),
});

export const writeFileTool = () =>
  tool({
    needsApproval: async ({ filePath }, { experimental_context }) => {
      if (
        (
          experimental_context as
            | { permissionMode?: "ask" | "autoAccept" | "fullAccess" }
            | undefined
        )?.permissionMode === "fullAccess"
      ) {
        return false;
      }

      if (isDotEnvFilePath(filePath)) {
        return true;
      }

      let sandbox;
      try {
        sandbox = await getSandbox(experimental_context, "write");
      } catch {
        return false;
      }
      const workingDirectory = sandbox.workingDirectory;
      const absolutePath = resolveWorkspacePath(filePath, workingDirectory);
      if (!absolutePath) {
        return false;
      }

      const realPath = await resolveSandboxRealPath({
        sandbox,
        absolutePath,
        workingDirectory,
      });

      return isSensitiveDotEnvPath({
        requestedPath: filePath,
        absolutePath,
        realPath,
      });
    },
    description: `Write content to a file on the filesystem.

WHEN TO USE:
- Creating a new file that does not yet exist
- Completely replacing the contents of an existing file after you've read it
- Generating code or configuration as part of an implementation task

WHEN NOT TO USE:
- Small or localized changes to an existing file (prefer editFileTool instead)
- Reading files (use readFileTool instead)
- Searching (use grepTool or globTool instead)

USAGE:
- Use workspace-relative paths (e.g., "src/user.test.ts")
- This will OVERWRITE existing files entirely
- Parent directories are created automatically if they do not exist

IMPORTANT:
- ALWAYS read an existing file with readFileTool before overwriting it
- Prefer editing existing files over creating new ones unless a new file is explicitly needed
- NEVER proactively create documentation files (e.g., *.md) unless the user explicitly requests them
- Do not write files that contain secrets or credentials (API keys, passwords, .env, etc.)

EXAMPLES:
- Create a new test file: filePath: "src/user.test.ts", content: "<full file contents>"
- Replace a script after reading it: filePath: "scripts/build.sh", content: "<entire updated script>"`,
    inputSchema: writeInputSchema,
    execute: async ({ filePath, content }, { experimental_context }) => {
      const sandbox = await getSandbox(experimental_context, "write");
      const workingDirectory = sandbox.workingDirectory;

      try {
        const absolutePath = resolveWorkspacePath(filePath, workingDirectory);
        if (!absolutePath) {
          return {
            success: false,
            error: "Path must stay within the workspace.",
          };
        }

        const realPath = await resolveSandboxRealPath({
          sandbox,
          absolutePath,
          workingDirectory,
        });
        if (realPath && !resolveWorkspacePath(realPath, workingDirectory)) {
          return {
            success: false,
            error: "Path resolves outside the workspace.",
          };
        }

        // Read gate (read-state.ts): overwriting an existing file
        // the model has not read in its current version is a blind
        // write — the worst kind of edit. Creating a new file is free.
        const readState = ensureReadFileState(
          (experimental_context ?? {}) as { readFileState?: unknown },
        );
        const displayPath = toDisplayPath(absolutePath, workingDirectory);
        let fileExists = true;
        try {
          await sandbox.stat(absolutePath);
        } catch {
          fileExists = false;
        }
        if (fileExists) {
          const existingRaw = await sandbox.readFile(absolutePath, "utf-8");
          const gate = checkReadGate(
            readState,
            displayPath,
            currentFileHash(existingRaw),
            "write",
          );
          if (!gate.ok) {
            return {
              success: false,
              error: gate.message,
              gate: gate.reason,
            };
          }
        }

        const dir = path.dirname(absolutePath);
        await sandbox.mkdir(dir, { recursive: true });
        await sandbox.writeFile(absolutePath, content, "utf-8");

        // The write itself is the newest "seen" version — record it
        // so a following edit never demands a redundant re-read.
        const contentHash = currentFileHash(content);
        readState.set(displayPath, contentHash);

        const stats = await sandbox.stat(absolutePath);

        return {
          success: true,
          path: displayPath,
          contentHash,
          bytesWritten: stats.size,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          error: `Failed to write file: ${message}`,
        };
      }
    },
  });

export const editFileTool = () =>
  tool({
    needsApproval: async ({ filePath }, { experimental_context }) => {
      if (
        (
          experimental_context as
            | { permissionMode?: "ask" | "autoAccept" | "fullAccess" }
            | undefined
        )?.permissionMode === "fullAccess"
      ) {
        return false;
      }

      if (isDotEnvFilePath(filePath)) {
        return true;
      }

      let sandbox;
      try {
        sandbox = await getSandbox(experimental_context, "edit");
      } catch {
        return false;
      }
      const workingDirectory = sandbox.workingDirectory;
      const absolutePath = resolveWorkspacePath(filePath, workingDirectory);
      if (!absolutePath) {
        return false;
      }

      const realPath = await resolveSandboxRealPath({
        sandbox,
        absolutePath,
        workingDirectory,
      });

      return isSensitiveDotEnvPath({
        requestedPath: filePath,
        absolutePath,
        realPath,
      });
    },
    description: `Perform exact string replacement in a file.

WHEN TO USE:
- Making small, precise edits to an existing file you have already read
- Renaming a variable or identifier consistently within a single file
- Changing a specific block of code or configuration exactly as seen in the read output

WHEN NOT TO USE:
- Creating new files (use writeFileTool instead)
- Large structural rewrites where it's simpler to rewrite the entire file (use writeFileTool)
- Multi-file refactors (use grepTool + multiple edits, or taskTool for larger jobs)

USAGE:
- Use workspace-relative file paths (e.g., "src/auth.ts")
- You must read the file first with readFileTool in this conversation
- Provide oldString as the EXACT text to replace, including whitespace and indentation
- By default, oldString must be UNIQUE in the file; otherwise the edit will fail
- Use replaceAll: true to change ALL occurrences of oldString in the file (e.g., for a rename)
- ALWAYS provide startLine: the line number where oldString begins (from the read output)

IMPORTANT:
- Preserve exact indentation and spacing from the file's content as returned by readFileTool
- Never include line numbers or the "N: " line prefixes from the read output in oldString or newString
- If oldString appears multiple times and replaceAll is false, the tool will FAIL with an error and occurrence count

EXAMPLES:
- Replace a single function call: filePath: "src/auth.ts", oldString: "login(user, password)", newString: "loginWithAudit(user, password)", startLine: 42
- Rename a variable throughout a file: filePath: "src/api.ts", oldString: "oldApiClient", newString: "newApiClient", replaceAll: true, startLine: 15`,
    inputSchema: editInputSchema,
    execute: async (
      { filePath, oldString, newString, replaceAll = false },
      { experimental_context },
    ) => {
      const sandbox = await getSandbox(experimental_context, "edit");
      const workingDirectory = sandbox.workingDirectory;

      try {
        if (oldString === newString) {
          return {
            success: false,
            error: "oldString and newString must be different",
          };
        }

        const absolutePath = resolveWorkspacePath(filePath, workingDirectory);
        if (!absolutePath) {
          return {
            success: false,
            error: "Path must stay within the workspace.",
          };
        }

        const realPath = await resolveSandboxRealPath({
          sandbox,
          absolutePath,
          workingDirectory,
        });
        if (realPath && !resolveWorkspacePath(realPath, workingDirectory)) {
          return {
            success: false,
            error: "Path resolves outside the workspace.",
          };
        }

        const content = await sandbox.readFile(absolutePath, "utf-8");

        // Read gate (read-state.ts): the model may only edit a file
        // it has read in its current version. Never-read files,
        // failed reads, and stale reads (external bash/git changes)
        // are all refused with a recovery instruction.
        const readState = ensureReadFileState(
          (experimental_context ?? {}) as { readFileState?: unknown },
        );
        const displayPath = toDisplayPath(absolutePath, workingDirectory);
        const gate = checkReadGate(
          readState,
          displayPath,
          currentFileHash(content),
          "edit",
        );
        if (!gate.ok) {
          return {
            success: false,
            error: gate.message,
            gate: gate.reason,
          };
        }

        if (!content.includes(oldString)) {
          return {
            success: false,
            error: "oldString not found in file",
            hint: "Make sure to match exact whitespace and indentation",
          };
        }

        const occurrences = content.split(oldString).length - 1;
        if (occurrences > 1 && !replaceAll) {
          return {
            success: false,
            error: `oldString found ${occurrences} times. Use replaceAll=true or provide more context to make it unique.`,
          };
        }

        // Calculate starting line number for the edit
        const matchIndex = content.indexOf(oldString);
        const startLine = content.slice(0, matchIndex).split("\n").length;

        const newContent = replaceAll
          ? content.replaceAll(oldString, newString)
          : content.replace(oldString, newString);

        await sandbox.writeFile(absolutePath, newContent, "utf-8");

        // The edit itself is the newest "seen" version — record it
        // so consecutive edits never demand redundant re-reads.
        const contentHash = currentFileHash(newContent);
        readState.set(displayPath, contentHash);

        return {
          success: true,
          path: displayPath,
          contentHash,
          replacements: replaceAll ? occurrences : 1,
          startLine,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          error: `Failed to edit file: ${message}`,
        };
      }
    },
  });
