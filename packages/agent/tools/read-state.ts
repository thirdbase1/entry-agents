import type { ModelMessage } from "ai";
import { hashFileContent, normalizeFileContent } from "./read-ceilings";

/**
 * Read-before-edit/write gate state (Command Code-style harness
 * engineering): the model may only edit or overwrite a file whose
 * current content it has actually SEEN. The state maps each
 * workspace-relative display path to a content hash of the FULL
 * normalized file content recorded by the read tool (partial, tail,
 * and empty reads all count — the hash is always of the whole file).
 */
export type ReadFileState = Map<string, string>;

export function createReadFileState(): ReadFileState {
  return new Map();
}

/**
 * Lazily attach a state store to the (mutable) experimental_context
 * object. prepareStep re-uses and re-derives the store across model
 * steps; tools that run before prepareStep ran (or in hosts that pass
 * a fresh context object per call) still get a working store.
 */
export function ensureReadFileState(context: {
  readFileState?: unknown;
}): ReadFileState {
  let state: ReadFileState | undefined =
    context.readFileState instanceof Map ? context.readFileState : undefined;
  if (!state) {
    state = createReadFileState();
    context.readFileState = state;
  }
  return state;
}

/**
 * Hash of raw file content on the gate's basis: normalized (BOM
 * stripped, CRLF normalized) — the same basis the read tool reports,
 * so cross-tool comparisons never false-trip on line endings.
 */
export function currentFileHash(raw: string): string {
  return hashFileContent(normalizeFileContent(raw));
}

function foldStateFromToolOutput(
  output: unknown,
  state: ReadFileState,
): void {
  if (typeof output !== "object" || output === null) {
    return;
  }
  const candidate = output as Record<string, unknown>;
  if (candidate.success !== true) {
    return;
  }
  const filePath = candidate.path;
  const contentHash = candidate.contentHash;
  if (typeof filePath !== "string" || filePath === "") {
    return;
  }
  if (typeof contentHash !== "string" || contentHash === "") {
    return;
  }
  state.set(filePath, contentHash);
}

const GATED_TOOL_NAMES = new Set(["read", "edit", "write"]);

/**
 * Durability by derivation (no separate storage to drift): every
 * successful read/edit/write output carries the contentHash of the
 * version it produced, so the state can be rebuilt by replaying the
 * message history. Last write wins. Survives refresh, resume, and
 * workflow suspend/resume for free.
 *
 * Deliberate side effect: once auto-compaction collapses an old read
 * payload to a placeholder notice, its hash is no longer derivable —
 * the model must re-read. Post-compaction it genuinely hasn't seen
 * the file in its current form, so that is the correct verdict.
 */
export function rebuildReadFileState(
  messages: ModelMessage[],
  state?: ReadFileState,
): ReadFileState {
  const store = state ?? createReadFileState();
  store.clear();
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (typeof part !== "object" || part === null) {
        continue;
      }
      const candidate = part as Record<string, unknown>;
      if (candidate.type !== "tool-result") {
        continue;
      }
      if (!GATED_TOOL_NAMES.has(String(candidate.toolName))) {
        continue;
      }
      foldStateFromToolOutput(candidate.output, store);
    }
  }
  return store;
}

export type ReadGateResult =
  | { ok: true }
  | { ok: false; reason: "unread" | "stale"; message: string };

/**
 * The gate itself: refuse edits/overwrites of files the model never
 * read, or whose on-disk content changed since the last read (bash
 * sed, git checkout, another agent's write...). Errors carry a
 * recovery instruction, never just a refusal.
 */
export function checkReadGate(
  state: ReadFileState,
  displayPath: string,
  currentHash: string,
  action: "edit" | "write",
): ReadGateResult {
  const seenHash = state.get(displayPath);
  if (seenHash === undefined) {
    return {
      ok: false,
      reason: "unread",
      message: `File has not been read yet (${displayPath}). Use the read tool on it first — the ${action} was refused so you don't change content you haven't seen.`,
    };
  }
  if (seenHash !== currentHash) {
    return {
      ok: false,
      reason: "stale",
      message: `File ${displayPath} has changed since it was last read (external edit via bash, git, or another agent?). Read it again with the read tool before ${action}ing — the ${action} would otherwise target content you haven't seen.`,
    };
  }
  return { ok: true };
}
