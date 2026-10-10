"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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
  // that passes showSignIn (/, /pricing, /model) -- it never
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
    <nav aria-label="Primary navigation" className="fixed left-0 right-0 top-0 z-50">
      <div className="mx-auto max-w-[1320px]">
        <div
          className={`flex h-16 items-center justify-between border-x bg-(--l-bg) pl-6 pr-4 transition-all duration-200 ${
            scrolled
              ? "border-x-(--l-border) shadow-[0_1px_0_0_var(--l-border)]"
              : "shadow-none"
          }`}
        >
          <Logo className="h-[17px]" />

          {/* Key product pages, linked from every marketing page. Google
              builds sitelinks (the sub-links under a brand result) from
              the pages a site links to most prominently, so the nav is
              where these belong -- the footer alone was the only signal.
              Hidden below md: the footer carries them on small screens. */}
          <div className="hidden items-center gap-6 text-sm text-(--l-fg-2) md:flex">
            <Link
              href="/ai-coding-agent"
              className="transition-colors hover:text-(--l-fg)"
            >
              AI coding agent
            </Link>
            <Link href="/pricing" className="transition-colors hover:text-(--l-fg)">
              Pricing
            </Link>
            <Link href="/model" className="transition-colors hover:text-(--l-fg)">
              Model
            </Link>
          </div>

          {showSignIn && (
            <div className="flex items-center gap-2">
              {!loading && isAuthenticated ? (
                <>
                  <Button asChild size="sm" variant="ghost">
                    <Link href="/">Open Entry</Link>
                  </Button>
                  <UserAvatarDropdown />
                </>
              ) : (
                <Button asChild size="sm" variant="ghost">
                  <Link href="/login">Sign in</Link>
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
