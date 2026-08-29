import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

interface TestSessionRecord {
  id: string;
  status: "running" | "completed" | "failed" | "archived";
  lifecycleState:
    | "provisioning"
    | "active"
    | "hibernating"
    | "hibernated"
    | "restoring"
    | "migrating"
    | "archived"
    | "failed";
  sandboxState: {
    type: "vercel";
    sandboxName: string;
    expiresAt: number;
  };
  activeSandboxCommand: { cmdId: string } | null;
  lifecycleVersion: number;
  migrationFailureCount: number;
}

let sessionRecord: TestSessionRecord | null = null;

function makeDueSession(
  overrides: Partial<TestSessionRecord> = {},
): TestSessionRecord {
  return {
    id: "session-1",
    status: "running",
    lifecycleState: "active",
    sandboxState: {
      type: "vercel",
      sandboxName: "session_session-1",
      // Already past the migration lead -- isSandboxMigrationDue()
      // should read this as due.
      expiresAt: Date.now() - 1,
    },
    activeSandboxCommand: null,
    lifecycleVersion: 0,
    migrationFailureCount: 0,
    ...overrides,
  };
}

const killCommandSpy = mock(async (_cmdId: string) => undefined);
const stopSpy = mock(async () => undefined);
let connectSandboxShouldFail = false;
let packShouldFail = false;

const spies = {
  getSessionById: mock(async (_sessionId: string) => sessionRecord as never),
  updateSession: mock(
    async (_sessionId: string, patch: Record<string, unknown>) => {
      if (sessionRecord) {
        sessionRecord = { ...sessionRecord, ...patch } as TestSessionRecord;
      }
      return patch;
    },
  ),
  connectSandbox: mock(async (state: { type: string }) => {
    if (connectSandboxShouldFail) {
      throw new Error("connect exploded");
    }
    return {
      killCommand: killCommandSpy,
      stop: stopSpy,
      getState: () => ({ type: "vercel", sandboxName: "fresh-sandbox" }),
      __state: state,
    } as never;
  }),
  packWorkspacePayload: mock(async () => {
    if (packShouldFail) {
      throw new Error("pack exploded");
    }
    return { kind: "plain", fullTarBase64: "" } as never;
  }),
  restoreWorkspacePayload: mock(async () => undefined),
};

mock.module("@/lib/db/sessions", () => ({
  getSessionById: spies.getSessionById,
  updateSession: spies.updateSession,
  // lifecycle.ts (imported transitively via migration.ts's
  // isSandboxMigrationDue/buildActiveLifecycleUpdate) also pulls
  // getChatsBySessionId from this module; mock.module replaces the
  // whole namespace for every consumer, not just this file's imports.
  getChatsBySessionId: mock(async () => []),
}));

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: spies.connectSandbox,
  packWorkspacePayload: spies.packWorkspacePayload,
  restoreWorkspacePayload: spies.restoreWorkspacePayload,
}));

let relaunchShouldThrow = false;
const relaunchDevServerAfterMigrationSpy = mock(async (_sandbox: unknown) => {
  if (relaunchShouldThrow) {
    throw new Error("relaunch exploded");
  }
  return null as { packagePath: string; port: number; url: string } | null;
});

// Mocked (rather than letting the real module load) so this test stays
// scoped to performSandboxMigration's own orchestration -- the actual
// relaunch logic has its own dedicated tests in the dev-server route's
// test file.
mock.module("@/app/api/sessions/[sessionId]/dev-server/route", () => ({
  relaunchDevServerAfterMigration: relaunchDevServerAfterMigrationSpy,
}));

const { performSandboxMigration } = await import("./migration");

beforeEach(() => {
  sessionRecord = makeDueSession();
  connectSandboxShouldFail = false;
  packShouldFail = false;
  relaunchShouldThrow = false;
  Object.values(spies).forEach((spy) => spy.mockClear());
  killCommandSpy.mockClear();
  stopSpy.mockClear();
  relaunchDevServerAfterMigrationSpy.mockClear();
});

describe("performSandboxMigration", () => {
  test("migrates successfully and resets migrationFailureCount to 0", async () => {
    sessionRecord = makeDueSession({ migrationFailureCount: 3 });

    const result = await performSandboxMigration("session-1");

    expect(result).toEqual({ action: "migrated" });
    expect(sessionRecord?.migrationFailureCount).toBe(0);
  });

  test("kills the active in-flight command before packing the workspace", async () => {
    sessionRecord = makeDueSession({
      activeSandboxCommand: { cmdId: "cmd-123" },
    });

    await performSandboxMigration("session-1");

    expect(killCommandSpy).toHaveBeenCalledWith("cmd-123");
  });

  test("increments migrationFailureCount and returns it when connecting to the old sandbox fails", async () => {
    connectSandboxShouldFail = true;
    sessionRecord = makeDueSession({ migrationFailureCount: 1 });

    const result = await performSandboxMigration("session-1");

    expect(result.action).toBe("failed");
    expect(result.failureCount).toBe(2);
    expect(sessionRecord?.migrationFailureCount).toBe(2);
    expect(sessionRecord?.lifecycleState).toBe("failed");
  });

  test("increments migrationFailureCount and returns it when packing the workspace fails", async () => {
    packShouldFail = true;
    sessionRecord = makeDueSession({ migrationFailureCount: 4 });

    const result = await performSandboxMigration("session-1");

    expect(result.action).toBe("failed");
    expect(result.failureCount).toBe(5);
    expect(sessionRecord?.migrationFailureCount).toBe(5);
  });

  test("starts the failure count at 1 for a session that has never failed before", async () => {
    connectSandboxShouldFail = true;
    sessionRecord = makeDueSession({ migrationFailureCount: 0 });

    const result = await performSandboxMigration("session-1");

    expect(result.failureCount).toBe(1);
  });

  test("skips when a migration is already in progress for this session", async () => {
    sessionRecord = makeDueSession({ lifecycleState: "migrating" });

    const result = await performSandboxMigration("session-1");

    expect(result).toEqual({
      action: "skipped",
      reason: "migration-already-in-progress",
    });
    expect(spies.connectSandbox).not.toHaveBeenCalled();
  });

  test("skips without touching failure count when the sandbox isn't due for migration yet", async () => {
    sessionRecord = makeDueSession({
      sandboxState: {
        type: "vercel",
        sandboxName: "session_session-1",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      migrationFailureCount: 2,
    });

    const result = await performSandboxMigration("session-1");

    expect(result).toEqual({ action: "skipped", reason: "not-due-yet" });
    expect(sessionRecord?.migrationFailureCount).toBe(2);
  });

  test("checks whether a dev server needs relaunching after a successful migration", async () => {
    const result = await performSandboxMigration("session-1");

    expect(result).toEqual({ action: "migrated" });
    expect(relaunchDevServerAfterMigrationSpy).toHaveBeenCalledTimes(1);
  });

  test("still reports the migration as successful when the dev server relaunch check throws", async () => {
    relaunchShouldThrow = true;

    const result = await performSandboxMigration("session-1");

    expect(result).toEqual({ action: "migrated" });
  });

  test("does not attempt a dev server relaunch when the migration itself fails", async () => {
    connectSandboxShouldFail = true;

    await performSandboxMigration("session-1");

    expect(relaunchDevServerAfterMigrationSpy).not.toHaveBeenCalled();
  });
});
