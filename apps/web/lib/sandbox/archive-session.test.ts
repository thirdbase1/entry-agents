import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

interface TestSessionRecord {
  id: string;
  userId: string;
  status: "running" | "archived";
  repoOwner: string | null;
  repoName: string | null;
  branch: string | null;
  cloneUrl: string | null;
  prNumber: number | null;
  prStatus: "open" | "merged" | "closed" | null;
  sandboxState: {
    type: "vercel";
    sandboxName?: string;
    expiresAt?: number;
  } | null;
  snapshotUrl: string | null;
  lifecycleState: "active" | "archived" | null;
  lifecycleError: string | null;
  sandboxExpiresAt: Date | null;
  hibernateAfter: Date | null;
}

interface MockSandboxExecResult {
  success: boolean;
  stdout: string;
}

interface MockSandbox {
  workingDirectory: string;
  exec: (
    command: string,
    cwd: string,
    timeoutMs: number,
  ) => Promise<MockSandboxExecResult>;
  stop: () => Promise<void>;
  snapshot?: () => Promise<{ snapshotId: string }>;
}

type MockPullRequestStatusResult =
  | {
      success: true;
      status: "open" | "merged" | "closed";
    }
  | {
      success: false;
      error: string;
    };

type MockFindPullRequestResult =
  | {
      found: true;
      prNumber: number;
      prStatus: "open" | "merged" | "closed";
    }
  | {
      found: false;
      error?: string;
    };

let sessionRecord: TestSessionRecord | null = null;
let sandboxQueue: MockSandbox[] = [];

const spies = {
  getSessionById: mock(async (_sessionId: string) => {
    if (!sessionRecord) {
      return null;
    }

    return {
      ...sessionRecord,
      sandboxState: sessionRecord.sandboxState
        ? { ...sessionRecord.sandboxState }
        : null,
    };
  }),
  updateSession: mock(
    async (_sessionId: string, patch: Record<string, unknown>) => {
      if (!sessionRecord) {
        return null;
      }

      sessionRecord = {
        ...sessionRecord,
        ...(patch as Partial<TestSessionRecord>),
      };

      return {
        ...sessionRecord,
        sandboxState: sessionRecord.sandboxState
          ? { ...sessionRecord.sandboxState }
          : null,
      };
    },
  ),
  connectSandbox: mock(async () => {
    const sandbox = sandboxQueue.shift();
    if (!sandbox) {
      throw new Error("sandbox connection failed");
    }

    return sandbox;
  }),
  getUserGitHubToken: mock(async () => "repo-token"),
  getPullRequestStatus: mock(
    async (): Promise<MockPullRequestStatusResult> => ({
      success: false,
      error: "Failed to get PR status",
    }),
  ),
  findPullRequest: mock(
    async (): Promise<MockFindPullRequestResult> => ({
      found: false,
    }),
  ),
  // archiveSession() now kicks the durable archive-sandbox-stop workflow
  // instead of taking a scheduleBackgroundWork callback (see
  // archive-sandbox-kick.ts). Tests below stub this out and instead call
  // the exported finalizeArchivedSessionSandboxInline() directly to
  // exercise the same finalization logic without needing the real
  // Workflow SDK runtime.
  kickArchiveSandboxStopWorkflow: mock(
    (_sessionId: string, _logPrefix: string) => {},
  ),
};

mock.module("@/lib/db/sessions", () => ({
  getSessionById: spies.getSessionById,
  updateSession: spies.updateSession,
}));

mock.module("@open-agents/sandbox", () => ({
  connectSandbox: spies.connectSandbox,
}));

mock.module("@/lib/github/token", () => ({
  getUserGitHubToken: spies.getUserGitHubToken,
}));

mock.module("@/lib/github/pulls", () => ({
  getPullRequestStatus: spies.getPullRequestStatus,
  findPullRequest: spies.findPullRequest,
}));

mock.module("@/lib/sandbox/archive-sandbox-kick", () => ({
  kickArchiveSandboxStopWorkflow: spies.kickArchiveSandboxStopWorkflow,
}));

const archiveSessionModulePromise = import("./archive-session");

function makeSessionRecord(
  overrides: Partial<TestSessionRecord> = {},
): TestSessionRecord {
  return {
    id: "session-1",
    userId: "user-1",
    status: "running",
    repoOwner: "acme",
    repoName: "widgets",
    branch: "feature/session-1",
    cloneUrl: "https://github.com/acme/widgets.git",
    prNumber: 42,
    prStatus: "open",
    sandboxState: {
      type: "vercel",
      sandboxName: "session_session-1",
      expiresAt: Date.now() + 60_000,
    },
    snapshotUrl: null,
    lifecycleState: "active",
    lifecycleError: null,
    sandboxExpiresAt: new Date("2025-01-01T00:00:00.000Z"),
    hibernateAfter: new Date("2025-01-01T00:10:00.000Z"),
    ...overrides,
  };
}

