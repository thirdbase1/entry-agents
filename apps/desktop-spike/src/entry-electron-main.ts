/**
 * Phase 6 — real Electron main. Boots the OAgent shell pattern with the
 * Entry IPC handler registered. The renderer (minimal test harness) talks
 * ONLY over these IPC channels.
 *
 * Secrets: this process receives ONLY the Desktop Backend base URL and the
 * short-lived session token (from the user's sign-in) — never the Gateway
 * key, DB credentials, or auth secrets. The token is passed per-call through
 * the agent's gatewayConfig seam, so it does not even sit in this process's
 * environment for agent-run subprocesses to read.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { EntryAgentHandler } from "./entry-agent.handler.ts";

// Desktop session transport (from sign-in; in this spike, from env of the
// LAUNCHER — which is the user's own shell, not the packaged app).
const BACKEND_BASE_URL = process.env.ENTRY_DESKTOP_BACKEND_URL ?? "";
const DESKTOP_SESSION_TOKEN = process.env.ENTRY_DESKTOP_SESSION_TOKEN ?? "";
const MODEL_ID = process.env.ENTRY_DESKTOP_MODEL ?? "mimo-v2.6-flash:free";

if (!BACKEND_BASE_URL || !DESKTOP_SESSION_TOKEN) {
  console.error("[entry] ENTRY_DESKTOP_BACKEND_URL / ENTRY_DESKTOP_SESSION_TOKEN required");
  app.quit();
}

const entryHandler = new EntryAgentHandler(
  () => ({ baseURL: BACKEND_BASE_URL, sessionToken: DESKTOP_SESSION_TOKEN }),
  () => MODEL_ID,
);

const DIST_DIR =
  typeof __dirname !== "undefined"
    ? __dirname
    : ".";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(DIST_DIR, "entry-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Stream renderer console messages to stdout so the harness can assert.
  // Electron 40 passes a single event object; older versions pass positional args.
  win.webContents.on("console-message", (...args: unknown[]) => {
    const first = args[0] as { message?: string };
    const message =
      typeof first?.message === "string" ? first.message : String(args[2] ?? "");
    console.log("[renderer]", message);
    if (message.includes("E2E_DONE")) {
      console.log("=== RENDERER E2E COMPLETE ===");
      setTimeout(() => app.quit(), 500);
    }
  });

  // Spike harness page: drives the real IPC surface end-to-end.
  const target = process.env.ENTRY_E2E_PROJECT_ROOT
    ? `file://${join(DIST_DIR, "entry-renderer.html")}?root=${encodeURIComponent(process.env.ENTRY_E2E_PROJECT_ROOT)}&mode=${encodeURIComponent(process.env.ENTRY_E2E_MODE ?? "multistep")}`
    : join(DIST_DIR, "entry-renderer.html");
  win.loadURL(target);
  win.once("ready-to-show", () => win.show());
  return void win;
}

app.whenReady().then(() => {
  entryHandler.register();

  // Renderer-facing surface a renderer may query — project selection stays
  // renderer-driven, but every privileged operation goes through main.
  ipcMain.handle("entry:pick-project", async () => {
    const { dialog } = await import("electron");
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  entryHandler.disposeAll().finally(() => app.quit());
});
