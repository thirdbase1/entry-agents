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
 * chat belongs to a session the user owns. Desktop clients that don't have
 * a web agent session pass desktop:true — the route then auto-provisions a
 * minimal owned "desktop" agent session and binds the chat to it.
 */
interface CreateChatBody {
  chatId: string;
  sessionId?: string;
  title?: string;
  modelId?: string;
  desktop?: boolean;
}

async function ensureDesktopAgentSession(userId: string, title: string) {
  const id = `desktop-${crypto.randomUUID()}`;
  await db.insert(sessions).values({
    id,
    userId,
    title: title.slice(0, 80) || "Desktop chat",
    status: "completed",
  });
  return id;
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
  if (!body.chatId) {
    return NextResponse.json({ error: "chatId required" }, { status: 400 });
  }

  let sessionId = body.sessionId;
  if (sessionId) {
    // The referenced session MUST belong to this user — this is the
    // ownership chain check (sessions.userId), not an existence probe.
    const session = await db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    });
    if (!session || session.userId !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (body.desktop) {
    sessionId = await ensureDesktopAgentSession(user.id, body.title ?? "Desktop chat");
  } else {
    return NextResponse.json(
      { error: "chatId and sessionId required" },
      { status: 400 },
    );
  }

  const existing = await getChatById(body.chatId);
  if (existing) {
    if (existing.sessionId !== sessionId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.json({ chat: existing });
  }

  const chat = await createChat({
    id: body.chatId,
    sessionId,
    title: body.title ?? "Desktop chat",
    modelId: body.modelId ?? null,
  });

  return NextResponse.json({ chat });
}
