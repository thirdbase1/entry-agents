import { db } from "@/lib/db/client";
import { chats } from "@/lib/db/schema";
import { eq, isNotNull, desc } from "drizzle-orm";
import { getRun } from "workflow/api";

/**
 * TEMPORARY secret-gated stream diagnostics (2026-09-15: owner reported
 * "something is wrong"; runtime logs show a chat stuck isStreaming ->
 * client polling every ~3s indefinitely). DELETED after use.
 */
const TEMP_SECRET = "stream-diag-9kQ2wmZ4Rq";

export async function GET() {
  return Response.json({ error: "POST only" }, { status: 405 });
}

export async function POST(request: Request) {
  if (request.headers.get("x-diag-secret") !== TEMP_SECRET) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    sessionId?: string;
    chatId?: string;
    fix?: boolean;
  };

  // Mode 1: list all chats with a non-null activeStreamId (stuck candidates)
  if (!body.chatId) {
    const stuck = await db
      .select({
        chatId: chats.id,
        sessionId: chats.sessionId,
        title: chats.title,
        activeStreamId: chats.activeStreamId,
        updatedAt: chats.updatedAt,
        lastAssistantMessageAt: chats.lastAssistantMessageAt,
      })
      .from(chats)
      .where(isNotNull(chats.activeStreamId))
      .orderBy(desc(chats.updatedAt))
      .limit(20);

    const withStatus: Array<Record<string, unknown>> = [];
    for (const c of stuck) {
      let runStatus: string = "unknown";
      try {
        const run = getRun(c.activeStreamId!);
        runStatus = await run.status;
      } catch (error) {
        runStatus = `not-found: ${String(error).slice(0, 80)}`;
      }
      withStatus.push({ ...c, runStatus });
    }
    return Response.json({ stuck: withStatus });
  }

  // Mode 2: one chat, deep detail
  const [chat] = await db
    .select()
    .from(chats)
    .where(eq(chats.id, body.chatId))
    .limit(1);
  if (!chat) {
    return Response.json({ error: "chat not found" }, { status: 404 });
  }

  let runStatus = "none";
  let fixResult: string | null = null;
  if (chat.activeStreamId) {
    try {
      const run = getRun(chat.activeStreamId);
      runStatus = await run.status;
      if (body.fix && runStatus !== "running") {
        await db
          .update(chats)
          .set({ activeStreamId: null })
          .where(eq(chats.id, chat.id));
        fixResult = `cleared (run was ${runStatus})`;
      } else if (body.fix && runStatus === "running") {
        try {
          await run.cancel();
          await db
            .update(chats)
            .set({ activeStreamId: null })
            .where(eq(chats.id, chat.id));
          fixResult = "cancelled run + cleared";
        } catch (error) {
          fixResult = `cancel failed: ${String(error).slice(0, 120)}`;
        }
      }
    } catch (error) {
      runStatus = `not-found: ${String(error).slice(0, 80)}`;
      if (body.fix) {
        await db
          .update(chats)
          .set({ activeStreamId: null })
          .where(eq(chats.id, chat.id));
        fixResult = "cleared (run not found)";
      }
    }
  }

  return Response.json({
    chat: {
      id: chat.id,
      sessionId: chat.sessionId,
      title: chat.title,
      activeStreamId: chat.activeStreamId,
      runStatus,
      updatedAt: chat.updatedAt,
      createdAt: chat.createdAt,
      lastAssistantMessageAt: chat.lastAssistantMessageAt,
    },
    fixResult,
  });
}

