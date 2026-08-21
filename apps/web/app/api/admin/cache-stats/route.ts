import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";

// TEMPORARY diagnostic route -- see docs/agents/lessons-learned.md
// 2026-08-21 "achieve >70% caching on FreeModel gpt models" entry.
// Reads real usage_events rows (no user content, only per-turn token
// counts) to compute actual production cache-hit ratio per model.
export async function GET(request: Request) {
  const expected = process.env.AUDIT_ROUTE_SECRET;
  const expectedLive = process.env.AUDIT_ROUTE_SECRET_LIVE;
  const provided = request.headers.get("x-audit-secret");
  if (!provided || (provided !== expected && provided !== expectedLive)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hours = Number(new URL(request.url).searchParams.get("hours") ?? 24);

  const rows = await db.execute(sql`
    select
      model_id,
      agent_type,
      count(*) as turn_count,
      sum(input_tokens) as total_input_tokens,
      sum(cached_input_tokens) as total_cached_tokens,
      avg(case when input_tokens > 0 then cached_input_tokens::float / input_tokens else null end) as avg_hit_ratio_per_turn
    from usage_events
    where created_at > now() - interval '1 hour' * ${hours}
      and model_id like 'gpt-5.6-%'
    group by model_id, agent_type
    order by model_id, agent_type
  `);

  return NextResponse.json({ hours, rows: rows });
}
