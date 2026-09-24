import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_SANDBOX_PROVIDER,
  isKnownSandboxType,
  listUserSelectableSandboxProviders,
} from "./registry-types.ts";
import {
  SANDBOX_PROVIDERS,
  UnsupportedSandboxProviderError,
  getSandboxProvider,
  requireAvailableSandboxProvider,
  requireSandboxProvider,
  type SandboxProvider,
} from "./registry.ts";
import {
  BOAT_CAPABILITIES,
  LOCAL_CAPABILITIES,
  VERCEL_CAPABILITIES,
} from "./registry-types.ts";
import { connectSandbox, type SandboxState } from "./factory.ts";
import type { Sandbox } from "./interface.ts";

function fakeSandbox(label: string): Sandbox {
  return {
    type: "cloud",
    workingDirectory: `/tmp/${label}`,
    async readFile() {
      return "";
    },
    async readFileBuffer() {
      return Buffer.alloc(0);
    },
    async writeFile() {},
    async writeFileBuffer() {},
    async stat() {
      throw new Error("not used");
    },
    async access() {},
    async mkdir() {},
    async readdir() {
      return [];
    },
    async exec() {
      return {
        success: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false,
      };
    },
    async stop() {},
  };
}

/** Swap a provider's connect() for the duration of a test. */
function stubConnect(
  id: keyof typeof SANDBOX_PROVIDERS,
  impl: SandboxProvider["connect"],
): () => void {
  const original = SANDBOX_PROVIDERS[id];
  SANDBOX_PROVIDERS[id] = { ...original, connect: impl };
  return () => {
    SANDBOX_PROVIDERS[id] = original;
  };
}

describe("sandbox provider registry", () => {
  test("registers vercel and boat as user-selectable, local as dev-only", () => {
    const selectable = listUserSelectableSandboxProviders().map(
      (provider) => provider.id,
    );
    expect(selectable).toEqual(["vercel", "boat"]);
    expect(selectable).not.toContain("local");

    expect(isKnownSandboxType("local")).toBe(true);
    expect(isKnownSandboxType("aws")).toBe(false);
    expect(isKnownSandboxType(undefined)).toBe(false);
  });

  test("default provider is vercel", () => {
    expect(DEFAULT_SANDBOX_PROVIDER).toBe("vercel");
  });

  test("unknown provider fails safely instead of falling back", () => {
    expect(() => requireSandboxProvider("aws")).toThrow(
      UnsupportedSandboxProviderError,
    );
    expect(getSandboxProvider("aws")).toBeUndefined();
  });

  test("an unconfigured boat provider is reported unavailable, not substituted", () => {
    const originalKey = process.env.BOAT_API_KEY;
    delete process.env.BOAT_API_KEY;
    try {
      expect(requireSandboxProvider("boat").isAvailable()).toBe(false);
      expect(() => requireAvailableSandboxProvider("boat")).toThrow(
        UnsupportedSandboxProviderError,
      );
      // Vercel stays available regardless -- availability never changes
      // which provider a session is pinned to.
      expect(requireAvailableSandboxProvider("vercel").id).toBe("vercel");
    } finally {
      if (originalKey === undefined) delete process.env.BOAT_API_KEY;
      else process.env.BOAT_API_KEY = originalKey;
    }
  });
});

describe("provider selection reaches the runtime", () => {
  const restore: Array<() => void> = [];

  beforeEach(() => {
    restore.push(
      stubConnect("vercel", async () => {
        throw new Error(
          "Vercel must not be used when another provider is selected",
        );
      }),
    );
  });

  afterEach(() => {
    while (restore.length > 0) restore.pop()?.();
  });

  test("boat selection connects a boat sandbox, never vercel", async () => {
    const boat = fakeSandbox("boat");
    restore.push(stubConnect("boat", async () => boat));

    const result = await connectSandbox({ state: { type: "boat" } });
    expect(result).toBe(boat);
    expect(result.workingDirectory).toBe("/tmp/boat");
  });

  test("vercel selection still connects vercel", async () => {
    // Replace the always-throwing stub installed in beforeEach.
    const vercel = fakeSandbox("vercel");
    restore.push(stubConnect("vercel", async () => vercel));

    const result = await connectSandbox({ state: { type: "vercel" } });
    expect(result).toBe(vercel);
  });

  test("an unregistered provider rejects instead of silently using vercel", async () => {
    await expect(
      connectSandbox({ state: { type: "aws" } as unknown as SandboxState }),
    ).rejects.toThrow(UnsupportedSandboxProviderError);
  });
});

