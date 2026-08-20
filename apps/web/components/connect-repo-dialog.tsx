"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  GitBranch,
  Loader2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { Session } from "@/lib/db/schema";
import { RepoSelector } from "@/components/repo-selector";

interface ConnectRepoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session;
  hasSandbox: boolean;
  onRepoConnected?: (result: {
    cloneUrl: string;
    owner: string;
    repoName: string;
    branch: string;
  }) => void;
}

interface ConnectRepoResult {
  repoOwner: string;
  repoName: string;
  branch: string;
  cloneUrl: string;
  committed: boolean;
  pushed: boolean;
  commitUrl?: string;
}

export function ConnectRepoDialog({
  open,
  onOpenChange,
  session,
  hasSandbox,
  onRepoConnected,
}: ConnectRepoDialogProps) {
  const isChangingRepo = Boolean(session.repoOwner && session.repoName);
  const [selectedOwner, setSelectedOwner] = useState("");
  const [selectedRepo, setSelectedRepo] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [result, setResult] = useState<ConnectRepoResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset form state whenever the dialog opens
  useEffect(() => {
    if (open) {
      setSelectedOwner("");
      setSelectedRepo("");
      setResult(null);
      setError(null);
    }
  }, [open]);

  const handleRepoSelect = (owner: string, repo: string) => {
    setSelectedOwner(owner);
    setSelectedRepo(repo);
  };

  const handleConnect = async () => {
    if (!(selectedOwner && selectedRepo)) {
      setError("Select a repository first");
      return;
    }
    if (!hasSandbox) {
      setError("Sandbox not active. Please wait for it to start.");
      return;
    }
    if (
      isChangingRepo &&
      selectedOwner === session.repoOwner &&
      selectedRepo === session.repoName
    ) {
      setError(
        `This session is already connected to ${session.repoOwner}/${session.repoName}. Pick a different repository to switch.`,
      );
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      const res = await fetch("/api/github/connect-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.id,
          owner: selectedOwner,
          repo: selectedRepo,
          ...(isChangingRepo ? { force: true } : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to connect repository");
      }

      const connectResult: ConnectRepoResult = {
        repoOwner: data.repoOwner,
        repoName: data.repoName,
        branch: data.branch,
        cloneUrl: data.cloneUrl,
        committed: data.committed,
        pushed: data.pushed,
        commitUrl: data.commitUrl,
      };
      setResult(connectResult);
      onRepoConnected?.({
        cloneUrl: connectResult.cloneUrl,
        owner: connectResult.repoOwner,
        repoName: connectResult.repoName,
        branch: connectResult.branch,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to connect repository",
      );
    } finally {
      setIsConnecting(false);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
  };

  const repoUrl = result
    ? `https://github.com/${result.repoOwner}/${result.repoName}`
    : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            {isChangingRepo ? "Change Repository" : "Connect Repository"}
          </DialogTitle>
          <DialogDescription>
            {isChangingRepo ? (
              <>
                This session is currently connected to{" "}
                <span className="font-medium text-foreground">
                  {session.repoOwner}/{session.repoName}
                </span>
                . Pick a different repository you have write access to and this
                chat will switch to it.
              </>
            ) : (
              "Link this session to a GitHub repository you already have write access to, then push its current work as a new branch."
            )}
          </DialogDescription>
        </DialogHeader>

        {isChangingRepo && !result && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {session.repoOwner}/{session.repoName} itself is untouched on
              GitHub -- this only disconnects it from this chat and starts a
              fresh branch on the new repo.
            </span>
          </div>
        )}

        {result ? (
          <div className="flex flex-col items-center gap-4 py-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10">
              <Check className="h-6 w-6 text-green-500" />
            </div>
            <div className="text-center">
              <p className="font-medium">
                {isChangingRepo
                  ? "Switched to the new repository!"
                  : "Repository connected!"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {result.repoOwner}/{result.repoName} · branch {result.branch}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {result.pushed
                  ? "Current work pushed as the first commit."
                  : "Nothing to push yet -- it'll go up on the next change."}
              </p>
              {(result.commitUrl || repoUrl) && (
                // External link to GitHub - not internal navigation
                // oxlint-disable-next-line nextjs/no-html-link-for-pages
                <a
                  href={result.commitUrl ?? repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-sm text-blue-500 hover:underline"
                >
                  View on GitHub
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
            <Button variant="outline" onClick={handleClose}>
              Close
            </Button>
          </div>
        ) : (
          <>
            <div className="grid gap-4 py-4">
              <RepoSelector onRepoSelect={handleRepoSelect} />
              {selectedOwner && selectedRepo && (
                <p className="text-xs text-muted-foreground">
                  {isChangingRepo
                    ? `Will switch to ${selectedOwner}/${selectedRepo} and push this session's current work as a new branch off its default branch.`
                    : `Will connect to ${selectedOwner}/${selectedRepo} and push this session's current work as a new branch off its default branch.`}
                </p>
              )}
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={handleClose}
                disabled={isConnecting}
              >
                Cancel
              </Button>
              <Button
                onClick={handleConnect}
                disabled={isConnecting || !(selectedOwner && selectedRepo)}
              >
                {isConnecting ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {isChangingRepo ? "Switching..." : "Connecting..."}
                  </>
                ) : isChangingRepo ? (
                  "Switch Repository"
                ) : (
                  "Connect"
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
