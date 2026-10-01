"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { approveDesktopDevice } from "./actions";

/**
 * Entry Desktop sign-in approval page.
 *
 * The desktop app opens this page in the user's browser with the 6-digit
 * code prefilled (?code=). The user signs in to Entry Web (Vercel or GitHub)
 * and approves the request. On approval, the page attempts to hand control
 * back to Entry Desktop via the entry:// deep link (cancellation only — the
 * session token never travels through the browser). A manual fallback is
 * kept for users who navigate here without the prefill.
 */
function ApproveForm() {
  const params = useSearchParams();
  const [code, setCode] = useState("");
  const [state, setState] = useState<"idle" | "working" | "done" | string>("idle");

  // Prefill from the desktop-initiated URL (?code=123456).
  useEffect(() => {
    const c = (params.get("code") ?? "").replace(/\D/g, "").slice(0, 6);
    if (/^\d{6}$/.test(c)) setCode(c);
  }, [params]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("working");
    const res = await approveDesktopDevice(code.trim());
    if ("ok" in res) setState("done");
    else setState(res.error);
  }

  // Best-effort: focus the desktop app and tell it the user cancelled.
  // Works when the entry:// protocol handler is registered (installed app).
  function cancelToDesktop() {
    window.location.href = "entry://auth/cancel";
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-lg border p-8 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/entry-logo.svg"
          alt="Entry"
          className="h-10 text-foreground"
        />
        <h1 className="text-lg font-semibold">Approve Entry Desktop</h1>

        {state !== "done" ? (
          <>
            <p className="text-sm text-muted-foreground">
              <strong>Entry Desktop</strong> on your computer is requesting
              access to your Entry account. Approve to sign in there.
            </p>
            <form onSubmit={onSubmit} className="flex w-full flex-col gap-4">
              <input
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
                className="rounded border px-3 py-2 text-center font-mono text-xl tracking-widest"
                autoFocus
              />
              <button
                type="submit"
                disabled={code.length !== 6 || state === "working"}
                className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50"
              >
                {state === "working" ? "Approving…" : "Approve"}
              </button>
            </form>
            <button
              type="button"
              onClick={cancelToDesktop}
              className="text-xs text-muted-foreground underline"
            >
              Cancel — don&apos;t sign in
            </button>
            {typeof state === "string" && state !== "idle" && state !== "working" && (
              <p className="text-sm text-red-600">
                {state === "unauthorized"
                  ? "Please sign in to Entry first, then try again."
                  : state === "expired"
                    ? "That code has expired. Start sign-in again in Entry Desktop."
                    : "Code not found. Check the code shown in Entry Desktop."}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-green-600">
              Approved. Return to Entry Desktop — sign-in completes
              automatically.
            </p>
            <button
              type="button"
              onClick={cancelToDesktop}
              className="text-xs text-muted-foreground underline"
            >
              Open Entry Desktop
            </button>
          </>
        )}
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
