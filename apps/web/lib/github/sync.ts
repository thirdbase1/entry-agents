import { z } from "zod";
import {
  deleteInstallationsNotInList,
  upsertInstallation,
} from "@/lib/db/installations";
import { getGitHubUsernameStrict } from "./users";
import { GitHubSyncTransientError } from "./sync-transient-error";

const userInstallationSchema = z.object({
  id: z.number(),
  repository_selection: z.enum(["all", "selected"]),
  html_url: z.string().url().nullable().optional(),
  account: z.object({
    login: z.string(),
    type: z.string(),
  }),
});

const userInstallationsResponseSchema = z.object({
  installations: z.array(userInstallationSchema),
});

export class GitHubInstallationsSyncError extends Error {
  readonly status: number;
  readonly responseText: string;

  constructor(
    message: string,
    options: { status: number; responseText: string },
  ) {
    super(message);
    this.name = "GitHubInstallationsSyncError";
    this.status = options.status;
    this.responseText = options.responseText;
  }
}

const GITHUB_403_AUTH_ERROR_PATTERNS = [
  "bad credentials",
  "oauth access token has expired",
  "oauth token has expired",
  "this token has expired",
  "token is expired",
  "token is invalid",
  "token was revoked",
  "requires authentication",
  "must grant your oauth app access",
];

function isGitHubInstallations403AuthError(responseText: string): boolean {
  const normalizedResponseText = responseText.toLowerCase();

  return GITHUB_403_AUTH_ERROR_PATTERNS.some((pattern) =>
    normalizedResponseText.includes(pattern),
  );
}

export function isGitHubInstallationsAuthError(error: unknown): boolean {
  if (error instanceof GitHubInstallationsSyncError) {
    if (error.status === 401) {
      return true;
    }

    if (error.status === 403) {
      return isGitHubInstallations403AuthError(error.responseText);
    }

    return false;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const normalizedMessage = error.message.toLowerCase();

  return (
    normalizedMessage.includes(" 401 ") ||
    (normalizedMessage.includes(" 403 ") &&
      isGitHubInstallations403AuthError(normalizedMessage))
  );
}

function normalizeAccountType(type: string): "User" | "Organization" {
  return type === "Organization" ? "Organization" : "User";
}

function isSyncableInstallation(
  installation: z.infer<typeof userInstallationSchema>,
  personalAccountLogin: string,
): boolean {
  if (installation.account.type !== "User") {
    return true;
  }

  return (
    installation.account.login.toLowerCase() ===
    personalAccountLogin.trim().toLowerCase()
  );
}

function isTransientSyncError(error: unknown): boolean {
  if (isGitHubInstallationsAuthError(error)) {
    return false;
  }
  return true;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the GitHub username and sync installations in one call, retrying
 * transient failures (GitHub 5xx/429/timeouts -- e.g. an ongoing GitHub
 * outage) a few times before giving up. This replaces the old pattern of
 * "call getGitHubUsername, if it's null just skip the sync silently" that
 * existed in the OAuth-link and App-install callback routes: that pattern
 * couldn't distinguish "token is actually bad" from "GitHub hiccuped for a
 * second", so a single transient error meant an installation the user just
 * completed on GitHub's side was never recorded in our DB, later showing up
 * as a false "GitHub App not installed" error when starting a chat.
 *
 * Throws GitHubSyncTransientError if every retry still fails transiently
 * (callers should surface a "try again" message, not "reconnect/reinstall").
 * Returns null if the user genuinely has no valid token (real auth issue).
 */
export async function syncUserInstallationsWithRetry(
  userId: string,
  token: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<number | null> {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 500;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const username = await getGitHubUsernameStrict(userId);
      if (!username) {
        // Real auth failure (401/403) -- not transient, don't retry.
        return null;
      }
      return await syncUserInstallations(userId, token, username);
    } catch (error) {
      lastError = error;
      if (!isTransientSyncError(error)) {
        // Real auth failure surfaced via syncUserInstallations -- don't retry.
        return null;
      }
      if (attempt < attempts) {
        await delay(delayMs * attempt);
      }
    }
  }

  throw new GitHubSyncTransientError(
    `GitHub installation sync failed after ${attempts} attempts (transient)`,
    { cause: lastError },
  );
}

async function fetchUserInstallations(userToken: string) {
  const installations: z.infer<typeof userInstallationSchema>[] = [];
  const perPage = 100;
  let page = 1;

  while (true) {
    const url = new URL("https://api.github.com/user/installations");
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${userToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new GitHubInstallationsSyncError(
        `Failed to fetch GitHub installations page ${page}: ${response.status} ${responseText}`,
        {
          status: response.status,
          responseText,
        },
      );
    }

    const json = await response.json();
    const parsed = userInstallationsResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Invalid GitHub installations response on page ${page}`);
    }

    const currentPageInstallations = parsed.data.installations;
    installations.push(...currentPageInstallations);

    if (currentPageInstallations.length < perPage) {
      break;
    }

    page += 1;
  }

  return installations;
}

export async function syncUserInstallations(
  userId: string,
  userToken: string,
  personalAccountLogin: string,
): Promise<number> {
  const installations = await fetchUserInstallations(userToken);
  const syncableInstallations = installations.filter((installation) =>
    isSyncableInstallation(installation, personalAccountLogin),
  );

  for (const installation of syncableInstallations) {
    await upsertInstallation({
      userId,
      installationId: installation.id,
      accountLogin: installation.account.login,
      accountType: normalizeAccountType(installation.account.type),
      repositorySelection: installation.repository_selection,
      installationUrl: installation.html_url ?? null,
    });
  }

  await deleteInstallationsNotInList(
    userId,
    syncableInstallations.map((installation) => installation.id),
  );

  return syncableInstallations.length;
}

export { GitHubSyncTransientError } from "./sync-transient-error";
