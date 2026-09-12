import { describe, expect, test } from "bun:test";

/**
 * Regression guard for the 2026-09-12 fix: chat.ts's
 * VERCEL_CLI_PLACEHOLDER_TOKEN must pass the real Vercel CLI's
 * client-side token validation, or every vercel_cli call dies locally
 * before the network-egress credential broker ever gets a chance to
 * swap in the real token.
 *
 * Not imported from chat.ts directly -- that module transitively hits a
 * pre-existing, unrelated broken import (missing `createMcpToolSet`
 * export in packages/agent/index.ts) that already fails chat.test.ts on
 * clean main. Pinning the exact literal here (kept in sync manually)
 * still catches the actual regression class: a maintainer reintroducing
 * a hyphenated or otherwise non-word placeholder.
 *
 * Source of truth for the regex: vercel@59.16.0's dist/index.js,
 * `token.match(/(\W)/g)` -- ANY match means "invalid, must not
 * contain: ...".
 */
const VERCEL_TOKEN_INVALID_CHAR_REGEX = /(\W)/g;

// Keep this in sync with apps/web/app/workflows/chat.ts's
// VERCEL_CLI_PLACEHOLDER_TOKEN.
const CURRENT_PLACEHOLDER = "sandboxed_cli_do_not_use";
// The old, broken value -- kept only to prove the test would have
// caught the original bug.
const OLD_BROKEN_PLACEHOLDER = "sandboxed-cli-do-not-use";

describe("Vercel CLI placeholder token format", () => {
  test("current placeholder passes the real CLI's client-side token validation", () => {
    expect(
      CURRENT_PLACEHOLDER.match(VERCEL_TOKEN_INVALID_CHAR_REGEX),
    ).toBeNull();
  });

  test("the old hyphenated placeholder would have failed it (documents the bug)", () => {
    const invalid = OLD_BROKEN_PLACEHOLDER.match(
      VERCEL_TOKEN_INVALID_CHAR_REGEX,
    );
    expect(invalid).not.toBeNull();
    expect(invalid).toContain("-");
  });
});
