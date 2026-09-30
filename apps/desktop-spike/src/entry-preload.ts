/**
 * Phase 6 — Electron preload for Entry. Exposes the narrowest possible
 * surface: invoke-only channels matching entry-agent.handler, plus the
 * event subscription. NO fs, NO child_process, NO Node primitives.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("entryAgent", {
  createSession: (projectRoot: string, allowedRoots?: string[]) =>
    ipcRenderer.invoke("entry:create-session", { projectRoot, allowedRoots }),
  pickProject: () => ipcRenderer.invoke("entry:pick-project"),
  send: (sessionId: string, text: string, history?: unknown[]) =>
    ipcRenderer.invoke("entry:send", { sessionId, text, history }),
  respondApproval: (
    sessionId: string,
    approvalId: string,
    approved: boolean,
    reason?: string,
  ) => ipcRenderer.invoke("entry:approval", { sessionId, approvalId, approved, reason }),
  stop: (sessionId: string) => ipcRenderer.invoke("entry:stop", { sessionId }),
  dispose: (sessionId: string) => ipcRenderer.invoke("entry:dispose", { sessionId }),
  onEvent: (listener: (payload: { sessionId: string; event: unknown }) => void) => {
    const wrapped = (_e: unknown, payload: { sessionId: string; event: unknown }) =>
      listener(payload);
    ipcRenderer.on("entry:event", wrapped);
    return () => ipcRenderer.removeListener("entry:event", wrapped);
  },
});
