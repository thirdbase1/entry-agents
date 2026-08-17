"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useGitHubConnectionStatus } from "@/hooks/use-github-connection-status";
import { useSession } from "@/hooks/use-session";
import { GitHubReconnectDialog } from "./github-reconnect-dialog";

// Pages where GitHub access actually matters: session/chat pages (repo
// selection and repo-backed actions live there) and the connections
// settings page itself. Everywhere else -- Models, Profile, Preferences,
// Usage, Leaderboard, the marketing/landing pages, etc. -- has nothing to
// do with git and must stay usable even if the GitHub connection is
// broken. Not all users use GitHub for their sessions at all, so this
// gate should never be the thing standing between someone and an
// unrelated setting.
function pathNeedsGitHub(pathname: string): boolean {
  return pathname.startsWith("/sessions");
}

export function GitHubReconnectGate() {
  const pathname = usePathname();
  const { isAuthenticated, loading } = useSession();
  const { reconnectRequired, reason, isLoading } = useGitHubConnectionStatus({
    enabled: isAuthenticated,
  });
  const [dismissed, setDismissed] = useState(false);

  // Re-prompt on navigation to a new page instead of staying dismissed
  // forever, but never block the page load itself.
  useEffect(() => {
    setDismissed(false);
  }, [pathname]);

  const handleDismiss = useCallback(() => setDismissed(true), []);

  if (
    loading ||
    !isAuthenticated ||
    isLoading ||
    !reconnectRequired ||
    dismissed ||
    pathname === "/get-started" ||
    !pathNeedsGitHub(pathname)
  ) {
    return null;
  }

  return (
    <GitHubReconnectDialog open reason={reason} onDismiss={handleDismiss} />
  );
}
