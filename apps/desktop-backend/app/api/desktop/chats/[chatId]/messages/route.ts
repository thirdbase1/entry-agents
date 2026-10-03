import { NextRequest, NextResponse } from "next/server";
import { requireDesktopUser, unauthorized } from "@/lib/auth";
import {
  createChatMessageIfNotExists,
  getChatById,
  getChatMessages,
  touchChat,
} from "@/lib/db/sessions";
import { db } from "@/lib/db/client";
import { sessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

/**
 * POST /api/desktop/chats/:chatId/messages — append a message (idempotent
 * on id via createChatMessageIfNotExists, same as web). The web chat page
 * expects chat_messages.parts to hold the WHOLE UIMessage ({id, role,
 * parts[]}) — mirroring apps/web/app/api/chat/route.ts — so that shape is
 * stored verbatim. Legacy desktop clients that sent a bare parts array are
 * wrapped into the full message shape on ingest so both render on web.
 */
interface AppendMessageBody {
  messageId: string;
  role: "user" | "assistant";
  parts: unknown;
}

/** Wrap a legacy bare parts array into the full stored UIMessage shape. */
function toStoredMessage(body: AppendMessageBody): unknown {
  const p = body.parts as unknown;
  if (Array.isArray(p)) {
    return {
      id: body.messageId,
      role: body.role,
      parts: p,
    };
  }
  return p;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> },
) {
  const user = await requireDesktopUser(req);
  if (!user) return unauthorized();
  const { chatId } = await params;

  let body: AppendMessageBody;
  try {
    body = (await req.json()) as AppendMessageBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (
    !body.messageId ||
    (body.role !== "user" && body.role !== "assistant") ||
    typeof body.parts !== "object" ||
    body.parts === null
  ) {
    return NextResponse.json(
      { error: "messageId, role (user|assistant), parts required" },
      { status: 400 },
    );
  }
  // Validate like web: parts entries must be objects with a string `type`.
  // (The old text-only check rejected web-shape parts such as step-start and
  // data-user-message, which the web UI needs to render desktop chats 1:1.)
  const partsForValidation = Array.isArray(body.parts)
    ? body.parts
    : ((body.parts as { parts?: unknown }).parts ?? []);
  if (
    !Array.isArray(partsForValidation) ||
    !partsForValidation.every(
      (p) =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as { type?: unknown }).type === "string",
    )
  ) {
    return NextResponse.json(
      { error: "messageId, role (user|assistant), parts[] required" },
      { status: 400 },
    );
  }

  const chat = await getChatById(chatId);
  if (!chat) {
    return NextResponse.json({ error: "Not found" }, { status: 403 });
  }
  const session = chat.sessionId
    ? await db.query.sessions.findFirst({ where: eq(sessions.id, chat.sessionId) })
    : undefined;
  if (!session || session.userId !== user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const message = await createChatMessageIfNotExists({
    id: body.messageId,
    chatId,
    role: body.role,
    parts: toStoredMessage(body),
  } as never);
  await touchChat(chatId);

  return NextResponse.json({ message: message ?? null });
}

/**
 * GET /api/desktop/chats/:chatId/messages — all stored messages for the
 * chat, in order. The desktop client uses this to materialize server-side
 * chats (created on web or another machine) into its local sidebar.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> },
) {
  const user = await requireDesktopUser(req);
  if (!user) return unauthorized();
  const { chatId } = await params;
  try {
    const chat = await getChatById(chatId);
    if (!chat) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const messages = await getChatMessages(chatId);
    return NextResponse.json({ messages });
  } catch (error) {
    console.error("GET /api/desktop/chats/:id/messages failed:", error);
    return NextResponse.json({ error: "Failed to list messages" }, { status: 500 });
  }
}
