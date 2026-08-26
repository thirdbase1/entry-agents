import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// getComposioMcpServerConfig() dynamic-imports both "@composio/core"
// and "@/lib/db/composio-sessions" -- mocked here the same way
// packages/agent/tools/mcp.test.ts mocks "@ai-sdk/mcp" for the
// generic MCP connect primitive this module feeds into.

type FakeSession = {
  sessionId: string;
  mcp?: { url: string; headers?: Record<string, string> };
};

const useCalls: string[] = [];
const createCalls: string[] = [];
let useShouldThrow = false;
let createShouldThrow = false;
let useResult: FakeSession | undefined;
let createResult: FakeSession = {
  sessionId: "session_new",
  mcp: {
    url: "https://mcp.composio.dev/session_new",
    headers: { "x-api-key": "ak_test" },
  },
};

mock.module("@composio/core", () => ({
  Composio: class FakeComposio {
    use(sessionId: string) {
      useCalls.push(sessionId);
      if (useShouldThrow) {
        return Promise.reject(new Error("session expired"));
      }
      return Promise.resolve(useResult);
    }
    create(userId: string) {
      createCalls.push(userId);
      if (createShouldThrow) {
        return Promise.reject(new Error("network error"));
      }
      return Promise.resolve(createResult);
    }
  },
}));

const storedSessionIds = new Map<string, string>();
mock.module("@/lib/db/composio-sessions", () => ({
  getComposioSessionId: async (userId: string) =>
    storedSessionIds.get(userId) ?? null,
  setComposioSessionId: async (userId: string, sessionId: string) => {
    storedSessionIds.set(userId, sessionId);
  },
}));

const { getComposioMcpServerConfig } = await import("./composio");

describe("getComposioMcpServerConfig", () => {
  const originalApiKey = process.env.COMPOSIO_API_KEY;

  beforeEach(() => {
    useCalls.length = 0;
    createCalls.length = 0;
    useShouldThrow = false;
    createShouldThrow = false;
    useResult = {
      sessionId: "session_existing",
      mcp: {
        url: "https://mcp.composio.dev/session_existing",
        headers: { "x-api-key": "ak_test" },
      },
    };
    createResult = {
      sessionId: "session_new",
      mcp: {
        url: "https://mcp.composio.dev/session_new",
        headers: { "x-api-key": "ak_test" },
      },
    };
    storedSessionIds.clear();
    process.env.COMPOSIO_API_KEY = "ak_test";
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.COMPOSIO_API_KEY;
    } else {
      process.env.COMPOSIO_API_KEY = originalApiKey;
    }
  });

  test("returns null when COMPOSIO_API_KEY is not set", async () => {
    delete process.env.COMPOSIO_API_KEY;
    const config = await getComposioMcpServerConfig("user_1");
    expect(config).toBeNull();
    expect(useCalls).toHaveLength(0);
    expect(createCalls).toHaveLength(0);
  });

  test("mints a fresh session and persists it when none is stored", async () => {
    const config = await getComposioMcpServerConfig("user_1");
    expect(createCalls).toEqual(["user_1"]);
    expect(useCalls).toHaveLength(0);
    expect(config).toEqual({
      name: "composio",
      transport: "http",
      url: "https://mcp.composio.dev/session_new",
      headers: { "x-api-key": "ak_test" },
    });
    expect(storedSessionIds.get("user_1")).toBe("session_new");
  });

  test("resumes a stored session instead of creating a new one", async () => {
    storedSessionIds.set("user_1", "session_existing");
    const config = await getComposioMcpServerConfig("user_1");
    expect(useCalls).toEqual(["session_existing"]);
    expect(createCalls).toHaveLength(0);
    expect(config).toEqual({
      name: "composio",
      transport: "http",
      url: "https://mcp.composio.dev/session_existing",
      headers: { "x-api-key": "ak_test" },
    });
  });

  test("falls back to minting a new session when the stored one can't be resumed", async () => {
    storedSessionIds.set("user_1", "session_stale");
    useShouldThrow = true;
    const config = await getComposioMcpServerConfig("user_1");
    expect(useCalls).toEqual(["session_stale"]);
    expect(createCalls).toEqual(["user_1"]);
    expect(config?.url).toBe("https://mcp.composio.dev/session_new");
    expect(storedSessionIds.get("user_1")).toBe("session_new");
  });

  test("returns null (never throws) when the SDK call fails entirely", async () => {
    createShouldThrow = true;
    const config = await getComposioMcpServerConfig("user_1");
    expect(config).toBeNull();
    expect(createCalls).toEqual(["user_1"]);
  });
});
