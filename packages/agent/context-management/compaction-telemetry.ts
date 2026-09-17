import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Compaction telemetry (added 2026-09-17, owner request: "build compaction
 * usage on the admin side -- cause am thinking compaction doesn't work").
 *
 * The auto-compactor runs deep inside the framework's prepareStep callback
 * (see auto-compact.ts), which has no access to per-call context (which
 * chat, which user, which model produced the history being compacted) --
 * and the web app needs exactly that context to record a useful
 * admin-visible analytics row. Rather than threading callbacks through
 * ToolLoopAgent's static settings (which are shared across ALL calls),
 * we use an AsyncLocalStorage "sink" scoped to a single chat turn:
 *
 *   apps/web/app/workflows/chat.ts wraps its whole step loop in
 *   runWithCompactionSink(...), and every maybeCompactMessages firing
 *   anywhere inside that async call tree reports through it.
 *
 * Concurrency-safe: each in-flight request keeps its own ALS store, so
 * overlapping chat turns never cross wires. The sink is fire-and-forget:
 * a failing telemetry write must NEVER break or delay a live model step.
 */
export interface CompactionEvent {
  /** Estimated request tokens BEFORE compaction (history + system/tools overhead). */
  preCompactTokens: number;
  /** Estimated request tokens AFTER compaction. */
  postCompactTokens: number;
  /** The context window size the threshold was evaluated against. */
  contextWindowTokens: number;
  /** The threshold fraction that triggered compaction (e.g. 0.95). */
  threshold: number;
  /** Number of tool-call payloads collapsed to placeholders. */
  compactedToolCalls: number;
  /** Number of anonymous tool results collapsed to placeholders. */
  compactedAnonymousToolResults: number;
  /** Model id the compacted request was headed to. */
  modelId: string;
}

type CompactionSink = (event: CompactionEvent) => void | Promise<void>;

const compactionSinkStorage = new AsyncLocalStorage<{
  sink: CompactionSink;
}>();

/**
 * Run `fn` with a compaction telemetry sink in scope. Any
 * emitCompactionEvent() call from within `fn`'s async call tree is routed
 * to `sink`. Re-entrant with nested sinks: the innermost one wins.
 */
export async function runWithCompactionSink<T>(
  sink: CompactionSink,
  fn: () => Promise<T>,
): Promise<T> {
  return compactionSinkStorage.run({ sink }, fn);
}

/**
 * Report a compaction firing to the in-scope sink, if any. Never throws
 * and never blocks: telemetry is best-effort diagnostics, and the model
 * step that triggered it must proceed regardless.
 */
export function emitCompactionEvent(event: CompactionEvent): void {
  const store = compactionSinkStorage.getStore();
  if (!store) {
    return;
  }
  try {
    void Promise.resolve(store.sink(event)).catch((error: unknown) => {
      console.error(
        "[auto-compact] compaction telemetry sink rejected:",
        error,
      );
    });
  } catch (error) {
    console.error(
      "[auto-compact] compaction telemetry sink threw:",
      error,
    );
  }
}
