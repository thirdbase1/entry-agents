// Deliberately Node-module-free (no fs/path/os/child_process/sandbox
// imports) so it can be statically imported directly from a
// `"use workflow"` function body (see app/workflows/run-benchmarks.ts)
// without pulling Node-only code into the Vercel Workflow SDK's
// restricted workflow bundle. Everything that actually touches the
// filesystem or spawns a subprocess lives in humaneval-runner.ts
// instead, which must only ever be reached via a dynamic `import()`
// inside a `"use step"` function.
import humanEvalSubset from "./data/humaneval-subset.json";

export interface HumanEvalTask {
  task_id: string;
  prompt: string;
  entry_point: string;
  canonical_solution: string;
  test: string;
}

export function loadHumanEvalSubset(): HumanEvalTask[] {
  return humanEvalSubset as HumanEvalTask[];
}

export const HUMANEVAL_SUITE_VERSION = "humaneval-subset-20-v1";
