import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_SANDBOX_PROVIDER,
  MODAL_CAPABILITIES,
  LOCAL_CAPABILITIES,
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
  test("registers exactly modal (user-selectable) and local (dev-only)", () => {
    // Vercel and Boat were removed when Modal became the only cloud
    // provider. The registry is the single source of truth, so this test
    // is what catches a stale provider id surviving anywhere in the app.
    const selectable = listUserSelectableSandboxProviders().map(
      (provider) => provider.id,
    );
    // Modal leads: it is the registry default and the default provider's
    // capabilities (volumes, no migration) are what Entry is built around.
    expect(selectable).toEqual(["modal"]);
    expect(selectable).not.toContain("local");

    expect(isKnownSandboxType("modal")).toBe(true);
    expect(isKnownSandboxType("local")).toBe(true);
    // Removed providers must read as unknown, not as legacy-but-works.
    expect(isKnownSandboxType("vercel")).toBe(false);
    expect(isKnownSandboxType("boat")).toBe(false);
    expect(isKnownSandboxType("aws")).toBe(false);
    expect(isKnownSandboxType(undefined)).toBe(false);
  });

  test("default provider is modal", () => {
    expect(DEFAULT_SANDBOX_PROVIDER).toBe("boxd");
    expect(listUserSelectableSandboxProviders()[0]?.id).toBe("modal");
  });

  test("unknown provider fails safely instead of falling back", () => {
    expect(() => requireSandboxProvider("aws")).toThrow(
      UnsupportedSandboxProviderError,
    );
    expect(getSandboxProvider("aws")).toBeUndefined();
  });

  test("a removed provider is unregistered, not merely unavailable", () => {
    // Removing a provider must make it UNKNOWN so a stale persisted row
    // fails closed loudly, rather than silently resolving to a working
    // provider and running the session somewhere the user did not pick.
    expect(getSandboxProvider("vercel")).toBeUndefined();
    expect(getSandboxProvider("boat")).toBeUndefined();
    expect(() => requireSandboxProvider("vercel")).toThrow(
      UnsupportedSandboxProviderError,
    );
    expect(() => requireSandboxProvider("boat")).toThrow(
      UnsupportedSandboxProviderError,
    );
  });

  test("an unconfigured modal provider is reported unavailable, not substituted", () => {
    const originalId = process.env.MODAL_TOKEN_ID;
    const originalSecret = process.env.MODAL_TOKEN_SECRET;
    delete process.env.MODAL_TOKEN_ID;
    delete process.env.MODAL_TOKEN_SECRET;
    try {
      expect(requireSandboxProvider("modal").isAvailable()).toBe(false);
      expect(() => requireAvailableSandboxProvider("modal")).toThrow(
        UnsupportedSandboxProviderError,
      );
      // Availability never changes which provider a session is pinned to:
      // "modal is unconfigured" must never resolve to some other provider.
      expect(requireSandboxProvider("modal").id).toBe("modal");
    } finally {
      if (originalId === undefined) delete process.env.MODAL_TOKEN_ID;
      else process.env.MODAL_TOKEN_ID = originalId;
      if (originalSecret === undefined) delete process.env.MODAL_TOKEN_SECRET;
      else process.env.MODAL_TOKEN_SECRET = originalSecret;
    }
  });
});

describe("provider selection reaches the runtime", () => {
  const restore: Array<() => void> = [];

  beforeEach(() => {
    // The cloud provider must never be reachable except on an explicit
    // request for it. If any code path forgets to pass a provider, this
    // stub turns the mistake into a test failure instead of a sandbox.
    restore.push(
      stubConnect("modal", async () => {
        throw new Error(
          "modal must not be used when another provider is selected",
        );
      }),
    );
  });

  afterEach(() => {
    while (restore.length > 0) restore.pop()?.();
  });

  test("modal selection connects a modal sandbox", async () => {
    const modal = fakeSandbox("modal");
    restore.push(stubConnect("modal", async () => modal));

    const result = await connectSandbox({
      state: { type: "modal", volumeName: "entry-workspace-abc" },
    });
    expect(result).toBe(modal);
    expect(result.workingDirectory).toBe("/tmp/modal");
  });

  test("local selection connects the local adapter", async () => {
    const local = fakeSandbox("local");
    restore.push(stubConnect("local", async () => local));

    const result = await connectSandbox({
      state: { type: "local", rootDir: "/tmp/entry-sandbox-abc" },
    });
    expect(result).toBe(local);
    expect(result.workingDirectory).toBe("/tmp/local");
  });

  test("a removed provider rejects instead of silently using modal", async () => {
    // The migrated-away world: a session row still says vercel/boat.
    // It must fail closed with the unsupported-provider error.
    await expect(
      connectSandbox({ state: { type: "vercel" } as unknown as SandboxState }),
    ).rejects.toThrow(UnsupportedSandboxProviderError);
    await expect(
      connectSandbox({ state: { type: "boat" } as unknown as SandboxState }),
    ).rejects.toThrow(UnsupportedSandboxProviderError);
    await expect(
      connectSandbox({ state: { type: "aws" } as unknown as SandboxState }),
    ).rejects.toThrow(UnsupportedSandboxProviderError);
  });
});

