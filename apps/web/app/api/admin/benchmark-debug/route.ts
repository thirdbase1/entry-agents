import { NextResponse } from "next/server";
import {
  getBenchmarkRunResults,
  listRecentBenchmarkRuns,
} from "@/lib/db/benchmarks";
import { getDisabledModelIdSet } from "@/lib/db/model-overrides";
import { isModelHardBlocked } from "@/lib/model-availability";

export const maxDuration = 60;

// TEMPORARY diagnostic route -- dumps raw per-task benchmark_results
// rows (including error_message, which the public/admin aggregate
// views deliberately don't expose) for the most recent run, so a
// suspicious pass-rate (e.g. 0/N across a model) can be root caused
// instead of guessed at. Gated by the same one-off
// AUDIT_ROUTE_SECRET(_LIVE) pattern as the other admin diagnostic
// routes. Delete once the current investigation is resolved.
export async function GET(request: Request) {
  const expected = process.env.AUDIT_ROUTE_SECRET;
  const expectedLive = process.env.AUDIT_ROUTE_SECRET_LIVE;
  const provided = request.headers.get("x-audit-secret");
  if (!provided || (provided !== expected && provided !== expectedLive)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runs = await listRecentBenchmarkRuns(3);
  const latest = runs[0];
  if (!latest) {
    return NextResponse.json({ error: "No runs found" }, { status: 404 });
  }
  const results = await getBenchmarkRunResults(latest.id);
  const disabledIds = await getDisabledModelIdSet();
  const modelAvailability = Object.fromEntries(
    (latest.modelIds as string[]).map((id: string) => [
      id,
      {
        hardBlocked: isModelHardBlocked(id),
        adminDisabled: disabledIds.has(id),
      },
    ]),
  );
  return NextResponse.json({ run: latest, results, modelAvailability });
}