function createMockSandbox(overrides: Partial<MockSandbox> = {}): MockSandbox {
  return {
    workingDirectory: "/workspace",
    exec: async () => ({ success: true, stdout: "feature/session-1\n" }),
    stop: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  sessionRecord = makeSessionRecord();
  sandboxQueue = [];
  Object.values(spies).forEach((spy) => spy.mockClear());

  spies.getUserGitHubToken.mockImplementation(async () => "repo-token");
  spies.getPullRequestStatus.mockImplementation(async () => ({
    success: false,
    error: "Failed to get PR status",
  }));
  spies.findPullRequest.mockImplementation(async () => ({
    found: false,
  }));
});

describe("archiveSession", () => {
  test("kicks the durable archive-sandbox-stop workflow on archive", async () => {
    const { archiveSession } = await archiveSessionModulePromise;

    const result = await archiveSession("session-1", {
      logPrefix: "[Test]",
    });

    expect(result.archiveTriggered).toBe(true);
    expect(spies.kickArchiveSandboxStopWorkflow).toHaveBeenCalledWith(
      "session-1",
      "[Test]",
    );
  });

  test("refreshes merged PR status before archiving", async () => {
    const { archiveSession } = await archiveSessionModulePromise;

    sandboxQueue = [createMockSandbox(), createMockSandbox()];
    spies.getPullRequestStatus.mockImplementation(async () => ({
      success: true,
      status: "merged",
    }));

    const result = await archiveSession("session-1", {
      logPrefix: "[Test]",
    });

    expect(result.archiveTriggered).toBe(true);

    const updateCalls = spies.updateSession.mock.calls as Array<
      [string, Record<string, unknown>]
    >;

    expect(updateCalls[0]?.[1]).toMatchObject({
      status: "archived",
      prStatus: "merged",
    });
    expect(spies.findPullRequest).not.toHaveBeenCalled();
    expect(sessionRecord?.prStatus).toBe("merged");
  });
});

describe("finalizeArchivedSessionSandboxInline", () => {
  test("clears runtime sandbox state when finalization fails without a snapshot", async () => {
    const { archiveSession, finalizeArchivedSessionSandboxInline } =
      await archiveSessionModulePromise;

    const result = await archiveSession("session-1", { logPrefix: "[Test]" });
    expect(result.archiveTriggered).toBe(true);

    // sandboxQueue is empty, so connectSandbox() throws inside finalize --
    // exercising the failure/recovery path.
    await finalizeArchivedSessionSandboxInline("session-1", "[Test]");

    const updateCalls = spies.updateSession.mock.calls as Array<
      [string, Record<string, unknown>]
    >;

    expect(updateCalls).toHaveLength(2);
    const recoveryPatch = updateCalls[1]?.[1];

    expect(recoveryPatch).toMatchObject({
      lifecycleState: "archived",
      sandboxExpiresAt: null,
      hibernateAfter: null,
      lifecycleError: "Archive finalization failed: sandbox connection failed",
      sandboxState: {
        type: "vercel",
        sandboxName: "session_session-1",
      },
    });

    expect(sessionRecord?.sandboxState).toEqual({
      type: "vercel",
      sandboxName: "session_session-1",
    });
  });

  test("preserves runtime sandbox state when finalization fails but snapshot already exists", async () => {
    const { archiveSession, finalizeArchivedSessionSandboxInline } =
      await archiveSessionModulePromise;

    sessionRecord = makeSessionRecord({ snapshotUrl: "snapshot-existing" });

    const result = await archiveSession("session-1", { logPrefix: "[Test]" });
    expect(result.archiveTriggered).toBe(true);

    await finalizeArchivedSessionSandboxInline("session-1", "[Test]");

    const updateCalls = spies.updateSession.mock.calls as Array<
      [string, Record<string, unknown>]
    >;

    expect(updateCalls).toHaveLength(2);
    const recoveryPatch = updateCalls[1]?.[1];

    expect(recoveryPatch?.lifecycleError).toBe(
      "Archive finalization failed: sandbox connection failed",
    );
    expect(recoveryPatch?.sandboxState).toBeUndefined();
    expect(sessionRecord?.sandboxState).toEqual(
      expect.objectContaining({
        type: "vercel",
        sandboxName: "session_session-1",
      }),
    );
  });
});
