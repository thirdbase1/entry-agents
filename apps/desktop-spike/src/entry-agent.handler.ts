/**
 * Phase 6 — entry-agent.handler: the real Electron IPC surface for Entry.
 *
 * Follows the existing OAgent handler conventions (see
 * openagent/electron/src/handlers/title-gen.handler.ts:
 * `registerHandler(suffix, handler)` → ipcMain.handle(`oagent:${suffix}`)),
 * and the existing channel vocabulary (start/send/stop/interrupt/
 * permission_request/permission_response).
 *
 * Renderer (preload) can ONLY invoke these channels; it never touches
 * child_process, fs, LocalSandbox, or openAgent.
 */
import { ipcMain, type WebContents } from "electron";
import { EntryAgentHost, type DesktopIpcEvent } from "./desktop-host.ts";

/** Registry of live Entry sessions keyed by sessionId. */
export class EntryAgentHandler {
  private readonly sessions = new Map<
    string,
    { host: EntryAgentHost; sender: WebContents }
  >();

  constructor(
    /** Resolves the authenticated Desktop Backend transport for this user session. */
    private readonly resolveBackend: () => { baseURL: string; sessionToken: string },
    /** Resolves the model id (from the Desktop Backend's model catalog). */
    private readonly resolveModelId: () => string,
  ) {}

  /** Registers `entry:*` IPC handlers. Call once from Electron main. */
  register(): void {
    // Create a session: { projectRoot, allowedRoots? } → { sessionId }
    ipcMain.handle(
      "entry:create-session",
      async (_e, payload: { projectRoot: string; allowedRoots?: string[] }) => {
        const { EntryAgentHost: Host } = await import("./desktop-host.ts");
        const host = new Host({
          projectRoot: payload.projectRoot,
          allowedRoots: payload.allowedRoots,
          backend: this.resolveBackend(),
          modelId: this.resolveModelId(),
        });
        await host.start();
        const sessionId = crypto.randomUUID();
        this.sessions.set(sessionId, { host, sender: _e.sender });
        return { sessionId, projectRoot: payload.projectRoot };
      },
    );

    // Send a user message; events stream back over "entry:event".
    ipcMain.handle(
      "entry:send",
      async (_e, payload: { sessionId: string; text: string; history?: unknown[] }) => {
        const session = this.requireSession(payload.sessionId);
        session.host.send(payload.text, (event: DesktopIpcEvent) => {
          if (!session.sender.isDestroyed()) {
            session.sender.send("entry:event", { sessionId: payload.sessionId, event });
          }
        }, payload.history ?? []);
        return { ok: true };
      },
    );

    // Approval decision → host.respondToApproval (addToolApprovalResponse).
    ipcMain.handle(
      "entry:approval",
      (_e, payload: { sessionId: string; approvalId: string; approved: boolean; reason?: string }) => {
        const session = this.requireSession(payload.sessionId);
        const routed = session.host.respondToApproval(payload.approvalId, {
          approved: payload.approved,
          reason: payload.reason,
        });
        if (!routed) throw new Error(`Unknown approval id for this session: ${payload.approvalId}`);
        return { ok: true };
      },
    );

    // Stop/cancel: renderer "Stop" → AbortSignal → agent + sandbox.stop().
    ipcMain.handle("entry:stop", async (_e, payload: { sessionId: string }) => {
      const session = this.requireSession(payload.sessionId);
      await session.host.stop();
      return { ok: true };
    });

    // Dispose session (window close / project switch).
    ipcMain.handle("entry:dispose", async (_e, payload: { sessionId: string }) => {
      const session = this.sessions.get(payload.sessionId);
      if (!session) return { ok: true }; // idempotent
      await session.host.stop();
      this.sessions.delete(payload.sessionId);
      return { ok: true };
    });
  }

  /** Shuts down every live session (app quit). */
  async disposeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (!session) continue;
      await session.host.stop();
      this.sessions.delete(id);
    }
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Entry session: ${sessionId}`);
    return session;
  }
}
