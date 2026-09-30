/**
 * Phase 6 Step 14 — desktop↔web shared-DB persistence (live Postgres).
 * Uses the REAL apps/web lib/db functions for both "surfaces": the Desktop
 * Backend is the same deployment of apps/web + same functions, so proving
 * writes/reads through these functions proves the desktop persistence path
 * without a second schema or second usage system.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { nanoid } from "nanoid";
import * as postgres from "postgres";

const POSTGRES_URL = process.env.POSTGRES_URL ?? "";
if (!POSTGRES_URL) {
  console.error("POSTGRES_URL is required (local dev DB only, never commit)");
  process.exit(1);
}

type DbModule = typeof import("../../web/lib/db/sessions.ts");
let sessionsDb: DbModule;
let schema: typeof import("../../web/lib/db/schema.ts");
let sqlClient: postgres.Sql;
let userId: string;
let sessionId: string;
let chatId: string;

beforeAll(async () => {
  process.env.POSTGRES_URL = POSTGRES_URL;
  sqlClient = postgres.default(POSTGRES_URL, { max: 5 });
  schema = await import("../../web/lib/db/schema.ts");
  sessionsDb = (await import("../../web/lib/db/sessions.ts")) as unknown as DbModule;

  userId = nanoid();
  await sqlClient`
    INSERT INTO users (id, username, email, email_verified, plan)
    VALUES (${userId}, ${"p6-user-" + userId.slice(0, 6)}, ${"p6-" + userId.slice(0, 6) + "@example.test"}, true, 'free')
  `;
  // A project workspace session owned by that user (desktop sessions are
  // rooted at a local dir — schema supports it, see Phase 3/4 findings).
  sessionId = nanoid();
  await sessionsDb.createSession({
    id: sessionId,
    userId,
    title: "Phase 6 desktop session",
    globalSkillRefs: [],
    sandboxState: { type: "local", rootDir: "/tmp/entry-e2e-project" },
  } as never);
});

afterAll(async () => {
  // Cleanup — leave the shared dev DB as we found it. users has ON DELETE
  // CASCADE to sessions (and sessions → chats → chat_messages), so one
  // delete removes this identity's whole tree.
  await sqlClient`DELETE FROM users WHERE id = ${userId}`;
  const orphanSessions =
    await sqlClient`SELECT count(*)::int AS c FROM sessions WHERE id = ${sessionId}`;
  expect(orphanSessions[0]!.c).toBe(0);
  sqlClient.end();
});

describe("Phase 6 Step 14: desktop ↔ web shared DB", () => {
  test("desktop creates chat+messages → web reads identical → web appends → desktop reads", async () => {
    chatId = "p6-chat-" + nanoid(8);

    // Desktop surface: createChat through the REAL domain function
    await sessionsDb.createChat({
      id: chatId,
      sessionId,
      userId,
      title: "phase6 desktop chat",
    } as never);

    // Desktop writes a user message with tool-invocation parts
    const desktopParts = [
      { type: "text", text: "desktop hello" },
      {
        type: "tool-invocation",
        toolCallId: "call_x1",
        toolName: "write",
        state: "output-available",
        input: { filePath: "electron-proof.txt", content: "electron shell works" },
        output: { success: true, bytesWritten: 20 },
      },
    ] as never;
    await sessionsDb.createChatMessage({
      id: "p6-msg-" + nanoid(8),
      chatId,
      role: "user",
      parts: desktopParts,
    } as never);

    // Web surface: read back — identical. Ownership chains through the
    // session (chats has no userId column; Phase 3 finding).
    const chat = await sessionsDb.getChatById(chatId);
    expect((chat as unknown as { sessionId: string }).sessionId).toBe(sessionId);
    const owner = await sessionsDb.getSessionById(sessionId);
    expect(owner?.userId).toBe(userId);
    const msgs = await sessionsDb.getChatMessages(chatId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.parts).toEqual(desktopParts);

    // Reverse: web appends an assistant message → desktop reads it
    await sessionsDb.createChatMessage({
      id: "p6-msg-" + nanoid(8),
      chatId,
      role: "assistant",
      parts: [{ type: "text", text: "web reply" }] as never,
    } as never);
    const msgs2 = await sessionsDb.getChatMessages(chatId);
    expect(msgs2).toHaveLength(2);
    expect(msgs2[1]!.role).toBe("assistant");
  });
});
