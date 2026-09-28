import "server-only";

/**
 * Server boot hook. Next.js calls register() once per server process —
 * the Entry run engine (lightflow worker + compat layer) starts here so
 * every API route can start()/getRun() against the shared Postgres store.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SIM_USER_ID) {
    (globalThis as Record<string, unknown>).__SIM_USER_ID__ = process.env.SIM_USER_ID;
  }
  const { startRunEngine } = await import("@/lib/run-engine");
  await startRunEngine();
  const { registerEntryWorkflows } = await import("@/lib/run-engine-registry");
  registerEntryWorkflows();
}