describe("provider state shape and persistence", () => {
  test("vercel provision state names the session sandbox the same way as before", () => {
    const state = requireSandboxProvider("vercel").buildProvisionState({
      sessionId: "abc",
    });

    expect(state).toEqual({ type: "vercel", sandboxName: "session_abc" });
  });

  test("vercel provision state promotes a legacy sandboxId to sandboxName", () => {
    const state = requireSandboxProvider("vercel").buildProvisionState({
      sessionId: "abc",
      existing: { type: "vercel", sandboxId: "sbx-old" },
    });

    expect(state).toEqual({
      type: "vercel",
      sandboxName: "sbx-old",
    });
  });

  test("boat provision state keeps the persisted bx id across reconnects", () => {
    const provider = requireSandboxProvider("boat");

    const first = provider.buildProvisionState({ sessionId: "abc" });
    expect(first).toEqual({ type: "boat" });

    const reopened = provider.buildProvisionState({
      sessionId: "abc",
      existing: { type: "boat", sandboxId: "bx_f7k2q9hd" },
    });
    expect(reopened).toEqual({ type: "boat", sandboxId: "bx_f7k2q9hd" });
  });

  test("fresh provision drops identity so a new sandbox is created", () => {
    const vercel = requireSandboxProvider("vercel").buildProvisionState({
      sessionId: "abc",
      fresh: true,
      existing: { type: "vercel", sandboxName: "session_abc" },
    });
    expect(vercel).toEqual({ type: "vercel" });

    const boat = requireSandboxProvider("boat").buildProvisionState({
      sessionId: "abc",
      fresh: true,
      existing: { type: "boat", sandboxId: "bx_f7k2q9hd" },
    });
    expect(boat).toEqual({ type: "boat" });
  });

  test("source is carried through for every provider", () => {
    const source = { repo: "https://github.com/o/r.git", branch: "main" };

    for (const id of ["vercel", "boat"] as const) {
      const state = requireSandboxProvider(id).buildProvisionState({
        sessionId: "abc",
        source,
      });
      expect(state).toMatchObject({ type: id, source });
    }
  });
});

describe("capability differences", () => {
  test("only providers with a destructive stop need workspace migration", () => {
    expect(VERCEL_CAPABILITIES.workspaceMigration).toBe(true);
    expect(VERCEL_CAPABILITIES.persistentResume).toBe(false);

    expect(BOAT_CAPABILITIES.workspaceMigration).toBe(false);
    expect(BOAT_CAPABILITIES.persistentResume).toBe(true);
  });

  test("drives and credential brokering are vercel-only", () => {
    expect(VERCEL_CAPABILITIES.drives).toBe(true);
    expect(BOAT_CAPABILITIES.drives).toBe(false);

    expect(VERCEL_CAPABILITIES.credentialBrokering).toBe(true);
    expect(BOAT_CAPABILITIES.credentialBrokering).toBe(false);
  });

  test("timeout ceilings differ per provider", () => {
    expect(VERCEL_CAPABILITIES.maxTimeoutMs).toBe(45 * 60 * 1000);
    expect(BOAT_CAPABILITIES.maxTimeoutMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(LOCAL_CAPABILITIES.maxTimeoutMs).toBeNull();
  });

  test("capabilities are reachable from the registered provider", () => {
    expect(requireSandboxProvider("boat").capabilities).toBe(BOAT_CAPABILITIES);
    expect(requireSandboxProvider("vercel").capabilities).toBe(
      VERCEL_CAPABILITIES,
    );
  });
});
