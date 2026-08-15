import { createHmac } from "crypto";
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

mock.module("next/server", () => ({
  after: (_cb: () => Promise<void>) => {
    // Intentionally a no-op in tests: archiveSession is mocked below, so
    // nothing ever schedules background work through this in practice.
  },
}));

type FakeSession = {
  id: string;
  // Deliberately widened to `string` (not the real status union) so
  // reassigning it mid-test (to simulate the app's unarchive PATCH) never
  // trips TS's literal-narrowing on object property reads across awaited
  // calls -- this is a test fixture, not the real session record.
  status: string;
  prNumber: number | null;
  prStatus: string | null;
  repoOwner: string;
  repoName: string;
};

let linkedSessions: FakeSession[];
const updateSessionCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
const archiveSessionCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

mock.module("@/lib/db/client", () => ({
  db: {
    query: {
      sessions: {
        findMany: async () => linkedSessions,
      },
    },
  },
}));

mock.module("@/lib/db/sessions", () => ({
  updateSession: async (id: string, patch: Record<string, unknown>) => {
    updateSessionCalls.push({ id, patch });
    const found = linkedSessions.find((s) => s.id === id);
    if (found) {
      Object.assign(found, patch);
    }
    return found ?? null;
  },
}));

mock.module("@/lib/sandbox/archive-session", () => ({
  archiveSession: async (
    id: string,
    options: { currentSession: FakeSession; update: Record<string, unknown> },
  ) => {
    archiveSessionCalls.push({ id, patch: options.update });
    const found = linkedSessions.find((s) => s.id === id);
    if (found) {
      Object.assign(found, options.update, { status: "archived" as const });
    }
    return { session: found ?? null, archiveTriggered: true };
  },
}));

// Installation-webhook branches aren't exercised by these tests, but the
// route module still imports these — stub them out so the import succeeds.
mock.module("@/lib/db/installations", () => ({
  deleteInstallationByInstallationId: async () => 0,
  getInstallationsByInstallationId: async () => [],
  updateInstallationsByInstallationId: async () => 0,
  upsertInstallation: async () => undefined,
}));

const routeModulePromise = import("./route");

const WEBHOOK_SECRET = "test-webhook-secret";

function signPayload(payloadText: string): string {
  const digest = createHmac("sha256", WEBHOOK_SECRET)
    .update(payloadText)
    .digest("hex");
  return `sha256=${digest}`;
}

async function postPullRequestEvent(body: unknown): Promise<Response> {
  const { POST } = await routeModulePromise;
  const payloadText = JSON.stringify(body);
  const req = new Request("https://example.com/api/github/webhook", {
    method: "POST",
    headers: {
      "x-github-event": "pull_request",
      "x-hub-signature-256": signPayload(payloadText),
      "content-type": "application/json",
    },
    body: payloadText,
  });
  return POST(req);
}

function closedPayload(merged = false) {
  return {
    action: "closed",
    repository: {
      name: "entry-agents",
      owner: { login: "thirdbase1" },
    },
    pull_request: {
      number: 42,
      merged,
    },
  };
}

describe("POST /api/github/webhook (pull_request)", () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    updateSessionCalls.length = 0;
    archiveSessionCalls.length = 0;
    linkedSessions = [
      {
        id: "session-1",
        status: "running",
        prNumber: 42,
        prStatus: "open",
        repoOwner: "thirdbase1",
        repoName: "entry-agents",
      },
    ];
  });

  test("archives the session the first time a PR is closed", async () => {
    const res = await postPullRequestEvent(closedPayload());
    const body = (await res.json()) as { archivedSessions: number };

    expect(res.status).toBe(200);
    expect(body.archivedSessions).toBe(1);
    expect(archiveSessionCalls).toHaveLength(1);
    expect(linkedSessions[0].status).toBe("archived");
  });

  test("does not re-archive on a redelivered closed-PR event after the user unarchived", async () => {
    // First delivery: closes + archives normally.
    await postPullRequestEvent(closedPayload());
    expect(archiveSessionCalls).toHaveLength(1);

    // User manually unarchives (what the app's PATCH /api/sessions/:id
    // handler does): status flips back to running, prStatus is untouched
    // and still reflects the closed PR.
    linkedSessions[0].status = "running";

    // GitHub redelivers the exact same "closed" webhook event (retry, or
    // a manual "Redeliver" from the GitHub UI). Before the fix, this blew
    // the session's status back to "archived" with zero user action,
    // because the handler only checked session.status, not whether the
    // PR's recorded status had actually changed.
    const res = await postPullRequestEvent(closedPayload());
    const body = (await res.json()) as {
      archivedSessions: number;
      updatedSessions: number;
    };

    expect(res.status).toBe(200);
    expect(body.archivedSessions).toBe(0);
    expect(body.updatedSessions).toBe(0);
    expect(archiveSessionCalls).toHaveLength(1); // still just the first call
    expect(linkedSessions[0].status).toBe("running");
  });

  test("archives again on a genuine reopen-then-close cycle", async () => {
    await postPullRequestEvent(closedPayload());
    expect(archiveSessionCalls).toHaveLength(1);

    linkedSessions[0].status = "running";

    // A real reopen changes prStatus back to "open" first.
    await postPullRequestEvent({
      action: "reopened",
      repository: closedPayload().repository,
      pull_request: { number: 42, merged: false },
    });
    expect(linkedSessions[0].prStatus).toBe("open");

    // Closing it again for real should archive it again.
    const res = await postPullRequestEvent(closedPayload());
    const body = (await res.json()) as { archivedSessions: number };

    expect(res.status).toBe(200);
    expect(body.archivedSessions).toBe(1);
    expect(archiveSessionCalls).toHaveLength(2);
    expect(linkedSessions[0].status).toBe("archived");
  });
});
