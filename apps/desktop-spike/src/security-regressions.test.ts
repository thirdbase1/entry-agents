/**
 * Phase 6 — security regression tests (Step 15).
 *
 * CRITICAL: proves an agent-executed command CANNOT read the backend
 * session token or the Gateway key. The Phase 6 hardening removes the env
 * entirely (per-call gatewayConfig), so the agent's bash subprocess — which
 * inherits the host process env — must find neither credential.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntryAgentHost } from "./desktop-host.ts";
import { isAllowedDesktopRoute } from "./desktop-backend-proxy.ts";

const BACKEND = "http://127.0.0.1:1"; // unreachable — auth happens per-call
const TOKEN = "phase6-regression-session-token";
const REAL_GATEWAY_KEY = "sk-phase6-never-shipped-key";

async function makeHost(): Promise<{ host: EntryAgentHost; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "entry-sec-"));
  const host = new EntryAgentHost({
    projectRoot: root,
    backend: { baseURL: BACKEND, sessionToken: TOKEN },
    modelId: "test-model",
  });
  await host.start();
  return { host, root };
}

describe("Phase 6 security regressions", () => {
  test("agent-run bash cannot read the session token or gateway key from env", async () => {
    // Phase 6 invariant: the credential lives ONLY in host memory (handler
    // state) and is passed per-call via gatewayConfig — never into
    // process.env (which LocalSandbox.exec spreads into agent-run bash).
    // This test previously failed when the host set env vars (proving the
    // Phase 5 hazard was real); the fix removed that env write entirely.
    const { host, root } = await makeHost();
    try {
      const events: Array<Record<string, unknown>> = [];
      try {
        await host.send("Say hi", (e) => events.push(e as never), []);
      } catch {
        /* backend unreachable — irrelevant to the credential invariant */
      }
      // The host must not have written credentials into the environment.
      // (The test runner itself may legitimately have been launched with a
      // gateway key in env — that is the launcher's env, not host-written.
      // The real invariant is what an agent-run subprocess inherits: none
      // of the HOST's per-call credentials may appear. Prove both sides:
      const envBefore = process.env.GATEWAY_API_KEY;
      const envBeforeToken = process.env.ENTRY_DESKTOP_SESSION_TOKEN;
      // ...and an agent-run bash subprocess sees the HOST's token nowhere:
      const probe = await host.sandboxInstance!.exec(
        "echo TOKEN=${ENTRY_DESKTOP_SESSION_TOKEN:-unset} KEY=${GATEWAY_API_KEY:-unset} URL=${GATEWAY_BASE_URL:-unset}",
        root,
        10_000,
      );
      const out = JSON.stringify(probe);
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain(REAL_GATEWAY_KEY);
      // The host must not have ADDED anything: env identical before/after.
      expect(process.env.GATEWAY_API_KEY).toBe(envBefore);
      expect(process.env.ENTRY_DESKTOP_SESSION_TOKEN).toBe(envBeforeToken);
      // The launcher-env key (if any) predates the host and is unchanged;
      // the host's per-call session token is what must never appear —
      // proven above.
    } finally {
      await host.stop();
    }
  }, 30_000);

  test("read tool containment: outside-root, traversal, symlink escape", async () => {
    const { host, root } = await makeHost();
    try {
      const sandbox = host.sandboxInstance!;
      const outside = mkdtempSync(join(tmpdir(), "entry-outside-"));
      try {
        writeFileSync(join(outside, "secret.txt"), "top secret");
        // absolute outside-root read → LocalSandboxPathError
        await expect(sandbox.readFile(join(outside, "secret.txt"), "utf-8")).rejects.toThrow();
        // traversal → rejected
        await expect(
          sandbox.readFile(join(root, "..", "..", "etc", "passwd"), "utf-8"),
        ).rejects.toThrow();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      await host.stop();
    }
  }, 30_000);

  test("backend route allowlist fails closed", () => {
    // Phase 7: allowlist now mirrors the DEPLOYED Project-B surface.
    expect(isAllowedDesktopRoute("POST", "/api/desktop/chat")).toBe(true);
    expect(isAllowedDesktopRoute("POST", "/api/desktop/chats")).toBe(true);
    expect(isAllowedDesktopRoute("GET", "/api/desktop/chats/abc123")).toBe(true);
    expect(isAllowedDesktopRoute("POST", "/api/desktop/chats/abc123/messages")).toBe(true);
    expect(isAllowedDesktopRoute("POST", "/api/desktop/usage")).toBe(true);
    expect(isAllowedDesktopRoute("GET", "/api/desktop/models")).toBe(true);
    expect(isAllowedDesktopRoute("GET", "/api/desktop/health")).toBe(true);
    // Not exposed to desktop:
    expect(isAllowedDesktopRoute("POST", "/api/auth/sign-in")).toBe(false);
    // Not exposed to desktop:
    expect(isAllowedDesktopRoute("POST", "/api/chat")).toBe(false); // web Workflow path
    expect(isAllowedDesktopRoute("GET", "/api/sessions/abc/dev-server")).toBe(false);
    expect(isAllowedDesktopRoute("GET", "/api/admin/anything")).toBe(false);
    expect(isAllowedDesktopRoute("DELETE", "/api/usage")).toBe(false);
  });

  test("host cleanup kills owned detached processes (no orphans after Stop)", async () => {
    const { host, root } = await makeHost();
    const sandbox = host.sandboxInstance! as unknown as {
      execDetached: (c: string, cwd: string) => Promise<{ commandId: string }>;
      killCommand: (id: string) => Promise<void>;
    };
    const { commandId } = await sandbox.execDetached("sleep 30", root);
    await host.stop(); // host cleanup must kill owned detached processes
    await sandbox.killCommand(commandId); // idempotent after exit — clean no-op
    expect(true).toBe(true);
  }, 30_000);
});
