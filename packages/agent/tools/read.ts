import { tool } from "ai";
import { z } from "zod";
import { wrapExternalFileContent } from "./content-boundary";
import { ensureReadFileState } from "./read-state";
import {
  checkUnchangedRead,
  type SelectedLines as SelectedLinesResult,
  clampLine,
  hashFileContent,
  isDevicePath,
  isLikelyBinary,
  normalizeFileContent,
  recordRead,
  selectLines,
  splitLines,
  applyByteCeiling,
} from "./read-ceilings";
import { getSandbox, toDisplayPath } from "./utils";
import {
  isDotEnvFilePath,
  isSensitiveDotEnvPath,
  resolveSandboxRealPath,
  resolveWorkspacePath,
} from "./path-security";

const readInputSchema = z.object({
  filePath: z
    .string()
    .describe(
      "Workspace-relative path to the file to read (e.g., src/index.ts)",
    ),
  offset: z
    .number()
    .optional()
    .describe(
      "Line number to start reading from (1-indexed). NEGATIVE reads the tail: offset=-50 returns the last 50 lines. When a previous read was truncated it returns nextOffset — pass that here to continue exactly where it stopped.",
    ),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of lines to read. Default: 2000"),
});

export const readFileTool = () =>
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
        sandbox = await getSandbox(experimental_context, "read");
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
    description: `Read a file from the filesystem.

USAGE:
- Use workspace-relative paths (e.g., "src/index.ts")
- Paths are resolved from the workspace root
- By default reads up to 2000 lines starting from line 1
- Use offset and limit for long files (both are line-based, 1-indexed)
- Negative offset reads the tail: offset=-50 is the last 50 lines
- Three ceilings protect the context window: 2000 lines, 128KB per read, and 2000 chars per line (over-long lines are clamped with a visible marker)
- If the file was cut, the result includes nextOffset — pass it as the next offset to resume exactly where it stopped
- Re-reading the SAME range of an unchanged file returns a cheap "unchanged" notice instead of the full content; a different offset/limit always returns the requested lines
- Results include line numbers starting at 1 in "N: content" format

IMPORTANT:
- Always read a file at least once before editing it with the edit/write tools
- This tool can only read files, not directories - attempting to read a directory returns an error
- You can call multiple reads in parallel to speculatively load several files

EXAMPLES:
- Read an entire file: filePath: "src/index.ts"
- Read a slice of a long file: filePath: "logs/app.log", offset: 500, limit: 200`,
    inputSchema: readInputSchema,
    execute: async (
      { filePath, offset = 1, limit = 2000 },
      { experimental_context },
    ) => {
      const sandbox = await getSandbox(experimental_context, "read");
      const workingDirectory = sandbox.workingDirectory;

      try {
        // Refuse device and virtual file paths before any I/O
        // (Command Code read tool: /dev/zero and friends are infinite or
        // live streams — reading them wedges or floods the sandbox).
        if (isDevicePath(filePath)) {
          return {
            success: false,
            error:
              "Device and virtual file paths (e.g. /dev/zero, /proc/N/fd) are refused. Read the real file on disk instead — if you need a stream's content, save it to a file first with bash redirection.",
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

        const stats = await sandbox.stat(absolutePath);
        if (stats.isDirectory()) {
          return {
            success: false,
            error: "Cannot read a directory. Use glob or ls command instead.",
          };
        }

        const raw = await sandbox.readFile(absolutePath, "utf-8");

        // Magic-byte sniff (never the extension): a NUL byte in the
        // head means this is not text — return a recovery note instead
        // of flooding the context with binary garbage.
        if (isLikelyBinary(raw)) {
          return {
            success: false,
            error:
              "This file looks binary (not text). Use bash with `grep -a`, `strings`, or a specific extraction command to pull out the parts you need instead of reading it whole.",
          };
        }

        // BOM stripped, CRLF normalized — so line numbers and offsets
        // agree with what cat -n and other tools see.
        const content = normalizeFileContent(raw);
        const lines = splitLines(content);
        const displayPath = toDisplayPath(absolutePath, workingDirectory);
        const contentHash = hashFileContent(content);
        // Read-gate state (read-state.ts): hash of the FULL file so
        // partial/tail/empty reads all count as "seen". Attached
        // lazily when the host (prepareStep / subagents) hasn't.
        const readState = ensureReadFileState(
          (experimental_context ?? {}) as { readFileState?: unknown },
        );
        readState.set(displayPath, contentHash);

        // Empty-file note with recovery (Command Code): an empty read
        // is a success, not an error — the model shouldn't retry.
        if (content.length === 0) {
          return {
            success: true,
            path: displayPath,
            totalLines: 0,
            startLine: 0,
            endLine: 0,
            contentHash,
            content:
              "This file is empty (0 bytes, 0 lines). Nothing to read — it may be a placeholder or waiting to be written.",
          };
        }

        // Unchanged-read dedup (Command Code): re-reading a file that
        // has not changed since the immediately previous read returns
        // a cheap notice. Consumes itself on hit, so the next read
        // returns full content again.
        //
        // The key MUST include the requested window (offset/limit), not
        // just the file: without it, asking for a range the model has
        // never seen -- e.g. "show me lines 400-450 again" right after
        // reading the head -- returned this notice instead of the lines,
        // which reads as "the tool is broken" and pushes the model into
        // reasoning about content it never actually saw (the exact
        // failure the read-before-edit gate exists to prevent). The same
        // request on an unchanged file still short-circuits.
        const dedupKey = `${workingDirectory}:${absolutePath}:${offset}:${limit}`;
        if (checkUnchangedRead(dedupKey, contentHash)) {
          return {
            success: true,
            path: displayPath,
            totalLines: lines.length,
            unchanged: true,
            contentHash,
            content:
              "File unchanged since your previous read — same content, same size. Read again if you need the full content back.",
          };
        }
        recordRead(dedupKey, contentHash);

        // Three ceilings: line window (offset/limit, negative = tail),
        // per-line clamp (minified bundles), byte budget (logs).
        let selection: SelectedLinesResult & { nextOffset?: number | null } =
          selectLines(lines, { offset, limit });

        // A past-EOF offset selects nothing. Without this the tool
        // returned success with empty content, which reads as "the file
        // is blank" rather than "you asked past the end".
        if (selection.lines.length === 0 && lines.length > 0) {
          return {
            success: true,
            path: displayPath,
            totalLines: lines.length,
            startLine: lines.length + 1,
            endLine: lines.length,
            contentHash,
            content: `Nothing to read: offset ${offset} is past the end of this file (${lines.length} lines). Use offset ${lines.length} or lower, or a negative offset to read the tail.`,
          };
        }

        const clamped = selection.lines.map((line) => clampLine(line));
        selection = applyByteCeiling({
          ...selection,
          lines: clamped.map((c) => c.line),
        });

        const numberedLines = selection.lines.map(
          (line, i) => `${selection.startLine + i}: ${line}`,
        );

        const result: Record<string, unknown> = {
          success: true,
          path: displayPath,
          totalLines: lines.length,
          startLine: selection.startLine,
          endLine: selection.endLine,
          contentHash,
          // Workspace file content is untrusted data (upstream #875):
          // wrap it in a prompt-injection boundary so instructions
          // embedded in a repo can't masquerade as operator commands.
          content: wrapExternalFileContent(
            displayPath,
            numberedLines.join("\n"),
          ),
        };

        if (selection.truncated) {
          result.truncated = true;
          result.nextOffset = selection.nextOffset;
        }

        return result as {
          success: boolean;
          path: string;
          totalLines: number;
          startLine: number;
          endLine: number;
          content: string;
          truncated?: boolean;
          nextOffset?: number | null;
          unchanged?: boolean;
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          error: `Failed to read file: ${message}`,
        };
      }
    },
  });
