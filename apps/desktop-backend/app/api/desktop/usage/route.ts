import { NextRequest, NextResponse } from "next/server";
import { requireDesktopUser, unauthorized } from "@/lib/auth";
import { recordUsage } from "@/lib/db/usage";
import type { UIMessage } from "ai";

export const runtime = "nodejs";

/**
 * POST /api/desktop/usage — record desktop model usage through the SAME
 * recordUsage() the web workflow calls (same usage_events table, same
 * columns). The desktop client reports raw token counts only; cost is
 * computed server-side from the same pricing catalog shape web uses.
 * source: "desktop" distinguishes the surface (schema enum widened).
 */
interface UsageBody {
  modelId: string;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  toolCallCount?: number;
  messages?: UIMessage[];
}

export async function POST(req: NextRequest) {
  const user = await requireDesktopUser(req);
  if (!user) return unauthorized();

  let body: UsageBody;
  try {
    body = (await req.json()) as UsageBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { modelId, inputTokens, outputTokens } = body;
  if (
    !modelId ||
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number" ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return NextResponse.json(
      { error: "modelId, inputTokens, outputTokens required" },
      { status: 400 },
    );
  }

  await recordUsage(user.id, {
    source: "desktop",
    agentType: "main",
    model: modelId,
    messages: body.messages ?? [],
    usage: {
      inputTokens,
      cachedInputTokens: body.cachedInputTokens ?? 0,
      outputTokens,
    },
    toolCallCount: body.toolCallCount,
  });

  return NextResponse.json({ ok: true, source: "desktop" });
}
