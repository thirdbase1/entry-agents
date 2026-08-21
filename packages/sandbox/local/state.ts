/**
 * State for a sandbox backed by a plain local directory + child_process,
 * instead of a remote Vercel Sandbox container. Real semantics (same
 * Sandbox interface every tool uses), just no remote provisioning --
 * for fast, free, local runs: tests, dev scripts, and the harness-based
 * benchmark runner (scripts/run-benchmarks.ts). Never used for real user
 * chat sessions -- those always use the "vercel" sandbox type so tool
 * calls run in a real isolated container, not on the host running the
 * web app.
 */
export interface LocalState {
  /** Absolute host directory this sandbox's working directory is rooted at. */
  rootDir: string;
}
