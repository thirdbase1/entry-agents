import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { runBenchmarkSuiteWorkflow } from "@/app/workflows/run-benchmarks";

export const dynamic = "force-dynamic";

/**
 * Kicks off a full HumanEval benchmark run as a durable Vercel Workflow
 * (see app/workflows/run-benchmarks.ts for why this can't be a plain
 * synchronous request -- real multi-model, multi-task agent runs take
 * far longer than one serverless request's timeout).
 *
 * Two callers, both intentional:
 *  - Vercel Cron (if/when a schedule is added to vercel.json) -- auth'd
 *    via CRON_SECRET like the existing telegram-alerts cron route.
 *  - Manual trigger (owner curl, or a future admin-page button) using
 *    the same CRON_SECRET as a bearer token -- this is deliberately NOT
 *    a public, unauthenticated endpoint: each run spends real money
 *    against real metered model APIs.
 *
 * Returns immediately with the workflow's runId; the run itself
 * continues in the background and is inspectable via the workflow
 * platform's own run history, plus benchmark_runs/benchmark_results in
 * the DB once individual steps start completing.
 */
export async function POST(req: Request) {
  // SECURITY FIX (2026-08-27, pentest finding): this used to fail OPEN
  // -- `if (cronSecret) { ...check... }` skipped the entire auth check
  // whenever CRON_SECRET was unset (accidentally removed from env,
  // never configured on a preview deployment, etc.), silently turning
  // this into a real unauthenticated endpoint. That's the wrong
  // failure mode for an auth guard on a route that spends real money /
  // mutates real state -- fail closed instead: no secret configured
  // means no request gets through, full stop.
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "Server misconfigured: CRON_SECRET is not set" },
      { status: 500 },
    );
  }
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let modelIds: string[] | undefined;
  try {
    const body = await req.json();
    if (
      Array.isArray(body?.modelIds) &&
      body.modelIds.every((m: unknown) => typeof m === "string")
    ) {
      modelIds = body.modelIds;
    }
  } catch {
    // No body / not JSON -- fine, use the workflow's own default model list.
  }

  const triggeredBy = cronSecret ? "cron" : "manual";

  try {
    const run = await start(
      runBenchmarkSuiteWorkflow,
      modelIds ? [modelIds, triggeredBy] : [undefined, triggeredBy],
    );
    return NextResponse.json({ started: true, runId: run.runId });
  } catch (error) {
    console.error("Failed to start run-benchmarks workflow:", error);
    return NextResponse.json(
      { error: "Failed to start benchmark run" },
      { status: 500 },
    );
  }
}
