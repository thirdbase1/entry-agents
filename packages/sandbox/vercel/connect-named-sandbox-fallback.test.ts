import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Sandbox } from "../interface.ts";
import type { VercelSandboxConfig } from "./config.ts";
import type { VercelState } from "./state.ts";

// Minimal stand-in for the real @vercel/sandbox SDK's APIError shape,
// matching the pattern used in connect-already-exists.test.ts /
// connect-quota-fallback.test.ts.
class FakeAPIError extends Error {
  text?: string;
  json?: unknown;
  constructor(status: number, body: { text?: string; json?: unknown }) {
    super(`Status code ${status} is not ok`);
    this.name = "FakeAPIError";
    this.text = body.text;
    this.json = body.json;
  }
}

const SNAPSHOT_RESUME_400 = new FakeAPIError(400, {
  text: "Status code 400 is not ok: Cannot resume sandbox: no snapshot available.",
});

const connectMock = mock(async () => {
  throw SNAPSHOT_RESUME_400;
});

const createdSandbox = {} as Sandbox;
const createMock = mock(async (_config: VercelSandboxConfig) => createdSandbox);
let createError: Error | null = null;

// connectNamedSandbox is private, so exercise it through the exported
// connectVercel() with a named sandbox. Both collaborators are mocked:
// this test asserts the fallback wiring in connect.ts, not SDK behavior.
mock.module("./sandbox.ts", () => ({
  VercelSandbox: { connect: connectMock, create: createMock },
}));

const { connectVercel } = await import("./connect.ts");

beforeEach(() => {
  connectMock.mockClear();
  createMock.mockClear();
  createError = null;
  connectMock.mockImplementation(async () => {
    throw SNAPSHOT_RESUME_400;
  });
  createMock.mockImplementation(async (_config: VercelSandboxConfig) => {
    if (createError) {
      throw createError;
    }
    return createdSandbox;
  });
});

const baseState: VercelState = {
  sandboxName: "session_test",
  snapshotId: "snap_dead",
};

const baseOptions = {
  baseSnapshotId: "snap_base",
  createIfMissing: true,
  persistent: false,
  resume: true,
};

describe("connectVercel named-sandbox fallback", () => {
  test("recovers from a 400 snapshot-resume failure by creating fresh, without the stale snapshotId", async () => {
    const sandbox = await connectVercel(baseState, baseOptions);

    expect(sandbox).toBe(createdSandbox);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledTimes(1);

    const config = createMock.mock.calls[0]?.[0];
    expect(config).toMatchObject({
      baseSnapshotId: "snap_base",
      name: "session_test",
      persistent: false,
    });
    expect(config).not.toHaveProperty("restoreSnapshotId");
  });

  test("keeps the snapshotId on a plain 404 recreate (existing not-found behavior)", async () => {
    connectMock.mockImplementation(async () => {
      throw new Error("Status code 404 is not ok");
    });

    await connectVercel(baseState, baseOptions);

    expect(createMock).toHaveBeenCalledTimes(1);
    const config = createMock.mock.calls[0]?.[0];
    expect(config).toMatchObject({ restoreSnapshotId: "snap_dead" });
  });

  test("rethrows the snapshot-resume 400 when createIfMissing is false", async () => {
    await expect(
      connectVercel(baseState, { ...baseOptions, createIfMissing: false }),
    ).rejects.toThrow("Status code 400 is not ok");
    expect(createMock).not.toHaveBeenCalled();
  });

  test("rethrows unrelated 400 errors even with createIfMissing", async () => {
    const alreadyExistsError = new FakeAPIError(400, {
      text: "A sandbox with the name 'session_test' already exists for this project.",
    });
    connectMock.mockImplementation(async () => {
      throw alreadyExistsError;
    });

    // The SDK error's .message is just "Status code 400 is not ok";
    // assert identity so we know the *original* error was rethrown.
    await expect(connectVercel(baseState, baseOptions)).rejects.toBe(
      alreadyExistsError,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  test("falls back to an unnamed sandbox when a named create keeps colliding after recovery (2026-08-30)", async () => {
    // Found 2026-08-30 in production: a session whose saved snapshot is
    // gone (resume 400) AND whose dead name is still held on Vercel's side
    // (create 400 "already exists") used to wedge forever -- the resume
    // fallback cleared DB state, but every re-provision re-collided with
    // the still-held name. The robust recovery is: after a named create
    // still collides, retry once WITHOUT the name as a non-persistent
    // sandbox so provisioning always unblocks.
    connectMock.mockImplementation(async () => {
      throw SNAPSHOT_RESUME_400;
    });
    createError = new FakeAPIError(400, {
      text: "A sandbox with the name 'session_test' already exists for this project. Use GET /sandboxes/:name to resume it or delete it first.",
    });
    let attempts = 0;
    createMock.mockImplementation(async (_config: VercelSandboxConfig) => {
      attempts += 1;
      if (attempts === 1) {
        throw createError;
      }
      return createdSandbox;
    });

    const sandbox = await connectVercel(baseState, baseOptions);

    expect(sandbox).toBe(createdSandbox);
    expect(createMock).toHaveBeenCalledTimes(2);
    const firstConfig = createMock.mock.calls[0]?.[0];
    const secondConfig = createMock.mock.calls[1]?.[0];

    // First attempt keeps the name; the retry drops it and forces non-persistent.
    expect(firstConfig).toMatchObject({ name: "session_test" });
    expect(secondConfig).not.toHaveProperty("name");
    expect(secondConfig).toMatchObject({ persistent: false });
  });
});