describe("provider state shape and persistence", () => {
  test("modal provision state derives a stable volume name from the session", () => {
    const state = requireSandboxProvider("modal").buildProvisionState({
      sessionId: "abc",
    });

    expect(state).toEqual({
      type: "modal",
      volumeName: "entry-workspace-abc",
    });
  });

  test("modal provision state keeps the persisted volume across reconnects", () => {
    const provider = requireSandboxProvider("modal");

    const first = provider.buildProvisionState({ sessionId: "abc" });
    const reopened = provider.buildProvisionState({
      sessionId: "abc",
      existing: { type: "modal", volumeName: "entry-workspace-abc" },
    });

    expect(reopened).toEqual({
      type: "modal",
      volumeName: "entry-workspace-abc",
    });
    // The volume name is the durable identity, so it must never churn.
    expect(reopened).toMatchObject({
      volumeName: (first as { volumeName: string }).volumeName,
    });
  });

  test("fresh provision drops the sandbox id but keeps the volume", () => {
    // Modal keeps the volume name even on a fresh provision: the volume is
    // what holds the workspace, and dropping it would orphan the session's
    // files. Only the (dead) sandbox id is discarded.
    const modal = requireSandboxProvider("modal").buildProvisionState({
      sessionId: "abc",
      fresh: true,
      existing: {
        type: "modal",
        volumeName: "entry-workspace-abc",
        sandboxId: "sb-dead",
      },
    });
    expect(modal).toEqual({
      type: "modal",
      volumeName: "entry-workspace-abc",
    });
  });

  test("source is carried through for modal", () => {
    const source = { repo: "https://github.com/o/r.git", branch: "main" };

    const state = requireSandboxProvider("modal").buildProvisionState({
      sessionId: "abc",
      source,
    });
    expect(state).toMatchObject({ type: "modal", source });
  });

  test("local drops source because it never clones a repository", () => {
    // The local adapter only owns a rootDir; a git workspace is the cloud
    // provider's job. Pinning it here documents the asymmetry instead of
    // leaving the local state to silently drift.
    const state = requireSandboxProvider("local").buildProvisionState({
      sessionId: "abc",
      source: { repo: "https://github.com/o/r.git" },
    });
    expect(state).toEqual({ type: "local", rootDir: "/tmp/entry-sandbox-abc" });
  });
});

describe("capability differences", () => {
  test("modal never needs workspace migration because the volume persists", () => {
    // A Modal sandbox is capped at 24h, but its Volume is not:
    // re-provisioning remounts the same files, so migration would be pure
    // churn. This is the capability that keeps the agent's
    // `migrate` action pruned.
    expect(MODAL_CAPABILITIES.workspaceMigration).toBe(false);
    expect(MODAL_CAPABILITIES.persistentResume).toBe(true);
    expect(MODAL_CAPABILITIES.drives).toBe(true);
  });

  test("modal reports the timeout ceiling honestly and has no extension", () => {
    // `extend` was pruned from the agent tools for the same reason: Modal
    // accepts only `timeout` + `idle_timeout` at creation, both bounded
    // by the 24h hard cap.
    expect(MODAL_CAPABILITIES.maxTimeoutMs).toBe(24 * 60 * 60 * 1000);
    expect(MODAL_CAPABILITIES.timeoutExtension).toBe(false);
    expect(LOCAL_CAPABILITIES.maxTimeoutMs).toBeNull();
  });

  test("capabilities are reachable from the registered provider", () => {
    expect(requireSandboxProvider("modal").capabilities).toBe(
      MODAL_CAPABILITIES,
    );
    expect(requireSandboxProvider("local").capabilities).toBe(LOCAL_CAPABILITIES);
  });
});
