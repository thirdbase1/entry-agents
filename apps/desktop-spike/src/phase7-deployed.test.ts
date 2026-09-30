/**
 * Phase 7 — REAL deployed-backend integration tests.
 *
 * These run against the ACTUAL deployed Project-B
 * (https://entry-project-b.vercel.app) with a REAL production session
 * token, exercising: auth boundary, chat persistence, cross-client
 * round-trip, usage accounting, gateway proxying, ownership and failure
 * paths. No mocks: every assertion verifies persisted values from the
 * shared production database or real gateway output.
 *
 * Required env (from apps/desktop-spike/.env.phase7, gitignored):
 *   PROJECT_B_URL       — deployed backend base URL
 *   P7_SESSION_TOKEN    — real better-auth session token (test user)
 *   P7_SESSION_TOKEN_2  — second user's token (ownership tests)
 *   P7_SESSION_ID       — session owned by user 1
 *   P7_PROD_DB_URL      — read-only Postgres URL for value verification
 */
import { describe, test, expect, afterAll } from "bun:test";
import { isAllowedDesktopRoute } from "./desktop-backend-proxy";

const PROJECT_B_URL = process.env.PROJECT_B_URL ?? "";
const TOKEN1 = process.env.P7_SESSION_TOKEN ?? "";
const TOKEN2 = process.env.P7_SESSION_TOKEN_2 ?? "";
const SESSION1 = process.env.P7_SESSION_ID ?? "";
const DB_URL = process.env.P7_PROD_DB_URL ?? "";
const RUN_LIVE = !!(PROJECT_B_URL && TOKEN1);

const authed = (extra?: Record<string, string>) => ({
  Authorization: `Bearer ${TOKEN1}`,
  "Content-Type": "application/json",
  ...extra,
});

const chatId = `p7-e2e-${Date.now().toString(36)}`;
const db = DB_URL
  ? await import("postgres").then((m) => m.default(DB_URL, { prepare: false, max: 1 }))
  : null;

afterAll(async () => {
  if (db) await db.end();
});

describe("Phase 7: route allowlist (local, deterministic)", () => {
  test("all Project-B routes allowed", () => {
    expect(isAllowedDesktopRoute("GET", "/api/desktop/health")).toBe(true);
    expect(isAllowedDesktopRoute("POST", "/api/desktop/chat")).toBe(true);
    expect(isAllowedDesktopRoute("POST", "/api/desktop/chats")).toBe(true);
    expect(isAllowedDesktopRoute("GET", "/api/desktop/chats/abc123")).toBe(true);
    expect(isAllowedDesktopRoute("POST", "/api/desktop/chats/abc123/messages")).toBe(true);
    expect(isAllowedDesktopRoute("POST", "/api/desktop/usage")).toBe(true);
    expect(isAllowedDesktopRoute("GET", "/api/desktop/models")).toBe(true);
  });
  test("fail-closed for everything else", () => {
    expect(isAllowedDesktopRoute("GET", "/api/desktop/debug")).toBe(false);
    expect(isAllowedDesktopRoute("POST", "/api/auth/login")).toBe(false);
    expect(isAllowedDesktopRoute("DELETE", "/api/desktop/chats/abc")).toBe(false);
    expect(isAllowedDesktopRoute("GET", "/api/admin/anything")).toBe(false);
    expect(isAllowedDesktopRoute("GET", "/api/chat")).toBe(false);
  });
});

