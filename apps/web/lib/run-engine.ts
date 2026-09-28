import "server-only";

/**
 * Entry Run Engine bootstrap — lightflow under the hood.
 *
 * This module IS the engine for Entry's durable workflows (chat turns,
 * sandbox lifecycle, provisioning, benchmarks). It wires lightflow's
 * Postgres store and worker into the compat layer so that
 * `lightflow-engine/compat/api`'s start()/getRun() work anywhere in the
 * server runtime, and registers the workflow functions Entry starts.
 *
 * Import this once from `instrumentation.ts` (server boot) — it starts
 * the worker that resumes suspended runs and fires durable timers.
 */

import { createPostgresStore, type Store } from "lightflow-engine/pg";
import { Engine } from "lightflow-engine";
import { initWorkflowApi } from "lightflow-engine/compat/api";

let _store: Store | null = null;
let _engine: Engine | null = null;
let _worker: Promise<void> | null = null;

async function boot(): Promise<void> {
  const url = process.env.LIGHTFLOW_PG_URL ?? process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      "LIGHTFLOW_PG_URL (or POSTGRES_URL) is required for the Entry run engine",
    );
  }
  console.log("[run-engine] BOOT LOG starting", process.env.LIGHTFLOW_PG_URL?.slice(-12));
  _store = await createPostgresStore(url);
  _engine = new Engine(_store, { pollMs: 50 });
  initWorkflowApi(_store, _engine);
  // Resumes suspended runs (sleep timers, crashed workers) and keeps
  // polling. Idempotent per process; clients are unref'd so this never
  // blocks shutdown.
  _worker = _engine.startWorker();
}

/**
 * Called from instrumentation.ts register(). Safe to call multiple times.
 */
export function startRunEngine(): Promise<void> {
  if (!_worker) _worker = boot();
  return _worker;
}

export function getRunEngine(): { store: Store; engine: Engine } {
  if (!_store || !_engine) throw new Error("run engine not started — call startRunEngine() at boot");
  return { store: _store, engine: _engine };
}

export async function stopRunEngine(): Promise<void> {
  if (_engine) _engine.stopWorker();
  if (_worker) await _worker;
  _worker = null;
}
