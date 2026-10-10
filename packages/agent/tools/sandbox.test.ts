import { describe, expect, mock, test } from "bun:test";
import * as realAiModule from "ai";

mock.module("ai", () => ({
  ...realAiModule,
  tool: <T extends Record<string, unknown>>(definition: T) => definition,
}));

const { sandboxControlTool } = await import("./sandbox");

function contextWith(overrides: {
  status?: () => Promise<Record<string, unknown>>;
  provision?: () => Promise<Record<string, unknown>>;
  delete?: () => Promise<Record<string, unknown>>;
  reconnect?: () => Promise<Record<string, unknown>>;
  snapshot?: () => Promise<Record<string, unknown>>;
}) {
  return {
    sandbox: {
      state: { type: "modal" as const, volumeName: "entry-workspace-s1" },
      workingDirectory: "/workspace",
    },
    model: "test-model",
    sandboxControl: {
      status: overrides.status ?? (async () => ({ status: "running" })),
      provision: overrides.provision ?? (async () => ({ started: true })),
      reconnect: overrides.reconnect ?? (async () => ({ reconnected: true })),
      snapshot: overrides.snapshot ?? (async () => ({ snapshotId: "snap-1" })),
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
      reconnect: async () => {
        calls.push("reconnect");
        return { reconnected: true };
      },
      snapshot: async () => {
        calls.push("snapshot");
        return { snapshotId: "snap-1" };
      },
      delete: async () => {
        calls.push("delete");
        return { deleted: true };
      },
    });

    for (const action of [
      "provision",
      "reconnect",
      "snapshot",
      "delete",
    ] as const) {
      const result = await sandboxControlTool().execute?.(
        { action },
        executionOptions(context),
      );
      expect(result).toMatchObject({ success: true, action });
    }

    expect(calls).toEqual(["provision", "reconnect", "snapshot", "delete"]);
  });

  test("a host failure becomes a tool error, not a thrown turn", async () => {
    const context = contextWith({
      snapshot: async () => {
        throw new Error("Sandbox snapshot is still running");
      },
    });

    const result = await sandboxControlTool().execute?.(
      { action: "snapshot" },
      executionOptions(context),
    );

    expect(result).toMatchObject({
      success: false,
      action: "snapshot",
      error: "Sandbox snapshot is still running",
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
