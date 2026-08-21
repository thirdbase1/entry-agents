import { NextResponse } from "next/server";
import {
  getBenchmarkRunResults,
  listRecentBenchmarkRuns,
} from "@/lib/db/benchmarks";

export const maxDuration = 60;

// TEMPORARY diagnostic route -- dumps raw per-task benchmark_results
// rows (including error_message, which the public/admin aggregate
// views deliberately don't expose) for the most recent run, so a
// suspicious pass-rate (e.g. 0/20 across every model) can be root
// caused instead of guessed at. Gated by the same one-off
// AUDIT_ROUTE_SECRET(_LIVE) pattern as the other admin diagnostic
// routes (see reasoning-probe/route.ts). Delete once the 0/20
// HumanEval investigation is resolved.
export async function GET(request: Request) {
  const expected = process.env.AUDIT_ROUTE_SECRET;
  const expectedLive = process.env.AUDIT_ROUTE_SECRET_LIVE;
  const provided = request.headers.get("x-audit-secret");
  if (!provided || (provided !== expected && provided !== expectedLive)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const runIdParam = searchParams.get("runId");

  const runId =
    runIdParam ?? (await listRecentBenchmarkRuns(1)).at(0)?.id ?? null;
  if (!runId) {
    return NextResponse.json({ error: "No runs found" }, { status: 404 });
  }

  const results = await getBenchmarkRunResults(runId);
  return NextResponse.json({ runId, results });
}
