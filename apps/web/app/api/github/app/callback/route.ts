import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  GitHubSyncTransientError,
  syncUserInstallationsWithRetry,
} from "@/lib/github/sync";
import { getUserGitHubToken } from "@/lib/github/token";
import { isManagedTemplateTrialUser } from "@/lib/managed-template-trial";
import { sanitizeInternalRedirect } from "@/lib/redirect-safety";
import { getServerSession } from "@/lib/session/get-server-session";

function parseInstallationId(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const installationId = Number.parseInt(value, 10);
  if (!Number.isFinite(installationId)) {
    return null;
  }

  return installationId;
}

function redirectAndClearCookies(url: string | URL): NextResponse {
  const response = NextResponse.redirect(url);
  response.cookies.delete("github_app_install_redirect_to");
  response.cookies.delete("github_app_install_state");
  response.cookies.delete("github_reconnect");
  return response;
}

/**
 * GitHub App Setup URL callback — handles installation sync only.
 * OAuth token exchange is handled by better-auth at /api/auth/callback/github.
 */
export async function GET(req: Request): Promise<Response> {
  const cookieStore = await cookies();
  const redirectTo = sanitizeInternalRedirect(
    cookieStore.get("github_app_install_redirect_to")?.value,
    "/get-started",
    req.url,
  );

  const session = await getServerSession();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  const redirectUrl = new URL(redirectTo, req.url);

  if (isManagedTemplateTrialUser(session, req.url)) {
    redirectUrl.searchParams.set("github", "trial_blocked");
    return redirectAndClearCookies(redirectUrl);
  }

  const requestUrl = new URL(req.url);
  const installationId = parseInstallationId(
    requestUrl.searchParams.get("installation_id"),
  );
  const setupAction = requestUrl.searchParams.get("setup_action");

  // get the user's github token from better-auth
  const token = await getUserGitHubToken(session.user.id);
  if (!token) {
    redirectUrl.searchParams.set("github", "not_linked");
    return redirectAndClearCookies(redirectUrl);
  }

  // sync installations (retries transient GitHub-side failures instead of
  // silently giving up -- a single 5xx/429 here previously meant an
  // installation the user just completed on GitHub's side would never get
  // recorded in our DB)
  let syncedInstallationsCount: number | null = null;
  let syncFailedTransiently = false;

  try {
    syncedInstallationsCount = await syncUserInstallationsWithRetry(
      session.user.id,
      token,
    );
  } catch (error) {
    if (error instanceof GitHubSyncTransientError) {
      console.error(
        "Transient GitHub sync failure in install callback:",
        error,
      );
      syncFailedTransiently = true;
    } else {
      console.error("Failed syncing installations:", error);
    }
  }

  let githubStatus: string;
  if (setupAction === "request") {
    githubStatus = "request_sent";
  } else if ((syncedInstallationsCount ?? 0) > 0) {
    githubStatus = "app_installed";
  } else if (syncFailedTransiently) {
    githubStatus = "sync_unavailable";
  } else if (!installationId) {
    githubStatus = "no_action";
    redirectUrl.searchParams.set("missing_installation_id", "1");
  } else {
    githubStatus = "pending_sync";
  }

  redirectUrl.searchParams.set("github", githubStatus);
  return redirectAndClearCookies(redirectUrl);
}
