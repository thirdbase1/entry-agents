/**
 * Harness-engineered read windowing, modeled on Command Code's read
 * tool (commandcode.ai/docs/eng/read-tool).
 *
 * Every capability here is a token-budget decision multiplied by the
 * number of reads a session makes: a read tool that returns a 5MB
 * lockfile, or a 3,900-char minified line, quietly spends the context
 * window on bytes the model never needed — and that junk stays in the
 * window for every turn after. The helpers below enforce three
 * ceilings, precompute resume offsets, and dedup unchanged re-reads so
 * repeated reads stop costing anything.
 */

/** Ceiling 1: the line window (ordinary long files). */
export const READ_MAX_LINES = 2_000;
/** Ceiling 2: the byte budget (logs and other wide-content files). */
export const READ_BYTE_CEILING = 128 * 1024;
/** Ceiling 3: the per-line clamp (minified bundles that are one line). */
export const READ_MAX_LINE_CHARS = 2_000;

export interface SelectedLines {
  /** 1-based line number of the first returned line. */
  startLine: number;
  /** 1-based line number of the LAST returned line (inclusive). */
  endLine: number;
  lines: string[];
  /** True when the window cut anything the file contains. */
  truncated: boolean;
}

/** Strips a UTF-8 BOM and normalizes CRLF to LF. */
export function normalizeFileContent(content: string): string {
  const withoutBom = content.charCodeAt(0) === 0xfeff
    ? content.slice(1)
    : content;
  return withoutBom.replace(/\r\n/g, "\n");
}

/** NUL byte in the head of the content means it isn't text. */
export function isLikelyBinary(content: string): boolean {
  return content.slice(0, 8_192).includes("\x00");
}

/** Device and virtual file paths are refused before any I/O. */
export function isDevicePath(filePath: string): boolean {
  return (
    /^\/dev\/(stdin|stdout|stderr|zero|full|random|urandom|null)(\/|$)/.test(
      filePath,
    ) || /^\/dev\/[^/]+$/.test(filePath) || /^\/proc\/\d+\/fd/.test(filePath)
  );
}

export function clampLine(
  line: string,
  maxChars = READ_MAX_LINE_CHARS,
): { line: string; clampedChars: number } {
  if (line.length <= maxChars) {
    return { line, clampedChars: 0 };
  }
  return {
    line: `${line.slice(0, maxChars)} … [line clamped: ${line.length - maxChars} more chars]`,
    clampedChars: line.length - maxChars,
  };
}

/**
 * Line-window selection with Command Code semantics:
 * - offset >= 1 (default): read from that line forward, up to `limit`.
 * - offset < 0: read the TAIL — offset=-50 means "the last 50 lines".
 */
export function selectLines(
  lines: string[],
  { offset = 1, limit = READ_MAX_LINES }: { offset?: number; limit?: number } = {},
): SelectedLines {
  const totalLines = lines.length;
  const normalizedLimit = Number.isFinite(limit) && limit > 0 ? limit : READ_MAX_LINES;

  let startIdx: number;
  let endIdx: number;

  if (offset < 0) {
    startIdx = Math.max(0, totalLines + offset);
    endIdx = Math.min(totalLines, startIdx + normalizedLimit);
  } else {
    // Clamp to totalLines, not just to 0: an offset past EOF used to
    // yield startLine > endLine (e.g. offset 50 on a 10-line file gave
    // startLine 50, endLine 10) -- an inverted range the model then
    // tried to reason about. A past-EOF offset is a legitimate "read
    // from here" that simply has nothing left.
    startIdx = Math.min(
      totalLines,
      Math.max(0, (Number.isFinite(offset) ? offset : 1) - 1),
    );
    endIdx = Math.min(totalLines, startIdx + normalizedLimit);
  }

  const selected = lines.slice(startIdx, endIdx);

  return {
    startLine: startIdx + 1,
    endLine: endIdx,
    lines: selected,
    truncated: endIdx < totalLines,
  };
}

/**
 * Applies the byte ceiling AFTER the line window: accumulate lines
 * until the budget is spent. Returns the (possibly shorter) selection
 * plus the precomputed resume offset — no pagination arithmetic for
 * the model to get wrong.
 */
export function applyByteCeiling(
  selection: SelectedLines,
  maxBytes = READ_BYTE_CEILING,
): SelectedLines & { nextOffset: number | null } {
  let used = 0;
  const kept: string[] = [];

  for (const line of selection.lines) {
    const cost = line.length + 1;
    if (used + cost > maxBytes) {
      break;
    }
    kept.push(line);
    used += cost;
  }

  const truncated = kept.length < selection.lines.length || selection.truncated;
  const endLine = selection.startLine + kept.length - 1;

  // Precomputed resume offset (Command Code): the line the model
  // should pass as the next offset to continue reading. When the byte
  // budget cut mid-window, resume right after the last KEPT line; when
  // only the line window cut, resume right after the window.
  const nextOffset = kept.length < selection.lines.length
    ? selection.startLine + kept.length
    : selection.endLine + 1;

  return {
    ...selection,
    lines: kept,
    endLine: Math.max(endLine, 0),
    truncated,
    nextOffset: truncated ? nextOffset : null,
  };
}

function djb2Hex(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

export function hashFileContent(content: string): string {
  return `${content.length}:${djb2Hex(content)}`;
}

const MAX_DEDUP_ENTRIES = 512;
const readDedupStore = new Map<string, string>();

export function resetReadDedupStoreForTests(): void {
  readDedupStore.clear();
}

/**
 * Unchanged-read dedup that consumes itself on hit: the FIRST
 * consecutive re-read of an unchanged file returns a cheap notice
 * instead of the full content; the very next read returns content
 * again, so the agent is never locked out of a file.
 */
export function checkUnchangedRead(key: string, contentHash: string): boolean {
  const seen = readDedupStore.get(key);
  if (seen === undefined) {
    return false;
  }
  if (seen === contentHash) {
    readDedupStore.delete(key);
    return true;
  }
  return false;
}

export function recordRead(key: string, contentHash: string): void {
  if (readDedupStore.size >= MAX_DEDUP_ENTRIES) {
    const oldest = readDedupStore.keys().next();
    if (!oldest.done) {
      readDedupStore.delete(oldest.value);
    }
  }
  readDedupStore.set(key, contentHash);
}
