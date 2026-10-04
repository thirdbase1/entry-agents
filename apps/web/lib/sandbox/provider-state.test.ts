import { describe, expect, test } from "bun:test";
import { isKnownSandboxType } from "@open-agents/sandbox/registry.js";
import { getSandboxProvider } from "@open-agents/sandbox";
import { SANDBOX_MIGRATION_LEAD_MS } from "./config";
import { isSandboxMigrationDue } from "./lifecycle";
import {
  isSandboxState,
  isSandboxUnavailableError,
  type ModalSandboxState,
} from "./utils";

describe("provider-neutral sandbox state guards", () => {
  test("accepts every registered provider", () => {
    expect(isSandboxState({ type: "modal", volumeName: "session_1" })).toBe(
      true,
    );
    expect(isSandboxState({ type: "local", rootDir: "/tmp/x" })).toBe(true);
  });

  test("rejects unknown providers instead of coercing them to modal", () => {
    expect(isSandboxState({ type: "hybrid" })).toBe(false);
    expect(isSandboxState({ type: "aws" })).toBe(false);
    expect(isSandboxState({ type: "boatx" })).toBe(false);
    expect(isSandboxState(null)).toBe(false);
    expect(isSandboxState(undefined)).toBe(false);
    expect(isSandboxState("vercel")).toBe(false);
  });

  test("a removed provider reads as unknown, so its state fails closed", () => {
    // Vercel and Boat sessions still exist in the DB. The interesting
    // property is that they must NOT be accepted as valid state -- that
    // is what forces them onto the clear-and-reprovision path instead of
    // being silently routed to the modal provider.
    expect(isKnownSandboxType("vercel")).toBe(false);
    expect(isKnownSandboxType("boat")).toBe(false);
    expect(isSandboxState({ type: "vercel", sandboxName: "session_abc" })).toBe(
      false,
    );
    expect(isSandboxState({ type: "boat", sandboxId: "bx_abc" })).toBe(false);
  });

  test("keeps working for existing modal sessions", () => {
    const current: ModalSandboxState = {
      type: "modal",
      volumeName: "entry-workspace-abc",
      expiresAt: Date.now() + 60_000,
    };

    expect(isSandboxState(current)).toBe(true);
    expect(isKnownSandboxType(current.type)).toBe(true);
  });
});

describe("lifecycle capability gating", () => {
  const nearExpiry = () => Date.now() + SANDBOX_MIGRATION_LEAD_MS / 2;

  test("migration is never due for modal because the volume persists", () => {
    const modalState = {
      type: "modal",
      volumeName: "entry-workspace-abc",
      expiresAt: nearExpiry(),
    } as const;

    expect(getSandboxProvider("modal")?.capabilities.workspaceMigration).toBe(
      false,
    );

    // This is the whole point of the Modal switch: even when the sandbox
    // is about to hit its 24h ceiling, migration is NOT triggered, because
    // the re-provisioned sandbox remounts the same volume. The old
    // workspace-pack/restore dance would be pure churn.
    expect(isSandboxMigrationDue(modalState)).toBe(false);
  });

  test("migration is never due without an expiry", () => {
    expect(
      isSandboxMigrationDue({
        type: "modal",
        volumeName: "entry-workspace-abc",
      } as const),
    ).toBe(false);
    expect(isSandboxMigrationDue(null)).toBe(false);
    expect(isSandboxMigrationDue(undefined)).toBe(false);
  });

  test("an expired modal sandbox is still not migratable", () => {
    const modalState = {
      type: "modal",
      volumeName: "entry-workspace-abc",
      expiresAt: Date.now() - 1,
    } as const;

    expect(isSandboxMigrationDue(modalState)).toBe(false);
  });
});

describe("provider-agnostic error classification", () => {
  test("matches modal failures", () => {
    // Modal's container is gone: the 24h cap or an idle timeout reaped it,
    // or the sandbox was terminated. All mean "re-provision on the same
    // volume", so they are treated as unavailable and the state is cleared.
    expect(isSandboxUnavailableError("Sandbox is not running")).toBe(true);
    expect(isSandboxUnavailableError("sandbox_timed_out")).toBe(true);
    expect(isSandboxUnavailableError("Sandbox has already finished")).toBe(
      true,
    );
    expect(isSandboxUnavailableError("sandbox has been terminated")).toBe(true);
    expect(
      isSandboxUnavailableError("Request failed with status code 410"),
    ).toBe(true);
  });

  test("does not treat quota or rate-limit errors as unavailable", () => {
    // A quota block is real -- the degraded-memory retry in
    // modal/connect.ts handles it -- but it is NOT a dead sandbox, so it
    // must not clear the session's durable volume reference.
    expect(
      isSandboxUnavailableError(
        "Request failed with status code 507: quota exceeded",
      ),
    ).toBe(false);
    expect(
      isSandboxUnavailableError("Request failed with status code 429"),
    ).toBe(false);
  });
});
