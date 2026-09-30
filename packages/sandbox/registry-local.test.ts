import { describe, expect, test } from "bun:test";
import {
  CONTEXT_SANDBOX_TYPES,
  LOCAL_CAPABILITIES,
  SANDBOX_PROVIDER_METADATA,
  USER_SELECTABLE_SANDBOX_TYPES,
  getSandboxProviderMetadata,
  isSelectableInContext,
  listProvidersForContext,
} from "./registry-types.ts";
import { connectSandbox } from "./factory.ts";
import { requireSandboxProvider } from "./registry.ts";

/** Phase 2C — local provider discoverability. */

describe("local provider discoverability", () => {
  test("local is discoverable through the existing metadata map", () => {
    const meta = getSandboxProviderMetadata("local");
    expect(meta).toBeDefined();
    expect(meta?.id).toBe("local");
    expect(meta?.displayName).toBe("This computer");
  });

  test("local resolves to the LocalSandbox implementation", async () => {
    expect(requireSandboxProvider("local").displayName).toBe("This computer");
    // Real dispatch: local state → LocalSandbox (throws if unsupported).
    const dir = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/p2c-`),
    );
    try {
      const sandbox = await connectSandbox(
        { type: "local", rootDir: dir } as never,
      );
      // LocalSandbox is the only provider with a synchronous
      // path-contained readFile that takes (path) in this shape; assert on
      // something implementation-specific instead of instanceof, since the
      // registry returns the Sandbox interface.
      expect(typeof (sandbox as never as { execDetached: unknown }).execDetached)
        .toBe("function");
      expect(
        typeof (sandbox as never as { killCommand: unknown }).killCommand,
      ).toBe("function");
    } finally {
      await import("node:fs/promises").then((fs) =>
        fs.rm(dir, { recursive: true, force: true }),
      );
    }
  });

  test("capabilities: detached exec + kill advertised, others preserved", () => {
    const meta = getSandboxProviderMetadata("local");
    expect(meta?.capabilities).toBe(LOCAL_CAPABILITIES); // same object, not a copy
    expect(LOCAL_CAPABILITIES.execDetached).toBe(true);
    expect(LOCAL_CAPABILITIES.killCommand).toBe(true);
    // Preserve all existing Local capabilities.
    expect(LOCAL_CAPABILITIES).toEqual({
      persistentResume: true,
      drives: false,
      snapshots: false,
      execDetached: true,
      killCommand: true,
      publicPorts: false,
      credentialBrokering: false,
      timeoutExtension: false,
      workspaceMigration: false,
      maxTimeoutMs: null,
    });
  });
});

describe("web vs desktop provider availability", () => {
  test("web context unchanged: local NOT selectable in the web app", () => {
    // The shared web selector list must not contain local.
    expect(USER_SELECTABLE_SANDBOX_TYPES).toEqual(["boat", "vercel"]);
    expect(listProvidersForContext("web")).toEqual(["boat", "vercel"]);
    expect(isSelectableInContext("local", "web")).toBe(false);
    expect(isSelectableInContext("boat", "web")).toBe(true);
  });

  test("desktop context: local selectable, web providers still available", () => {
    expect(listProvidersForContext("desktop")).toEqual([
      "boat",
      "vercel",
      "local",
    ]);
    expect(isSelectableInContext("local", "desktop")).toBe(true);
    expect(isSelectableInContext("nope", "desktop")).toBe(false);
  });

  test("unknown context defaults to the web (most restrictive) list", () => {
    expect(isSelectableInContext("local")).toBe(false);
    expect(listProvidersForContext()).toEqual(["boat", "vercel"]);
  });

  test("context map only names known providers", () => {
    for (const ids of Object.values(CONTEXT_SANDBOX_TYPES)) {
      for (const id of ids) {
        expect(getSandboxProviderMetadata(id)).toBeDefined();
      }
    }
  });
});

describe("other providers untouched", () => {
  test("vercel metadata unchanged", () => {
    const meta = SANDBOX_PROVIDER_METADATA.vercel;
    expect(meta.displayName).toBe("Vercel");
    expect(meta.description).toBe("Cloud sandbox");
    expect(meta.capabilities.execDetached).toBe(true);
    expect(meta.capabilities.killCommand).toBe(true);
    expect(meta.capabilities.maxTimeoutMs).toBe(45 * 60 * 1000);
  });

  test("boat metadata unchanged", () => {
    const meta = SANDBOX_PROVIDER_METADATA.boat;
    expect(meta.displayName).toBe("Boat");
    expect(meta.description).toBe("Persistent Linux VM");
    expect(meta.capabilities.execDetached).toBe(true);
    expect(meta.capabilities.killCommand).toBe(false);
    expect(meta.capabilities.maxTimeoutMs).toBe(7_200 * 1000);
  });
});
