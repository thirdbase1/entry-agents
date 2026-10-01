"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { approveDesktopDevice } from "./actions";
import { useSession } from "@/hooks/use-session";
import { SignInButton } from "@/components/auth/sign-in-button";

/**
 * Entry Desktop sign-in approval page — fully seamless.
 *
 * The desktop opens this page with ?code=NNNNNN (machine handshake, never
 * displayed as user-facing UI).
 *   - Signed in → the request approves automatically and the user is sent
 *     straight back to Entry Desktop.
 *   - Signed out → one provider button (Vercel or GitHub); the OAuth
 *     callback returns here and approval then happens automatically.
 * The session token never travels through the browser — the desktop keeps
 * polling the backend and completes on its own.
 */
function ApproveForm() {
  const params = useSearchParams();
  const { isAuthenticated, loading: sessionLoading } = useSession();
  const code = (params.get("code") ?? "").replace(/\D/g, "").slice(0, 6);
  const validCode = /^\d{6}$/.test(code);
  const [state, setState] = useState<"idle" | "working" | "done" | string>("idle");
  const triedRef = useRef(false);

  // Auto-approve as soon as we have a valid code AND a web session.
  useEffect(() => {
    if (!validCode || !isAuthenticated || triedRef.current) return;
    triedRef.current = true;
    setState("working");
    void approveDesktopDevice(code).then((res) => {
      if ("ok" in res) setState("done");
      else setState(res.error);
    });
  }, [validCode, isAuthenticated, code]);

  function backToDesktop() {
    // Best-effort: focus the desktop app (registered protocol handler).
    window.location.href = "entry://auth/complete";
  }

  // No code in the URL at all (manual visit): explain and bail cleanly.
  if (!validCode) {
    return (
      <Centered>
        <h1 className="text-lg font-semibold">Approve Entry Desktop</h1>
        <p className="text-sm text-muted-foreground">
          This page is opened automatically by Entry Desktop during sign-in.
          Please start sign-in from the Entry Desktop app.
        </p>
      </Centered>
    );
  }

  if (state === "done") {
    return (
      <Centered>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/entry-logo.svg" alt="Entry" className="h-10" />
        <h1 className="text-lg font-semibold">You&apos;re signed in</h1>
        <p className="text-sm text-green-600">
          Entry Desktop has been approved. Switch back to the app — it will
          finish signing in automatically.
        </p>
        <button
          type="button"
          onClick={backToDesktop}
          className="rounded bg-primary px-4 py-2 text-primary-foreground"
        >
          Return to Entry Desktop
        </button>
      </Centered>
    );
  }

  if (state === "working" || sessionLoading) {
    return (
      <Centered>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/entry-logo.svg" alt="Entry" className="h-10" />
        <h1 className="text-lg font-semibold">Signing you in…</h1>
        <p className="text-sm text-muted-foreground">
          {sessionLoading
            ? "Checking your Entry session…"
            : "Approving Entry Desktop…"}
        </p>
      </Centered>
    );
  }

  // Signed out: one click on a provider; the OAuth callback returns here
  // and approval then completes automatically.
  if (!isAuthenticated) {
    return (
      <Centered>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/entry-logo.svg" alt="Entry" className="h-10" />
        <h1 className="text-lg font-semibold">Approve Entry Desktop</h1>
        <p className="text-sm text-muted-foreground">
          <strong>Entry Desktop</strong> on your computer is requesting access
          to your Entry account. Sign in to approve it — one click, that&apos;s
          all.
        </p>
        <div className="flex w-full flex-col items-center gap-3">
          <SignInButton
            className="w-full"
            provider="vercel"
            callbackUrl={`/desktop/approve?code=${code}`}
          />
          <SignInButton
            className="w-full"
            provider="github"
            callbackUrl={`/desktop/approve?code=${code}`}
          />
        </div>
        <button
          type="button"
          onClick={() => (window.location.href = "entry://auth/cancel")}
          className="text-xs text-muted-foreground underline"
        >
          Cancel — don&apos;t sign in
        </button>
        {typeof state === "string" && state !== "idle" && (
          <p className="text-sm text-red-600">
            {state === "expired"
              ? "That request has expired. Start sign-in again in Entry Desktop."
              : state === "not_found" || state === "invalid_code"
                ? "Request not found. Start sign-in again in Entry Desktop."
                : "Something went wrong. Start sign-in again in Entry Desktop."}
          </p>
        )}
      </Centered>
    );
  }

  // Authenticated but the auto-approve returned an error (expired/not found).
  return (
    <Centered>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/entry-logo.svg" alt="Entry" className="h-10" />
      <h1 className="text-lg font-semibold">Approve Entry Desktop</h1>
      <p className="text-sm text-red-600">
        {state === "expired"
          ? "That request has expired. Start sign-in again in Entry Desktop."
          : "That sign-in request could not be approved. Start sign-in again in Entry Desktop."}
      </p>
      <button
        type="button"
        onClick={() => (window.location.href = "entry://auth/cancel")}
        className="text-xs text-muted-foreground underline"
      >
        Back to Entry Desktop
      </button>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-lg border p-8 text-center">
        {children}
      </div>
    </div>
  );
}

export default function DesktopApprovePage() {
  return (
    <Suspense>
      <ApproveForm />
    </Suspense>
  );
}
