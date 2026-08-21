import { NextResponse } from "next/server";
import { getLatestBenchmarkRunSummary } from "@/lib/db/benchmarks";

export const dynamic = "force-dynamic";

/**
 * Public, read-only endpoint backing the /benchmarks page's live
 * polling. Deliberately unauthenticated -- it only ever reads
 * already-computed aggregate results (same shape rendered server-side
 * on first load), never triggers a run itself. Triggering a run is a
 * separate, protected path (app/api/cron/run-benchmarks or the
 * session-gated admin server actions in lib/admin/actions.ts).
 */
export async function GET() {
  const summary = await getLatestBenchmarkRunSummary();
  return NextResponse.json(
    { summary },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
