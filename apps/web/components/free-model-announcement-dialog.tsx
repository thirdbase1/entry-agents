"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { ProviderIcon } from "@/components/provider-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FREE_TIER_ALLOWED_MODEL_IDS } from "@/lib/billing/plans";

/**
 * One-time announcement (2026-08-19) that Ling 3.0 Flash is now free for
 * every plan, including Free-tier users who were previously locked to
 * Luna only. Bump SEEN_KEY's version suffix if we ever want to
 * re-announce a future free model instead of relying on users to have
 * never dismissed this one.
 */
const SEEN_KEY = "entry-free-model-announcement-seen-v1";
const ANNOUNCED_MODEL_ID = "ling-3.0-flash-free";

function pathIsChatPage(pathname: string): boolean {
  return pathname.startsWith("/sessions");
}

export function FreeModelAnnouncementDialog() {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated, loading } = useSession();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (loading || !isAuthenticated || !pathIsChatPage(pathname)) {
      return;
    }

    try {
      const alreadySeen = window.localStorage.getItem(SEEN_KEY);
      if (!alreadySeen) {
        setOpen(true);
      }
    } catch {
      // localStorage can throw in some privacy modes -- just skip the
      // announcement rather than crash the chat page over it.
    }
  }, [loading, isAuthenticated, pathname]);

  const dismiss = () => {
    setOpen(false);
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Ignore -- worst case the announcement shows again next visit.
    }
  };

  if (!FREE_TIER_ALLOWED_MODEL_IDS.includes(ANNOUNCED_MODEL_ID)) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && dismiss()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <ProviderIcon provider="ling" className="size-5" />
            </span>
            <DialogTitle className="flex items-center gap-1.5">
              New free model
              <Sparkles className="size-4 text-primary" />
            </DialogTitle>
          </div>
          <DialogDescription className="pt-2 text-left">
            <span className="font-medium text-foreground">
              Ling 3.0 Flash
            </span>{" "}
            is now free to use on every plan — including Free tier, previously
            limited to Luna only. Pick it from the model selector any time; it
            never spends your credit balance.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            onClick={() => {
              dismiss();
              router.refresh();
            }}
          >
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
