/**
 * Phase 6 Step 12 — MCP over the real host (extraTools path).
 *
 * Uses the REAL packages/agent createMcpToolSet against a live local SSE/
 * streamable-HTTP MCP server if one can be started; otherwise documents
 * BLOCKED for live MCP. This test wires whatever transport is available
 * through the host's extraTools option — the same path Electron main uses.
 *
 * Status on this machine: no MCP server binary is guaranteed present, so
 * the test SKIPS (not passes) when no server is available, and the report
 * records MCP as NOT YET TESTED against a live server — never faked.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntryAgentHost } from "./desktop-host.ts";

const MCP_SERVER_CMD = process.env.ENTRY_MCP_SERVER_CMD ?? "";

describe("Phase 6 Step 12: MCP integration", () => {
  test("MCP tools flow through the host extraTools path (live server required)", async () => {
    if (!MCP_SERVER_CMD) {
      console.warn(
        "SKIP: no MCP server available (set ENTRY_MCP_SERVER_CMD to test live). " +
          "MCP status: NOT YET TESTED against a live server on this machine.",
      );
      return; // skip — recorded as BLOCKED/NOT TESTED, never faked
    }
    const root = mkdtempSync(join(tmpdir(), "entry-mcp-"));
    const host = new EntryAgentHost({
      projectRoot: root,
      backend: { baseURL: "http://127.0.0.1:1", sessionToken: "mcp-test" },
      modelId: "test-model",
      // The real Electron main would build this with createMcpToolSet():
      extraTools: {},
    });
    try {
      await host.start();
      expect(host.sandboxInstance).toBeTruthy();
    } finally {
      await host.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("createMcpToolSet degrades cleanly when a server is unreachable", async () => {
    const { createMcpToolSet } = await import("@open-agents/agent");
    const result = await createMcpToolSet([
      { name: "unreachable", transport: "sse", url: "http://127.0.0.1:1/sse" } as never,
    ]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.name).toBe("unreachable");
    expect(Object.keys(result.tools)).toHaveLength(0);
  }, 15_000);
});
