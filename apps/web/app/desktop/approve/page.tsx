"use client";

import { useState } from "react";
import { approveDesktopDevice } from "./actions";

/**
 * Entry Desktop sign-in approval page.
 * The desktop app shows a 6-digit code; the user signs in to Entry Web and
 * enters it here. Minimal UI, consistent with Entry's existing styling.
 */
export default function DesktopApprovePage() {
  const [code, setCode] = useState("");
  const [state, setState] = useState<"idle" | "working" | "done" | string>("idle");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("working");
    const res = await approveDesktopDevice(code.trim());
    if ("ok" in res) setState("done");
    else setState(res.error);
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <form
        onSubmit={onSubmit}
        className="flex w-full max-w-sm flex-col gap-4 rounded-lg border p-6"
      >
        <h1 className="text-lg font-semibold">Sign in to Entry Desktop</h1>
        <p className="text-sm text-muted-foreground">
          Enter the 6-digit code shown in the Entry Desktop sign-in window.
        </p>
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
        {state === "done" && (
          <p className="text-sm text-green-600">
            Approved. Return to Entry Desktop — sign-in completes automatically.
          </p>
        )}
        {typeof state === "string" && state !== "idle" && state !== "working" && state !== "done" && (
          <p className="text-sm text-red-600">
            {state === "unauthorized"
              ? "Please sign in to Entry first."
              : state === "expired"
                ? "That code has expired. Request a new one in Entry Desktop."
                : "Code not found. Check the code and try again."}
          </p>
        )}
      </form>
    </div>
  );
}
