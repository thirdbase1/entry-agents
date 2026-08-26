import { describe, expect, test } from "bun:test";
import {
  createMcpServer,
  InvalidMcpServerNameError,
  updateMcpServer,
} from "./mcp-servers";

// Deliberately never touches the DB or network -- assertValidName()
// throws synchronously before createMcpServer()/updateMcpServer() await
// anything (resolveAndAssertPublic, db.insert/update), so rejecting an
// invalid or reserved name is safe to test in isolation. See
// lib/mcp/composio.ts -- "composio" is reserved for the built-in
// Composio MCP integration so a self-serve server can't collide with
// it in the merged tool set's namespacing.
describe("mcp server name validation", () => {
  test("createMcpServer rejects the reserved name 'composio'", async () => {
    await expect(
      createMcpServer({
        userId: "user_1",
        name: "composio",
        transport: "http",
        url: "https://example.com/mcp",
      }),
    ).rejects.toThrow(InvalidMcpServerNameError);
  });

  test("updateMcpServer rejects renaming a server to 'composio'", async () => {
    await expect(
      updateMcpServer({
        userId: "user_1",
        id: "server_1",
        name: "composio",
      }),
    ).rejects.toThrow(InvalidMcpServerNameError);
  });

  test("createMcpServer rejects invalid name patterns", async () => {
    await expect(
      createMcpServer({
        userId: "user_1",
        name: "Not Valid!",
        transport: "http",
        url: "https://example.com/mcp",
      }),
    ).rejects.toThrow(InvalidMcpServerNameError);
  });

  test("createMcpServer accepts a normal, non-reserved name (fails later on DB access, not on validation)", async () => {
    // We can't assert success without a live DB, but we can assert
    // the rejection -- if any -- isn't InvalidMcpServerNameError, i.e.
    // the name itself passed validation and the call got past
    // assertValidName().
    try {
      await createMcpServer({
        userId: "user_1",
        name: "my-server",
        transport: "http",
        url: "https://example.com/mcp",
      });
    } catch (error) {
      expect(error).not.toBeInstanceOf(InvalidMcpServerNameError);
    }
  });
});
