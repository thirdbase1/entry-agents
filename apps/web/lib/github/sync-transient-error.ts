/**
 * Thrown by syncUserInstallationsWithRetry when every retry attempt still
 * fails transiently (GitHub 5xx/429/timeout, e.g. an ongoing GitHub outage).
 * Kept in its own file since eslint's max-classes-per-file caps sync.ts at
 * the one class it already has (GitHubInstallationsSyncError).
 */
export class GitHubSyncTransientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitHubSyncTransientError";
  }
}
