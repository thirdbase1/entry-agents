import { NextRequest, NextResponse } from "next/server";
import { requireDesktopUser, unauthorized } from "@/lib/auth";
import { createChat, getChatById } from "@/lib/db/sessions";
import { db } from "@/lib/db/client";
import { sessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

/**
 * POST /api/desktop/chats — create (or fetch) a chat owned by the
 * authenticated desktop user. Reuses the REAL apps/web lib/db functions —
 * same schema, same ownership chain (chats.sessionId → sessions.userId),
 * no desktop-specific persistence.
 *
 * A sessionId is REQUIRED because chats.session_id is NOT NULL and every
 * chat belongs to a session the user owns.
 */
interface CreateChatBody {
  chatId: string;
  sessionId: string;
  title?: string;
  modelId?: string;
}

export async function POST(req: NextRequest) {
  const user = await requireDesktopUser(req);
  if (!user) return unauthorized();

  let body: CreateChatBody;
  try {
    body = (await req.json()) as CreateChatBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.chatId || !body.sessionId) {
    return NextResponse.json(
      { error: "chatId and sessionId required" },
      { status: 400 },
    );
  }

  // The referenced session MUST belong to this user — this is the
  // ownership chain check (sessions.userId), not an existence probe.
  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, body.sessionId),
  });
  if (!session || session.userId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const existing = await getChatById(body.chatId);
  if (existing) {
    if (existing.sessionId !== body.sessionId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ chat: existing });
  }

  const chat = await createChat({
    id: body.chatId,
    sessionId: body.sessionId,
    title: body.title ?? "Desktop chat",
    modelId: body.modelId ?? null,
  });

  return NextResponse.json({ chat });
}