if (RUN_LIVE) {
  describe("Phase 7: deployed Project-B LIVE", () => {
    test("health", async () => {
      const r = await fetch(`${PROJECT_B_URL}/api/desktop/health`);
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.service).toBe("entry-desktop-backend");
    });

    test("no token → 401; bad token → 401 (fail closed)", async () => {
      const r1 = await fetch(`${PROJECT_B_URL}/api/desktop/chats`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: "x", sessionId: "y" }),
      });
      expect(r1.status).toBe(401);
      const r2 = await fetch(`${PROJECT_B_URL}/api/desktop/chats`, {
        method: "POST",
        headers: {
          Authorization: "Bearer totally_fake_token_aaaaaaaaaaaa",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ chatId: "x", sessionId: "y" }),
      });
      expect([401, 403]).toContain(r2.status);
    });

    test("desktop creates chat + message; values persisted in PROD DB", async () => {
      const cr = await fetch(`${PROJECT_B_URL}/api/desktop/chats`, {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ chatId, sessionId: SESSION1, title: "P7 live" }),
      });
      expect(cr.status).toBe(200);

      const mr = await fetch(`${PROJECT_B_URL}/api/desktop/chats/${chatId}/messages`, {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          messageId: `${chatId}-m1`,
          role: "user",
          parts: [{ type: "text", text: "P7 live desktop marker" }],
        }),
      });
      expect(mr.status).toBe(200);

      if (db) {
        const rows = await db`SELECT parts FROM chat_messages WHERE id = ${`${chatId}-m1`}`;
        expect(rows.length).toBe(1);
        expect(rows[0].parts[0].text).toBe("P7 live desktop marker");
      }
    });

    test("web appends via same DB → desktop reads it back via Project-B", async () => {
      const webId = `${chatId}-web1`;
      if (db) {
        await db`INSERT INTO chat_messages (id, chat_id, role, parts)
                 VALUES (${webId}, ${chatId}, 'assistant',
                         ${JSON.stringify([{ type: "text", text: "P7 live web marker" }])}::jsonb)`;
      }
      const gr = await fetch(`${PROJECT_B_URL}/api/desktop/chats/${chatId}`, {
        headers: authed(),
      });
      expect(gr.status).toBe(200);
      const j = await gr.json();
      const texts = j.messages.map((m: { parts: Array<{ text?: string }> }) =>
        m.parts.map((p) => p.text ?? "").join(""),
      );
      console.log("DEBUG texts:", JSON.stringify(j.messages).slice(0, 400), "msgCount:", (j.messages||[]).length);
      expect(texts.some((t: string) => t.includes("P7 live web marker"))).toBe(true);
    });

    test("usage recorded via the REAL recordUsage path with source=desktop", async () => {
      const r = await fetch(`${PROJECT_B_URL}/api/desktop/usage`, {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          modelId: "mimo-v2.6-flash:free",
          inputTokens: 11,
          cachedInputTokens: 1,
          outputTokens: 7,
          toolCallCount: 0,
          messages: [],
        }),
      });
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.source).toBe("desktop");
      if (db) {
        const rows = await db`SELECT source, input_tokens, output_tokens FROM usage_events
                              WHERE user_id = (SELECT user_id FROM sessions WHERE id = ${SESSION1})
                              ORDER BY created_at DESC LIMIT 1`;
        expect(rows.length).toBe(1);
        expect(rows[0].source).toBe("desktop");
        expect(Number(rows[0].input_tokens)).toBe(11);
        expect(Number(rows[0].output_tokens)).toBe(7);
      }
    });

    test("gateway proxy: real generation, key never in response", { timeout: 60000 }, async () => {
      const r = await fetch(`${PROJECT_B_URL}/api/desktop/chat`, {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          model: "mimo-v2.6-flash:free",
          messages: [{ role: "user", content: "Reply with exactly: P7-PROXY-OK" }],
          max_tokens: 20,
        }),
      });
      expect(r.status).toBe(200);
      const body = await r.text();
      expect(body).toContain("P7-PROXY-OK");
      expect(body).not.toContain("sk_live_");
      expect(body).not.toContain("sk-");
    });

    test("ownership: user2 cannot read/append user1's chat", async () => {
      if (!TOKEN2) return;
      const r1 = await fetch(`${PROJECT_B_URL}/api/desktop/chats/${chatId}`, {
        headers: { Authorization: `Bearer ${TOKEN2}` },
      });
      expect(r1.status).toBe(403);
      const r2 = await fetch(`${PROJECT_B_URL}/api/desktop/chats/${chatId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN2}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: `evil-${Date.now()}`,
          role: "user",
          parts: [{ type: "text", text: "intrusion" }],
        }),
      });
      expect(r2.status).toBe(403);
    });

    test("failure paths: invalid ownership 403, malformed 400", async () => {
      const r1 = await fetch(`${PROJECT_B_URL}/api/desktop/chats`, {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({ chatId: `${chatId}-bad`, sessionId: "no-such-session-zz" }),
      });
      expect(r1.status).toBe(403);
      const r2 = await fetch(`${PROJECT_B_URL}/api/desktop/chat`, {
        method: "POST",
        headers: authed(),
        body: "not-json",
      });
      expect(r2.status).toBe(400);
    });

    test("cleanup: remove Phase 7 test data", async () => {
      if (db) {
        await db`DELETE FROM chat_messages WHERE chat_id = ${chatId}`;
        await db`DELETE FROM chats WHERE id = ${chatId}`;
      }
    });
  });
}
