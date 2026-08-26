import type { McpServerConfig } from "@open-agents/agent";

// Wires Composio (https://composio.dev) in as one more MCP server for
// the chat request path, on the exact same generic connect/merge
// primitive the self-serve "paste any MCP server URL" feature already
// uses (createMcpToolSet in packages/agent/tools/mcp.ts) -- see the
// "not wired in yet" fork this module resolves in
// packages/agent/tools/mcp.ts's own module comment and
// docs/agents/lessons-learned.md's 2026-08-25 MCP entry.
//
// Composio's own current integration path for a hosted MCP transport
// is "sessions" (formerly called "Tool Router"/"MCP servers" in their
// older docs): composio.create(userId, { mcp: true }) mints a session
// scoped to one Entry user and exposes session.mcp.{url,headers} --
// that's the URL/headers pair handed to createMcpToolSet() below,
// identical in shape to a self-serve server's config. Session meta
// tools (COMPOSIO_SEARCH_TOOLS, COMPOSIO_MANAGE_CONNECTIONS, etc.) let
// the agent discover Composio's full toolkit catalog and get a
// Connect Link at runtime when a user needs to authorize an app --
// no OAuth flow to build here.
//
// Deliberately lazy-imported (dynamic import inside the function,
// never a static top-level import) because this is called from
// inside chat.ts's "use step" runAgentStep function -- the Vercel
// Workflow SDK restricts what a "use workflow" bundle can statically
// import, and DB/Node-only modules must only be pulled in inside a
// "use step" boundary (see the 2026-08-20 gotcha logged in
// docs/agents/lessons-learned.md for the exact failure mode this
// avoids).

const COMPOSIO_MCP_SERVER_NAME = "composio";

/**
 * Resumes a stored Composio session, or mints a fresh one if there's
 * no stored session ID or the stored one is no longer resumable.
 * Deliberately left untyped by name (return type inferred from the
 * SDK's own `create`/`use` overloads) -- both overloads key off the
 * `{ mcp: true }` literal to surface `session.mcp` in their return
 * type, and annotating the shared variable manually picks the wrong
 * overload's type instead of that one.
 */
async function resumeOrCreateComposioSession(
  composio: InstanceType<typeof import("@composio/core").Composio>,
  userId: string,
  existingSessionId: string | null,
) {
  const { setComposioSessionId } = await import("@/lib/db/composio-sessions");

  if (existingSessionId) {
    try {
      return await composio.use(existingSessionId, { mcp: true });
    } catch (error) {
      // Stored session ID is stale/unresumable (expired, deleted via
      // the dashboard, etc.) -- fall through and mint a fresh one
      // rather than failing the whole turn.
      console.warn(
        `[composio-mcp] Failed to resume session for user ${userId}, minting a new one:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  const created = await composio.create(userId, { mcp: true });
  await setComposioSessionId(userId, created.sessionId);
  return created;
}

/**
 * Resolves this user's Composio MCP server config, or null when
 * Composio isn't configured (no COMPOSIO_API_KEY) or the SDK call
 * fails for any reason. Deliberately never throws -- callers merge
 * this alongside self-serve MCP servers, and a Composio outage or
 * misconfiguration should never block a chat turn or the user's own
 * configured servers.
 */
export async function getComposioMcpServerConfig(
  userId: string,
): Promise<McpServerConfig | null> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return null;
  }

  try {
    const { Composio } = await import("@composio/core");
    const { getComposioSessionId } = await import("@/lib/db/composio-sessions");

    const composio = new Composio({ apiKey });
    const existingSessionId = await getComposioSessionId(userId);
    const session = await resumeOrCreateComposioSession(
      composio,
      userId,
      existingSessionId,
    );

    if (!session.mcp?.url) {
      return null;
    }

    return {
      name: COMPOSIO_MCP_SERVER_NAME,
      transport: "http",
      url: session.mcp.url,
      headers: session.mcp.headers,
    };
  } catch (error) {
    console.warn(
      `[composio-mcp] Failed to resolve Composio MCP config for user ${userId}, continuing without it:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
