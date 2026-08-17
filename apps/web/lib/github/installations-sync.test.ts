import { describe, expect, mock, test } from "bun:test";

// ./sync also exports syncUserInstallationsWithRetry, which imports
// getGitHubUsernameStrict from ./users -- and users.ts has a top-level
// `import "server-only"`, which throws outside Next's RSC test condition.
// Mock it out since none of the tests below need real GitHub/DB access.
mock.module("server-only", () => ({}));
mock.module("./users", () => ({
  getGitHubUsernameStrict: async () => null,
}));

const { GitHubInstallationsSyncError, isGitHubInstallationsAuthError } =
  await import("./sync");

describe("isGitHubInstallationsAuthError", () => {
  test("treats 401 responses as auth failures", () => {
    expect(
      isGitHubInstallationsAuthError(
        new GitHubInstallationsSyncError("Unauthorized", {
          status: 401,
          responseText: '{"message":"Bad credentials"}',
        }),
      ),
    ).toBe(true);
  });

  test("treats auth-specific 403 responses as auth failures", () => {
    expect(
      isGitHubInstallationsAuthError(
        new GitHubInstallationsSyncError("Forbidden", {
          status: 403,
          responseText:
            '{"message":"Must grant your OAuth app access to this organization."}',
        }),
      ),
    ).toBe(true);
  });

  test("does not treat rate-limited 403 responses as auth failures", () => {
    expect(
      isGitHubInstallationsAuthError(
        new GitHubInstallationsSyncError("Forbidden", {
          status: 403,
          responseText:
            '{"message":"API rate limit exceeded for user ID 123."}',
        }),
      ),
    ).toBe(false);
  });
});
