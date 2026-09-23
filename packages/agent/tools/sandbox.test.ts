import { describe, expect, mock, test } from "bun:test";

mock.module("ai", () => ({
  tool: <T extends Record<string, unknown>>(definition: T) => definition,
}));

const { sandboxControlTool } = await import("./sandbox");

function contextWith(overrides: {
  status?: () => Promise<Record<string, unknown>>;
  provision?: () => Promise<Record<string, unknown>>;
  migrate?: () => Promise<Record<string, unknown>>;
  extend?: () => Promise<Record<string, unknown>>;
  delete?: () => Promise<Record<string, unknown>>;
}) {
  return {
    sandbox: {
      state: { type: "vercel" as const, sandboxId: "sbx-1" },
      workingDirectory: "/repo",
    },
    model: "test-model",
    sandboxControl: {
      status: overrides.status ?? (async () => ({ status: "running" })),
      provision: overrides.provision ?? (async () => ({ started: true })),
      migrate: overrides.migrate ?? (async () => ({ action: "migrated" })),
      extend: overrides.extend ?? (async () => ({ extended: true })),
      delete: overrides.delete ?? (async () => ({ deleted: true })),
    },
  };
}

function executionOptions(experimental_context: unknown) {
  return { toolCallId: "tool-call-1", messages: [], experimental_context };
}

describe("sandboxControlTool", () => {
  test("status is read-only and passes the host result through", async () => {
    const context = contextWith({
      status: async () => ({
        status: "paused",
        lifecycleState: "hibernated",
        sandboxExpiresAt: null,
      }),
    });

    const result = await sandboxControlTool().execute?.(
      { action: "status" },
      executionOptions(context),
    );

    expect(result).toMatchObject({
      success: true,
      action: "status",
      status: "paused",
      lifecycleState: "hibernated",
    });
  });

  test("every action routes to its own host callback", async () => {
    const calls: string[] = [];
    const context = contextWith({
      provision: async () => {
        calls.push("provision");
        return { started: true };
      },
      migrate: async () => {
        calls.push("migrate");
        return { action: "migrated" };
      },
      extend: async () => {
        calls.push("extend");
        return { extended: true };
      },
      delete: async () => {
        calls.push("delete");
        return { deleted: true };
      },
    });

    for (const action of [
      "provision",
      "migrate",
      "extend",
      "delete",
    ] as const) {
      const result = await sandboxControlTool().execute?.(
        { action },
        executionOptions(context),
      );
      expect(result).toMatchObject({ success: true, action });
    }

    expect(calls).toEqual(["provision", "migrate", "extend", "delete"]);
  });

  test("a host failure becomes a tool error, not a thrown turn", async () => {
    const context = contextWith({
      migrate: async () => {
        throw new Error("Sandbox migration is still running");
      },
    });

    const result = await sandboxControlTool().execute?.(
      { action: "migrate" },
      executionOptions(context),
    );

    expect(result).toMatchObject({
      success: false,
      action: "migrate",
      error: "Sandbox migration is still running",
    });
  });

  test("missing host context fails clearly", async () => {
    const result = await sandboxControlTool().execute?.(
      { action: "delete" },
      executionOptions({ model: "test-model" }),
    );

    expect(result).toMatchObject({ success: false });
    expect((result as { error: string }).error).toContain(
      "Workspace lifecycle control isn't available",
    );
  });
});
