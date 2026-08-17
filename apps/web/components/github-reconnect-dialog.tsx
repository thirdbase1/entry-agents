"use client";

import Link from "next/link";
import type { GitHubConnectionReason } from "@/lib/github/status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function getReconnectDescription(
  reason: GitHubConnectionReason | null,
): string {
  switch (reason) {
    case "installations_missing":
      return "GitHub no longer reports your app installation. This usually happens after app permission changes or an installation being invalidated.";
    case "sync_auth_failed":
      return "GitHub rejected the saved connection while we refreshed your installation access.";
    case "token_unavailable":
      return "Your saved GitHub token is no longer usable.";
    default:
      return "Your GitHub connection needs to be refreshed before you continue.";
  }
}

export function GitHubReconnectDialog({
  open,
  reason,
  onDismiss,
}: {
  open: boolean;
  reason: GitHubConnectionReason | null;
  onDismiss?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDismiss?.()}>
      <DialogContent showCloseButton={Boolean(onDismiss)}>
        <DialogHeader>
          <DialogTitle>Reconnect GitHub</DialogTitle>
          <DialogDescription>
            {getReconnectDescription(reason)} Reconnect to restore repository
            access for this session, or continue without it if you&apos;re not
            using a GitHub repo right now.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {onDismiss && (
            <Button variant="ghost" onClick={onDismiss}>
              Not now
            </Button>
          )}
          <Button asChild>
            <Link href="/settings/connections">Reconnect GitHub</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
