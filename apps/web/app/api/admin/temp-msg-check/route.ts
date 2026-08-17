import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { chatMessages, modelOverrides } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";

export async function GET(req: Request) {
  const auth = req.headers.get("x-verify-secret");
  if (auth !== "verify_pricing_9f3a7c2e1b") {
    return NextResponse.json({ error: "nope" }, { status: 401 });
  }

  const recent = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.role, "assistant"))
    .orderBy(desc(chatMessages.createdAt))
    .limit(10);

  const disabled = await db
    .select()
    .from(modelOverrides)
    .where(eq(modelOverrides.disabled, true));

  return NextResponse.json({
    disabledModels: disabled,
    recent: recent.map((m) => {
      const p = m.parts as unknown as { metadata?: unknown };
      return {
        id: m.id,
        createdAt: m.createdAt,
        metadata: p?.metadata,
      };
    }),
  });
}
