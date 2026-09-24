import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BoatApiError } from "./client.ts";
import { BoatSandbox } from "./sandbox.ts";

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

let calls: RecordedCall[] = [];
let handler: (call: RecordedCall) => { status?: number; json?: unknown };

function callAt(index: number): RecordedCall {
  const call = calls[index];
  if (!call) {
    throw new Error(`expected a recorded request at index ${index}`);
  }
  return call;
}

function bodyAt(index: number): Record<string, unknown> {
  const body = callAt(index).body;
  if (!body || typeof body !== "object") {
    throw new Error(`expected a JSON body on request ${index}`);
  }
  return body as Record<string, unknown>;
}

function jsonResponse(status: number, json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    type: "command.finished",
    success: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  handler = () => ({ status: 200, json: okResult() });
  process.env.BOAT_API_KEY = "boat_test_key";

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    };
    calls.push(call);

    const result = handler(call);
    return jsonResponse(result.status ?? 200, result.json ?? okResult());
  }) as typeof fetch;
});

afterEach(() => {
  delete process.env.BOAT_API_KEY;
});

function makeSandbox(): BoatSandbox {
  return new BoatSandbox({
    id: "bx_test1234",
    state: "ready",
    url: "https://myboat.on.boat.dev",
  });
}

describe("Boat adapter: shell/exec", () => {
  test("exec runs against the boat command endpoint with a clamped timeout", async () => {
    const sandbox = makeSandbox();

    const result = await sandbox.exec(
      "npm test",
      "/home/user/workspace",
      60_000,
    );

    expect(calls).toHaveLength(1);
    expect(callAt(0).url).toContain("/sandboxes/bx_test1234/commands");
    expect(callAt(0).method).toBe("POST");
    expect(bodyAt(0)).toMatchObject({
      command: "npm test",
      cwd: "/home/user/workspace",
      timeoutSeconds: 60,
      detached: false,
    });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test("timeouts outside Boat's 1-600s window are clamped, never rejected", async () => {
    const sandbox = makeSandbox();

    await sandbox.exec("short", "/tmp", 1);
    await sandbox.exec("long", "/tmp", 45 * 60 * 1000);

    expect(bodyAt(0)).toMatchObject({ timeoutSeconds: 1 });
    expect(bodyAt(1)).toMatchObject({ timeoutSeconds: 600 });
  });

  test("non-zero exit and truncation are surfaced on the shared ExecResult", async () => {
    handler = () => ({
      json: okResult({
        success: false,
        exitCode: 2,
        stdout: "out",
        stderr: "boom",
        stdoutTruncated: true,
      }),
    });

    const result = await makeSandbox().exec("false", "/tmp", 5_000);

    expect(result).toEqual({
      success: false,
      exitCode: 2,
      stdout: "out",
      stderr: "boom",
      truncated: true,
    });
  });

  test("detached commands return a pollable command id", async () => {
    handler = () => ({ json: okResult({ processId: 1234, pid: 1234 }) });

    const { commandId } = await makeSandbox().execDetached(
      "npm run build",
      "/home/user/workspace",
    );

    expect(commandId).toBe("1234");
    expect(bodyAt(0)).toMatchObject({ detached: true });
  });

  test("shell arguments are single-quote escaped", async () => {
    await makeSandbox().stat("/home/user/workspace/it's here.txt");

    expect(String(bodyAt(0).command)).toContain(`'it'\\''s here.txt'`);
  });
});

describe("Boat adapter: file operations", () => {
  test("readFile reads from the boat files endpoint", async () => {
    handler = (call) => ({
      json: {
        ok: true,
        type: "file.read",
        success: true,
        path: String(new URL(call.url).searchParams.get("path")),
        encoding: "utf8",
        size: 5,
        content: "hello",
      },
    });

    const content = await makeSandbox().readFile("src/app.ts");

    expect(content).toBe("hello");
    expect(callAt(0).url).toContain("/sandboxes/bx_test1234/files");
    expect(callAt(0).url).toContain("encoding=utf8");
    expect(callAt(0).url).toContain(
      `path=${encodeURIComponent("/home/user/workspace/src/app.ts")}`,
    );
  });

  test("writeFile writes relative to the workspace", async () => {
    await makeSandbox().writeFile("notes/a.txt", "body");

    expect(callAt(0).method).toBe("PUT");
    expect(bodyAt(0)).toEqual({
      path: "/home/user/workspace/notes/a.txt",
      content: "body",
      encoding: "utf8",
    });
  });

  test("binary writes use base64 so bytes round-trip", async () => {
    await makeSandbox().writeFileBuffer("img.png", Buffer.from([1, 2, 3]));

    expect(bodyAt(0)).toEqual({
      path: "/home/user/workspace/img.png",
      content: "AQID",
      encoding: "base64",
    });
  });

  test("paths outside /home/user and /tmp fail loudly", async () => {
    await expect(makeSandbox().readFile("/etc/passwd")).rejects.toThrow(
      /must live under \/home\/user or \/tmp/,
    );
    expect(calls).toHaveLength(0);
  });

  test("stat is emulated over the command endpoint", async () => {
    handler = () => ({
      json: okResult({ stdout: "regular file|42|1700000000\n" }),
    });

    const stats = await makeSandbox().stat("/home/user/workspace/a.txt");

    expect(stats.isFile()).toBe(true);
    expect(stats.size).toBe(42);
    expect(stats.mtimeMs).toBe(1_700_000_000_000);
    expect(callAt(0).url).toContain("/commands");
  });

  test("readdir builds Dirents from find's type bytes", async () => {
    handler = () => ({
      json: okResult({ stdout: "d|src\nf|README.md\nl|link\n" }),
    });

    const entries = await makeSandbox().readdir("/home/user/workspace", {
      withFileTypes: true,
    });

    expect(entries.map((entry) => entry.name)).toEqual([
      "src",
      "README.md",
      "link",
    ]);
    expect(entries[0]?.isDirectory()).toBe(true);
    expect(entries[1]?.isFile()).toBe(true);
    expect(entries[2]?.isSymbolicLink()).toBe(true);
  });
});

describe("Boat adapter: lifecycle", () => {
  test("stop archives the sandbox exactly once", async () => {
    const sandbox = makeSandbox();

    await sandbox.stop();
    await sandbox.stop();

    const stops = calls.filter((call) => call.url.endsWith("/stop"));
    expect(stops).toHaveLength(1);
    expect(stops[0]?.method).toBe("POST");
  });

  test("extendTimeout converts an extension into an absolute ttl", async () => {
    const { expiresAt } = await makeSandbox().extendTimeout(60 * 60 * 1000);

    expect(callAt(0).method).toBe("PATCH");
    expect(callAt(0).url).toContain("/sandboxes/bx_test1234");
    const ttl = Number(bodyAt(0).ttlSeconds);
    expect(ttl).toBeGreaterThanOrEqual(3599);
    expect(ttl).toBeLessThanOrEqual(3600);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  test("snapshot stops first, then reads the snapshot Boat wrote on stop", async () => {
    handler = (call) => {
      if (call.url.includes("/snapshots/latest")) {
        return {
          json: { ok: true, snapshot: { id: "snap_1", status: "ready" } },
        };
      }
      return { json: okResult() };
    };

    const result = await makeSandbox().snapshot();

    expect(result).toEqual({ snapshotId: "snap_1" });
    expect(callAt(0).url.endsWith("/stop")).toBe(true);
    expect(callAt(1).url).toContain("/snapshots/latest");
  });

  test("hosted preview URLs are derived per port", () => {
    const sandbox = makeSandbox();

    expect(sandbox.domain(3000)).toBe("https://myboat-3000.on.boat.dev");
    expect(sandbox.domain(5173)).toBe("https://myboat-5173.on.boat.dev");
  });

  test("getState persists the provider plus the resume handle", () => {
    expect(makeSandbox().getState()).toEqual({
      type: "boat",
      sandboxId: "bx_test1234",
      subdomain: "myboat",
    });
  });
});

describe("Boat adapter: failure behaviour", () => {
  test("errors carry the structured Boat envelope in a string-matchable message", async () => {
    handler = () => ({
      status: 404,
      json: {
        ok: false,
        status: 404,
        code: "not_found",
        message: "Sandbox bx_gone does not exist",
        requestId: "req_1",
      },
    });

    const error = await makeSandbox()
      .exec("true", "/tmp", 1_000)
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(BoatApiError);
    const message = (error as Error).message;
    expect(message).toContain("status code 404");
    expect(message).toContain("not_found");
  });

  test("missing credentials throw instead of provisioning anywhere else", async () => {
    delete process.env.BOAT_API_KEY;
    const { connectBoat } = await import("./connect.ts");

    await expect(connectBoat({}, { createIfMissing: true })).rejects.toThrow(
      /BOAT_API_KEY is not set/,
    );
    expect(calls).toHaveLength(0);
  });
});
