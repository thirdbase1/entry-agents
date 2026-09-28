"use client";

import { History } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { SignedOutHero } from "@/components/auth/signed-out-hero";
import { HomeSkeleton } from "@/components/home-skeleton";
import type { SandboxType } from "@/components/sandbox-selector-compact";
import { SessionDrawer } from "@/components/session-drawer";
import { SessionStarter } from "@/components/session-starter";
import { UserAvatarDropdown } from "@/components/user-avatar-dropdown";
import { useSession } from "@/hooks/use-session";
import { useSessions } from "@/hooks/use-sessions";
import type { VercelProjectSelection } from "@/lib/vercel/types";

interface HomePageProps {
  hasSessionCookie: boolean;
  lastRepo: { owner: string; repo: string } | null;
}

export function HomePage({ hasSessionCookie, lastRepo }: HomePageProps) {
  const router = useRouter();
  const { loading: sessionLoading, isAuthenticated } = useSession();
  const { sessions, loading, createSession } = useSessions({
    enabled: isAuthenticated,
  });

  const activeSessionCount = sessions.filter(
    (s) => s.status !== "archived",
  ).length;
  const [isCreating, setIsCreating] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleCreateSession = async (input: {
    repoOwner?: string;
    repoName?: string;
    branch?: string;
    cloneUrl?: string;
    isNewBranch: boolean;
    sandboxType: SandboxType;
    autoCommitPush: boolean;
    autoCreatePr: boolean;
    vercelProject?: VercelProjectSelection | null;
  }) => {
    setIsCreating(true);
    try {
      const { session: createdSession, chat } = await createSession({
        repoOwner: input.repoOwner,
        repoName: input.repoName,
        branch: input.branch,
        cloneUrl: input.cloneUrl,
        isNewBranch: input.isNewBranch,
        sandboxType: input.sandboxType,
        autoCommitPush: input.autoCommitPush,
        autoCreatePr: input.autoCreatePr,
        vercelProject: input.vercelProject,
      });

      router.push(`/sessions/${createdSession.id}/chats/${chat.id}`);
    } catch (error) {
      console.error("Failed to create session:", error);
    } finally {
      setIsCreating(false);
    }
  };

  const handleSessionClick = (sessionId: string) => {
    router.push(`/sessions/${sessionId}`);
  };

  if (sessionLoading && hasSessionCookie) {
    return <HomeSkeleton lastRepo={lastRepo} />;
  }

  if (!isAuthenticated) {
    return <SignedOutHero />;
  }

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-white text-foreground">
      <header className="relative z-10 flex items-center justify-between border-b border-border bg-white px-4 py-3 sm:px-8 sm:py-5">
        <div className="flex items-center gap-2 sm:justify-self-start">
          <span className="text-lg font-semibold">Entry Agents</span>
        </div>
        <div className="flex items-center gap-2 sm:justify-self-end">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label={`Open sessions${activeSessionCount > 0 ? ` (${activeSessionCount} active)` : ""}`}
            className="flex min-h-9 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {loading ? (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums text-transparent">
                0
              </span>
            ) : activeSessionCount > 0 ? (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground">
                {activeSessionCount}
              </span>
            ) : null}
            <History className="h-4 w-4" />
            <span>Sessions</span>
          </button>
          <UserAvatarDropdown />
        </div>
      </header>

      <main className="relative z-10 flex flex-1 flex-col items-center px-4 pb-16 pt-12 sm:px-8 sm:pt-24">
        <div className="mb-10 flex w-full max-w-5xl items-end justify-between border-b border-border pb-5 text-[10px] font-mono uppercase text-muted-foreground">
          <span>Workspace / New build</span>
          <span className="hidden sm:inline">01 — Brief the machine</span>
        </div>
        <h1 className="mb-4 max-w-3xl text-center text-balance text-5xl font-medium leading-[0.9] tracking-[-0.07em] sm:text-7xl">
          What deserves to exist?
        </h1>
        <p className="mb-10 max-w-md text-center text-pretty text-sm leading-relaxed text-muted-foreground">
          Start with intent. Entry will turn the shape of the idea into a working room.
        </p>

        <SessionStarter
          onSubmit={handleCreateSession}
          isLoading={isCreating}
          lastRepo={lastRepo}
        />
      </main>

      <SessionDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        sessions={sessions}
        loading={loading}
        onSessionClick={handleSessionClick}
      />
    </div>
  );
}
