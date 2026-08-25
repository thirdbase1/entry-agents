import { describe, expect, mock, test } from "bun:test";

type FakeClient = {
  tools: () => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
};

const fakeClients = new Map<string, FakeClient>();
const closeCalls: string[] = [];

mock.module("@ai-sdk/mcp", () => ({
  createMCPClient: async (config: { transport: { url: string } }) => {
    const client = fakeClients.get(config.transport.url);
    if (!client) {
      throw new Error(`no fake client registered for ${config.transport.url}`);
    }
    return client;
  },
}));

const { createMcpToolSet, namespacedMcpToolName } = await import("./mcp");

function registerFakeServer(
  url: string,
  toolNames: string[],
  options: { failClose?: boolean } = {},
): void {
  fakeClients.set(url, {
    tools: async () =>
      Object.fromEntries(
        toolNames.map((name) => [
          name,
          {
            description: `fake tool ${name}`,
            inputSchema: {},
            execute: async () => ({ ok: true }),
          },
        ]),
      ),
    close: async () => {
      closeCalls.push(url);
      if (options.failClose) {
        throw new Error("close failed");
      }
    },
  });
}

describe("namespacedMcpToolName", () => {
  test("namespaces as mcp__<server>__<tool>", () => {
    expect(namespacedMcpToolName("notion", "search_pages")).toBe(
      "mcp__notion__search_pages",
    );
  });

  test("truncates names longer than the provider limit", () => {
    const longName = namespacedMcpToolName(
      "a-very-long-server-name-that-goes-on",
      "an-equally-long-tool-name-here-too",
    );
    expect(longName.length).toBeLessThanOrEqual(64);
  });
});

describe("createMcpToolSet", () => {
  test("merges tools from multiple servers, namespaced per server", async () => {
    registerFakeServer("https://a.example/mcp", ["search"]);
    registerFakeServer("https://b.example/mcp", ["search"]);

    const result = await createMcpToolSet([
      { name: "a", transport: "http", url: "https://a.example/mcp" },
      { name: "b", transport: "http", url: "https://b.example/mcp" },
    ]);

    expect(Object.keys(result.tools).sort()).toEqual([
      "mcp__a__search",
      "mcp__b__search",
    ]);
    expect(result.failures).toEqual([]);
    await result.close();
  });

  test("wraps every tool with a blanket approval gate", async () => {
    registerFakeServer("https://c.example/mcp", ["do_thing"]);

    const result = await createMcpToolSet([
      { name: "c", transport: "http", url: "https://c.example/mcp" },
    ]);

    const needsApproval = result.tools["mcp__c__do_thing"]?.needsApproval as (
      args: unknown,
      ctx: { toolCallId: string; messages: unknown[]; experimental_context?: unknown },
    ) => Promise<boolean>;

    const baseCtx = { toolCallId: "test-call", messages: [] };

    expect(
      await needsApproval(undefined, { ...baseCtx, experimental_context: {} }),
    ).toBe(true);
    expect(
      await needsApproval(undefined, {
        ...baseCtx,
        experimental_context: { permissionMode: "autoAccept" },
      }),
    ).toBe(false);
    expect(
      await needsApproval(undefined, {
        ...baseCtx,
        experimental_context: { permissionMode: "fullAccess" },
      }),
    ).toBe(false);

    await result.close();
  });

  test("isolates a failed server instead of failing the whole call", async () => {
    registerFakeServer("https://ok.example/mcp", ["works"]);

    const result = await createMcpToolSet([
      { name: "ok", transport: "http", url: "https://ok.example/mcp" },
      { name: "broken", transport: "http", url: "https://missing.example/mcp" },
    ]);

    expect(Object.keys(result.tools)).toEqual(["mcp__ok__works"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.name).toBe("broken");

    await result.close();
  });

  test("close() closes every successfully connected client and never throws, even if one close() fails", async () => {
    closeCalls.length = 0;
    registerFakeServer("https://d.example/mcp", ["x"]);
    registerFakeServer("https://e.example/mcp", ["y"], { failClose: true });

    const result = await createMcpToolSet([
      { name: "d", transport: "http", url: "https://d.example/mcp" },
      { name: "e", transport: "http", url: "https://e.example/mcp" },
    ]);

    await result.close();

    expect(closeCalls.sort()).toEqual([
      "https://d.example/mcp",
      "https://e.example/mcp",
    ]);
  });

  test("returns empty tools and no failures for an empty server list", async () => {
    const result = await createMcpToolSet([]);
    expect(result.tools).toEqual({});
    expect(result.failures).toEqual([]);
    await result.close();
  });
});
