import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";

// TEMPORARY diagnostic route -- tests whether Postgres jsonb preserves
// object key insertion order on round-trip (relevant to the >70%
// FreeModel-caching investigation, 2026-08-21).
export async function GET(request: Request) {
  const expected = process.env.AUDIT_ROUTE_SECRET;
  const expectedLive = process.env.AUDIT_ROUTE_SECRET_LIVE;
  const provided = request.headers.get("x-audit-secret");
  if (!provided || (provided !== expected && provided !== expectedLive)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sample = {
    zebra: 1,
    apple: 2,
    mango: 3,
    banana: 4,
    tool_call_id: "call_abc123",
    type: "tool-call",
    input: { path: "src/foo.ts", content: "hello", encoding: "utf8" },
  };

  const result = await db.execute(sql`
    select ${JSON.stringify(sample)}::jsonb as roundtripped
  `);

  const roundtripped = (result[0] as { roundtripped: unknown })?.roundtripped;

  return NextResponse.json({
    originalKeyOrder: Object.keys(sample),
    originalStringified: JSON.stringify(sample),
    roundtrippedKeyOrder: Object.keys(roundtripped as Record<string, unknown>),
    roundtrippedStringified: JSON.stringify(roundtripped),
    keysPreserved:
      JSON.stringify(Object.keys(sample)) ===
      JSON.stringify(Object.keys(roundtripped as Record<string, unknown>)),
  });
}
