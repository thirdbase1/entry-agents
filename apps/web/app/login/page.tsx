import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/landing/logo";
import { SignInButton } from "@/components/auth/sign-in-button";

/**
 * The dedicated sign-in page (Vercel-login style: one centered card,
 * full-width provider buttons, nothing else to click).
 *
 * All three configured providers are offered: Vercel, Google, GitHub.
 * Marketing CTAs ("Start building", nav "Sign in") funnel here instead
 * of embedding the OAuth handoff in the landing page.
 *
 * `?next=` carries a same-origin post-login destination (the OAuth
 * round trip loses client state, so the path travels in the query).
 */
export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Sign in to Entry Agents with Vercel, Google, or GitHub to start shipping with an autonomous coding agent.",
  robots: {
    // Thin utility page: follow links but keep it out of the index so
    // brand queries resolve to the homepage instead.
    index: false,
    follow: true,
  },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const nextParam = Array.isArray(params.next) ? params.next[0] : params.next;

  // Only accept same-origin paths as the post-login destination.
  const callbackUrl =
    nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//")
      ? nextParam
      : "/sessions";

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm">
        <Link
          href="/"
          className="mb-10 flex items-center justify-center gap-2 text-sm font-semibold tracking-tight"
        >
          <Logo className="text-foreground" />
        </Link>

        <div className="rounded-2xl border border-border/60 bg-card p-7 shadow-sm sm:p-8">
          <div className="text-center">
            <h1 className="text-2xl font-semibold tracking-tight">
              Welcome back
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Sign in to start shipping with an autonomous coding agent.
            </p>
          </div>

          <div className="mt-8 grid gap-3">
            <SignInButton
              provider="vercel"
              callbackUrl={callbackUrl}
              className="h-11 w-full justify-center"
            />
            <SignInButton
              provider="google"
              callbackUrl={callbackUrl}
              className="h-11 w-full justify-center"
            />
            <SignInButton
              provider="github"
              callbackUrl={callbackUrl}
              className="h-11 w-full justify-center"
            />
          </div>

          <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">
            By continuing, you agree to use Entry Agents responsibly and only
            connect accounts you control.
          </p>
        </div>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          <Link
            href="/"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Back to Entry Agents
          </Link>
        </p>
      </div>
    </main>
  );
}
