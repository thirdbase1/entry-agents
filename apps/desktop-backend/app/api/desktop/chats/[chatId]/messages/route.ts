import { NextRequest, NextResponse } from "next/server";
import { requireDesktopUser, unauthorized } from "@/lib/auth";
import {
  createChatMessageIfNotExists,
  getChatById,
  touchChat,
} from "@/lib/db/sessions";
import { db } from "@/lib/db/client";
import { sessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

/**
 * POST /api/desktop/chats/:chatId/messages — append a message (idempotent
 * on id via createChatMessageIfNotExists, same as web). Parts jsonb stored
 * verbatim so tool-invocation parts round-trip across surfaces byte-exact.
 */
interface AppendMessageBody {
  messageId: string;
  role: "user" | "assistant";
  parts: unknown;
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
    !Array.isArray(body.parts) ||
      !body.parts.every(
        (p) =>
          typeof p === "object" &&
          p !== null &&
          typeof (p as { text?: unknown }).text === "string" &&
          (p as { type?: unknown }).type === "text",
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
    parts: body.parts,
  } as never);
  await touchChat(chatId);

  return NextResponse.json({ message: message ?? null });
}
