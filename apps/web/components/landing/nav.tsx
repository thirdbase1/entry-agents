"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SignInButton } from "@/components/auth/sign-in-button";
import { UserAvatarDropdown } from "@/components/user-avatar-dropdown";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/use-session";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";

export function LandingNav({
  showSignIn = false,
}: {
  readonly showSignIn?: boolean;
}) {
  const [scrolled, setScrolled] = useState(false);
  // FIXED 2026-08-17: this nav used to render <SignInButton /> ("Sign in
  // with Vercel") completely unconditionally on every marketing page
  // that passes showSignIn (/, /pricing, /billing/plans) -- it never
  // checked whether the visitor already had a session, so an already
  // logged-in owner landing on the billing page (e.g. via the sidebar
  // balance pill) still saw a "sign in" prompt instead of their own
  // account menu. Now it checks the real session and swaps to an
  // "Open Entry" link + the same avatar dropdown used inside the app.
  const { isAuthenticated, loading } = useSession();

  useEffect(() => {
    const handle = () => setScrolled(window.scrollY > 20);
    handle();
    window.addEventListener("scroll", handle);
    return () => window.removeEventListener("scroll", handle);
  }, []);

  return (
    <nav className="fixed left-0 right-0 top-0 z-50">
      <div className="mx-auto max-w-[1320px]">
        <div
          className={`flex h-16 items-center justify-between border-x bg-(--l-bg) pl-6 pr-4 transition-all duration-200 ${
            scrolled
              ? "border-x-(--l-border) shadow-[0_1px_0_0_var(--l-border)]"
              : "shadow-none"
          }`}
        >
          <Logo className="h-[17px]" />

          <div
            className={cn(
              "flex items-center gap-2 transition-all duration-150 [transition-timing-function:cubic-bezier(0.4,0.04,0.04,1)]",
              showSignIn
                ? "opacity-100 blur-none"
                : "pointer-events-none opacity-0 blur-xs",
            )}
          >
            {!loading && isAuthenticated ? (
              <>
                <Button asChild size="sm" variant="ghost">
                  <Link href="/">Open Entry</Link>
                </Button>
                <UserAvatarDropdown />
              </>
            ) : (
              <SignInButton size="sm" />
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
