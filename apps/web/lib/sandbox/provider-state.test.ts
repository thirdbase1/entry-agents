import { describe, expect, test } from "bun:test";
import { isKnownSandboxType } from "@open-agents/sandbox/registry.js";
import { getSandboxProvider } from "@open-agents/sandbox";
import { SANDBOX_MIGRATION_LEAD_MS } from "./config";
import { isSandboxMigrationDue } from "./lifecycle";
import {
  isSandboxState,
  isSandboxUnavailableError,
  type VercelSandboxState,
} from "./utils";

describe("provider-neutral sandbox state guards", () => {
  test("accepts every registered provider", () => {
    expect(isSandboxState({ type: "vercel", sandboxName: "session_1" })).toBe(
      true,
    );
    expect(isSandboxState({ type: "boat", sandboxId: "bx_1" })).toBe(true);
    expect(isSandboxState({ type: "local", rootDir: "/tmp/x" })).toBe(true);
  });

  test("rejects unknown providers instead of coercing them to vercel", () => {
    expect(isSandboxState({ type: "hybrid" })).toBe(false);
    expect(isSandboxState({ type: "aws" })).toBe(false);
    expect(isSandboxState({ type: "boatx" })).toBe(false);
    expect(isSandboxState(null)).toBe(false);
    expect(isSandboxState(undefined)).toBe(false);
    expect(isSandboxState("vercel")).toBe(false);
  });

  test("keeps working for existing vercel sessions", () => {
    const legacy: VercelSandboxState = {
      type: "vercel",
      sandboxName: "session_abc",
      persistent: false,
      expiresAt: Date.now() + 60_000,
    };

    expect(isSandboxState(legacy)).toBe(true);
    expect(isKnownSandboxType(legacy.type)).toBe(true);
  });
});

describe("lifecycle capability gating", () => {
  const nearExpiry = () => Date.now() + SANDBOX_MIGRATION_LEAD_MS / 2;

  test("migration is due for vercel (destructive stop) but not for boat", () => {
    const vercelState = {
      type: "vercel",
      sandboxName: "session_abc",
      expiresAt: nearExpiry(),
    } as const;

    const boatState = {
      type: "boat",
      sandboxId: "bx_abc",
      expiresAt: nearExpiry(),
    } as const;

    expect(getSandboxProvider("vercel")?.capabilities.workspaceMigration).toBe(
      true,
    );
    expect(getSandboxProvider("boat")?.capabilities.workspaceMigration).toBe(
      false,
    );

    expect(isSandboxMigrationDue(vercelState)).toBe(true);
    expect(isSandboxMigrationDue(boatState)).toBe(false);
  });

  test("migration is never due without an expiry", () => {
    expect(
      isSandboxMigrationDue({
        type: "vercel",
        sandboxName: "session_abc",
      } as const),
    ).toBe(false);
    expect(isSandboxMigrationDue(null)).toBe(false);
    expect(isSandboxMigrationDue(undefined)).toBe(false);
  });

  test("an expired boat sandbox still reports hibernation-worthy but not migratable", () => {
    const boatState = {
      type: "boat",
      sandboxId: "bx_abc",
      expiresAt: Date.now() - 1,
    } as const;

    expect(isSandboxMigrationDue(boatState)).toBe(false);
  });
});

describe("provider-agnostic error classification", () => {
  test("matches vercel failures", () => {
    expect(
      isSandboxUnavailableError("Request failed with status code 410"),
    ).toBe(true);
    expect(isSandboxUnavailableError("sandbox is stopped and non-persistent")).toBe(
      true,
    );
    expect(
      isSandboxUnavailableError(
        "Cannot resume sandbox: no snapshot available",
      ),
    ).toBe(true);
  });

  test("matches boat failures", () => {
    expect(
      isSandboxUnavailableError(
        "Boat API error status code 404: not_found - Sandbox bx_gone does not exist",
      ),
    ).toBe(true);
    expect(
      isSandboxUnavailableError(
        "Boat API error status code 400: machine_not_running - machine is not running",
      ),
    ).toBe(true);
    expect(
      isSandboxUnavailableError(
        "Boat API error status code 409: resume_failed - snapshot missing",
      ),
    ).toBe(true);
  });

  test("does not treat transient restores or quota errors as unavailable", () => {
    expect(
      isSandboxUnavailableError(
        "Boat API error status code 402: billing_required - add a payment method",
      ),
    ).toBe(false);
    expect(
      isSandboxUnavailableError("Request failed with status code 429"),
    ).toBe(false);
  });
});
