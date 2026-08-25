import { createMCPClient } from "@ai-sdk/mcp";
import type { Tool, ToolSet } from "ai";

// Vendor-agnostic plumbing for connecting Entry's agent to external
// Model Context Protocol servers -- the mechanism behind "give Entry
// access to thousands of tools". This module deliberately does NOT
// pick a vendor (Composio, Smithery, a self-serve BYO-MCP-server list,
// etc.) or resolve per-session/per-user config -- that's a product +
// security decision still open with the owner. What's here is the
// generic, reusable connect/merge/close primitive any of those options
// will plug into once decided.
//
// Not wired into the live request path yet (nothing calls this from
// app/workflows/chat.ts). See open-agent.ts's `extraTools` call option
// for how a caller merges the result in.

export interface McpServerConfig {
  /**
   * Short, stable identifier used in tool names (mcp__<name>__<tool>).
   * Keep it stable across requests -- changing it changes every tool
   * name the model has already seen mid-conversation.
   */
  name: string;
  transport: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export interface McpConnectionFailure {
  name: string;
  error: string;
}

export interface McpToolSetResult {
  tools: ToolSet;
  /**
   * Closes every underlying MCP client connection opened for this
   * call. Callers MUST invoke this once they're fully done executing
   * tools for the request (e.g. in a `finally` after the model
   * stream is fully consumed) -- these are real network connections
   * (persistent for the "sse" transport), not garbage-collected
   * resources.
   */
  close: () => Promise<void>;
  /**
   * Servers that failed to connect. Deliberately non-fatal: one
   * misconfigured or down MCP server should never take down a whole
   * turn when other servers (and Entry's own built-in tools) are
   * fine. Callers should log/surface these, not throw.
   */
  failures: McpConnectionFailure[];
}

// Most providers cap tool names well under this; MCP tool names are
// arbitrary strings so a very long "<server>__<tool>" combination
// gets truncated rather than risking a rejected request.
const MAX_TOOL_NAME_LENGTH = 64;

export function namespacedMcpToolName(
  serverName: string,
  toolName: string,
): string {
  const raw = `mcp__${serverName}__${toolName}`;
  return raw.length <= MAX_TOOL_NAME_LENGTH
    ? raw
    : raw.slice(0, MAX_TOOL_NAME_LENGTH);
}

type PermissionMode = "ask" | "autoAccept" | "fullAccess";

/**
 * Every tool pulled in from an MCP server gets wrapped with the same
 * blanket approval gate web_fetch uses: needsApproval => true whenever
 * permissionMode is "ask" (the default). MCP has no standard concept
 * of "this tool is dangerous" -- an agent that already has bash,
 * git push, and deploy access has no safe way to trust a remote
 * server's self-reported tool metadata, so every external tool call
 * is treated as sensitive by default. "autoAccept"/"fullAccess" lift
 * this the same way they lift every other gate.
 */
function withApprovalGate<T extends Tool>(mcpTool: T): T {
  return {
    ...mcpTool,
    needsApproval: async (
      _args: unknown,
      context: { experimental_context?: unknown },
    ) => {
      const mode = (
        context.experimental_context as
          | { permissionMode?: PermissionMode }
          | undefined
      )?.permissionMode;
      return (mode ?? "ask") === "ask";
    },
  } as T;
}

/**
 * Connects to every configured MCP server in parallel, fetches its
 * tools, and returns them merged into a single AI SDK ToolSet --
 * namespaced as mcp__<server>__<tool> to avoid collisions between
 * servers or with Entry's own built-in tools.
 *
 * Deliberately connect-per-call rather than pooled/cached: this is
 * meant to be called from inside a durable "use step" function (see
 * runAgentStep in app/workflows/chat.ts), which may resume on a
 * different worker between steps -- there's no long-lived process to
 * hold a pooled connection across separate step invocations anyway,
 * matching how this codebase already re-resolves DB connections fresh
 * per step rather than caching them.
 */
export async function createMcpToolSet(
  servers: McpServerConfig[],
): Promise<McpToolSetResult> {
  const closers: (() => Promise<void>)[] = [];
  const failures: McpConnectionFailure[] = [];
  const mergedTools: ToolSet = {};

  await Promise.all(
    servers.map(async (server) => {
      try {
        const client = await createMCPClient({
          transport: {
            type: server.transport,
            url: server.url,
            headers: server.headers,
          },
        });
        closers.push(() => client.close());

        const serverTools = await client.tools();
        for (const [toolName, mcpTool] of Object.entries(serverTools)) {
          const name = namespacedMcpToolName(server.name, toolName);
          mergedTools[name] = withApprovalGate(mcpTool as Tool);
        }
      } catch (error) {
        failures.push({
          name: server.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return {
    tools: mergedTools,
    failures,
    close: async () => {
      await Promise.all(
        closers.map((close) =>
          close().catch(() => {
            // Best-effort cleanup -- a close() failure shouldn't
            // surface as a turn error, the connection is being torn
            // down anyway.
          }),
        ),
      );
    },
  };
}
