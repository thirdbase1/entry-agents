/**
 * Phase 5 — REAL end-to-end native runtime test.
 *
 *   EntryAgentHost (Electron-main-style)
 *     → model request to the local Desktop-Backend stub
 *        → stub forwards to the REAL Entry Gateway using the REAL key
 *     → model streams back
 *     → openAgent() executes the write tool through LocalSandbox
 *     → file appears on the user's disk
 *
 * This proves BOTH halves at once:
 *   - the agent runs natively/local (no Next.js, no Vercel Workflow),
 *   - the gateway credential stays server-side: the Electron-side process
 *     env holds only a session token, and the "backend" is what talks to
 *     the gateway with the real key.
 *
 * Requires the same env as the Phase 1 spike (apps/desktop-spike/.env):
 *   GATEWAY_BASE_URL, GATEWAY_API_KEY   (test-only, gitignored)
 * If absent, every test here is BLOCKED (skipped), never faked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { EntryAgentHost, type DesktopIpcEvent } from "./desktop-host.ts";

const REAL_GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL;
const REAL_GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;
const MODEL = process.env.SPIKE_MODEL ?? "mimo-v2.6-flash:free";
const enabled = Boolean(REAL_GATEWAY_BASE_URL && REAL_GATEWAY_API_KEY);

const tmpRoots: string[] = [];
const REAL_KEY = REAL_GATEWAY_API_KEY ?? "";
/** What the Electron-side process is ALLOWED to hold. */
const DESKTOP_SESSION_TOKEN = "desktop-session-token-local-test";

let backend: http.Server;
let backendPort = 0;
const observedAuthorization: string[] = [];

if (enabled) {
  beforeAll(async () => {
    // The Desktop Backend stub = the deployment that owns the gateway key.
    // It authenticates the desktop session token, then calls the real
    // gateway with the real key (which never leaves this server).
    backend = http.createServer(async (req, res) => {
      const auth = String(req.headers.authorization ?? "");
      observedAuthorization.push(auth);
      if (auth !== `Bearer ${DESKTOP_SESSION_TOKEN}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (!req.url?.startsWith("/v1/chat/completions")) {
        res.writeHead(404).end("{}");
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const upstream = await fetch(
        `${REAL_GATEWAY_BASE_URL.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${REAL_KEY}`,
            accept: req.headers.accept ?? "text/event-stream",
          },
          body,
        },
      );
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      });
      if (upstream.body) {
        for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
      }
      res.end();
    });
    await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
    backendPort = (backend.address() as net.AddressInfo).port;

    // From here on, the "Electron process" must NOT have the real key.
    delete process.env.GATEWAY_API_KEY;
  });

  afterAll(async () => {
    backend.close();
    await Promise.all(
      tmpRoots.map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });
}

async function makeRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "entry-e2e-"));
  tmpRoots.push(dir);
  return dir;
}

describe("Phase 5 end-to-end: local agent + server-side gateway credential", () => {
  test.skipIf(!enabled)(
    "host → backend stub → real gateway → model → write tool → real file on disk",
    async () => {
      const root = await makeRoot();
      // The desktop-side process holds NO real gateway key.
      expect(process.env.GATEWAY_API_KEY).toBeUndefined();

      const host = new EntryAgentHost({
        projectRoot: root,
        backend: {
          baseURL: `http://127.0.0.1:${backendPort}/v1`,
          sessionToken: DESKTOP_SESSION_TOKEN,
        },
        modelId: MODEL,
      });
      await host.start();

      const events: DesktopIpcEvent[] = [];
      try {
        await host.send(
          'Create a file named exactly "host-proof.txt" in the current directory. ' +
            'Its entire content must be exactly this one line: written by the native host',
          (e) => events.push(e),
        );

        // 1) Credential boundary: the backend saw ONLY the session token.
        expect(observedAuthorization.length).toBeGreaterThan(0);
        for (const auth of observedAuthorization) {
          expect(auth).toBe(`Bearer ${DESKTOP_SESSION_TOKEN}`);
          expect(auth).not.toContain(REAL_KEY);
        }

        // 2) The stream adapter delivered a well-formed turn with a tool call.
        expect(events[0]).toMatchObject({ type: "turn-started" });
        const kinds = events.map((e) => e.type);
        expect(kinds).toContain("tool-call");
        expect(kinds).toContain("tool-result");
        expect(kinds).toContain("turn-finished");

        // 3) The write executed locally through LocalSandbox: real file.
        const file = path.join(root, "host-proof.txt");
        const content = (await fs.readFile(file, "utf-8")).trim();
        expect(content).toBe("written by the native host");
      } finally {
        await host.stop();
      }
    },
    180_000,
  );

  test.skipIf(!enabled)(
    "usage events are emitted with real token counts from the gateway",
    async () => {
      const root = await makeRoot();
      const host = new EntryAgentHost({
        projectRoot: root,
        backend: {
          baseURL: `http://127.0.0.1:${backendPort}/v1`,
          sessionToken: DESKTOP_SESSION_TOKEN,
        },
        modelId: MODEL,
      });
      await host.start();
      const events: DesktopIpcEvent[] = [];
      try {
        await host.send("Reply with exactly: ok", (e) => events.push(e));
      } finally {
        await host.stop();
      }
      const usage = events.find((e) => e.type === "usage");
      expect(usage).toBeDefined();
      // Real counts from the gateway — not fabricated. A trivial reply still
      // consumes >0 input tokens.
      const u = usage as Extract<DesktopIpcEvent, { type: "usage" }>;
      expect(u.inputTokens).toBeGreaterThan(0);
    },
    180_000,
  );

  test.skipIf(!enabled)(
    "cancellation: aborting a turn stops the stream",
    async () => {
      const root = await makeRoot();
      const host = new EntryAgentHost({
        projectRoot: root,
        backend: {
          baseURL: `http://127.0.0.1:${backendPort}/v1`,
          sessionToken: DESKTOP_SESSION_TOKEN,
        },
        modelId: MODEL,
      });
      await host.start();
      const events: DesktopIpcEvent[] = [];
      try {
        const turn = host.send(
          "Count slowly from 1 to 500, one number per line.",
          (e) => events.push(e),
        );
        setTimeout(() => void host.stop(), 1200);
        await turn;
        expect(events.map((e) => e.type)).toContain("stopped");
      } finally {
        await host.stop();
      }
    },
    120_000,
  );
});

describe("Phase 5 blocked-marker", () => {
  test("gateway env present?", () => {
    if (!enabled) {
      console.warn(
        "BLOCKED: GATEWAY_BASE_URL/GATEWAY_API_KEY not set — end-to-end tests skipped",
      );
    }
    expect(true).toBe(true);
  });
});
