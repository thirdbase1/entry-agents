import { beforeAll, describe, expect, mock, test } from "bun:test";

import {
  SANDBOX_INACTIVITY_TIMEOUT_MS,
  SANDBOX_MIGRATION_LEAD_MS,
} from "./config";

mock.module("server-only", () => ({}));

let lifecycleModule: typeof import("./lifecycle");

beforeAll(async () => {
  lifecycleModule = await import("./lifecycle");
});

describe("getLifecycleDueAtMs", () => {
  // Rewritten 2026-08-28: owner asked for sandboxes to never stop before
  // they genuinely have to. Previously this took the MIN of the real
  // sandbox expiry and a separate, earlier `hibernateAfter`/inactivity
  // clock -- meaning an idle sandbox got hibernated (and, being
  // non-persistent, permanently lost) up to ~25 minutes before Vercel's
  // real Hobby-plan 45-min hard cap. Now the real expiry governs
  // whenever it's known, full stop; `hibernateAfter`/inactivity is only
  // a fallback for sessions with no tracked expiry yet.
  test("uses the real sandbox expiry even when hibernateAfter is much earlier", () => {
    const baseMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    const expiresAt = new Date(baseMs + 45 * 60 * 1000);
    const record = {
      // Simulates the old 30-min idle timer firing well before the
      // real 45-min cap -- must NOT win anymore.
      hibernateAfter: new Date(baseMs + 15 * 60 * 1000),
      lastActivityAt: new Date(baseMs),
      sandboxExpiresAt: expiresAt,
      updatedAt: new Date(baseMs),
    };

    expect(lifecycleModule.getLifecycleDueAtMs(record)).toBe(
      expiresAt.getTime() - SANDBOX_MIGRATION_LEAD_MS,
    );
  });

  test("uses the real sandbox expiry (minus migration lead) whenever it is known", () => {
    const baseMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    const expiresAt = new Date(baseMs + 10 * 60 * 1000);
    const record = {
      hibernateAfter: new Date(baseMs + 30 * 60 * 1000),
      lastActivityAt: new Date(baseMs),
      sandboxExpiresAt: expiresAt,
      updatedAt: new Date(baseMs),
    };

    expect(lifecycleModule.getLifecycleDueAtMs(record)).toBe(
      expiresAt.getTime() - SANDBOX_MIGRATION_LEAD_MS,
    );
  });

  test("falls back to hibernateAfter when there is no tracked expiry yet", () => {
    const baseMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    const hibernateAfter = new Date(baseMs + 15 * 60 * 1000);
    const record = {
      hibernateAfter,
      lastActivityAt: new Date(baseMs),
      sandboxExpiresAt: null,
      updatedAt: new Date(baseMs),
    };

    expect(lifecycleModule.getLifecycleDueAtMs(record)).toBe(
      hibernateAfter.getTime(),
    );
  });

  test("falls back to lastActivityAt when both expiry and hibernateAfter are missing", () => {
    const baseMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    const lastActivityAt = new Date(baseMs + 2 * 60 * 1000);
    const record = {
      hibernateAfter: null,
      lastActivityAt,
      sandboxExpiresAt: null,
      updatedAt: new Date(baseMs),
    };

    expect(lifecycleModule.getLifecycleDueAtMs(record)).toBe(
      lastActivityAt.getTime() + SANDBOX_INACTIVITY_TIMEOUT_MS,
    );
  });

  test("falls back to updatedAt when lastActivityAt is missing too", () => {
    const baseMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    const updatedAt = new Date(baseMs + 3 * 60 * 1000);
    const record = {
      hibernateAfter: null,
      lastActivityAt: null,
      sandboxExpiresAt: null,
      updatedAt,
    };

    expect(lifecycleModule.getLifecycleDueAtMs(record)).toBe(
      updatedAt.getTime() + SANDBOX_INACTIVITY_TIMEOUT_MS,
    );
  });
});

describe("getMigrationRetryBackoffMs", () => {
  test("starts at the base delay on the first failure", () => {
    expect(lifecycleModule.getMigrationRetryBackoffMs(1)).toBe(30 * 1000);
  });

  test("doubles per consecutive failure", () => {
    expect(lifecycleModule.getMigrationRetryBackoffMs(2)).toBe(60 * 1000);
    expect(lifecycleModule.getMigrationRetryBackoffMs(3)).toBe(120 * 1000);
  });

  test("caps at the configured max instead of growing unbounded", () => {
    expect(lifecycleModule.getMigrationRetryBackoffMs(4)).toBe(120 * 1000);
    expect(lifecycleModule.getMigrationRetryBackoffMs(10)).toBe(120 * 1000);
  });

  test("treats a failureCount below 1 the same as the first failure", () => {
    expect(lifecycleModule.getMigrationRetryBackoffMs(0)).toBe(30 * 1000);
  });
});
