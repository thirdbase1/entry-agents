"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

type VerifyResult =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "pending"; status: string }
  | {
      phase: "success";
      creditBalanceCents: number | null;
      plan: string | null;
    };

function BillingCallbackInner() {
  const searchParams = useSearchParams();
  const [result, setResult] = useState<VerifyResult>({ phase: "loading" });

  useEffect(() => {
    // Bachs appends `checkout_id` to success_url when the customer pays,
    // and sends them to cancel_url (without one) if they abandon. So the
    // only id here is the checkout session's.
    const checkoutId = searchParams.get("checkout_id");

    if (!checkoutId) {
      setResult({
        phase: "error",
        message:
          "No checkout id found -- if you cancelled the payment you can start again from Pricing.",
      });
      return;
    }

    fetch(`/api/billing/verify?checkout_id=${encodeURIComponent(checkoutId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setResult({ phase: "error", message: data.error });
        } else if (data.status === "success") {
          setResult({
            phase: "success",
            creditBalanceCents: data.creditBalanceCents,
            plan: data.plan,
          });
        } else {
          setResult({ phase: "pending", status: data.status ?? "unknown" });
        }
      })
      .catch((err) => {
        setResult({
          phase: "error",
          message: err instanceof Error ? err.message : "Verification failed",
        });
      });
  }, [searchParams]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-(--l-bg) px-6 text-(--l-fg)">
      <div className="max-w-md text-center">
        {result.phase === "loading" && (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">
              Confirming your payment...
            </h1>
            <p className="mt-3 text-(--l-fg-2)">
              Give us a second, we&apos;re checking with Bachs.
            </p>
          </>
        )}

        {result.phase === "success" && (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">
              Payment successful 🎉
            </h1>
            <p className="mt-3 text-(--l-fg-2)">
              {result.plan && result.plan !== "free"
                ? `You're now on the ${result.plan} plan.`
                : "Your wallet has been topped up."}
              {typeof result.creditBalanceCents === "number" && (
                <>
                  {" "}
                  Current balance: $
                  {(result.creditBalanceCents / 100).toFixed(2)}.
                </>
              )}
            </p>
            <Link
              href="/"
              className="mt-6 inline-block rounded-full bg-(--l-fg) px-6 py-2.5 text-sm font-medium text-(--l-bg)"
            >
              Back to Entry
            </Link>
          </>
        )}

        {result.phase === "pending" && (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">
              Payment {result.status}
            </h1>
            <p className="mt-3 text-(--l-fg-2)">
              We couldn&apos;t confirm a successful charge yet. If you completed
              payment, this usually resolves within a minute -- refresh, or
              check your email for a Bachs receipt.
            </p>
          </>
        )}

        {result.phase === "error" && (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">
              Something went wrong
            </h1>
            <p className="mt-3 text-(--l-fg-2)">{result.message}</p>
            <Link
              href="/"
              className="mt-6 inline-block rounded-full bg-(--l-fg) px-6 py-2.5 text-sm font-medium text-(--l-bg)"
            >
              Back to Entry
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

export default function BillingCallbackPage() {
  return (
    <Suspense fallback={null}>
      <BillingCallbackInner />
    </Suspense>
  );
}
