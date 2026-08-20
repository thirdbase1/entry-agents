"use client";

import { useEffect, useState } from "react";
import { LandingNav } from "@/components/landing/nav";
import { LandingFooter } from "@/components/landing/footer";

interface PlanRow {
  id: string;
  name: string;
  priceUsdCents: number;
  creditGrantCents: number;
  modelAccess: "luna-only" | "all";
  priceNgnKobo: number;
}

interface BillingMeResponse {
  plan: string;
  planName: string;
  creditBalanceCents: number;
  creditGrantCents: number;
}

const PLAN_BLURB: Record<string, string> = {
  free: "Try Entry with GPT-5.6 Luna. $1 trial credit, no card required.",
  plus: "Full model access. 2x credit on every renewal.",
  pro: "More headroom for daily coding.",
  max: "Heaviest workloads, priority throughput.",
};

function formatUsd(cents: number) {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function formatNgn(kobo: number) {
  return `₦${Math.round(kobo / 100).toLocaleString("en-NG")}`;
}

export default function BillingPlansPage() {
  const [plans, setPlans] = useState<PlanRow[] | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [pendingPlan, setPendingPlan] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Current subscription state, if the visitor is logged in and already
  // on a plan -- undefined while still loading, null once we know
  // they're logged out / /api/billing/me 401'd. Added 2026-08-17: this
  // page previously never checked this at all, so an already-subscribed
  // user clicking the sidebar balance pill landed on the exact same
  // "pick a plan" marketing page a first-time visitor sees, with no
  // acknowledgement they were already paying for something.
  const [me, setMe] = useState<BillingMeResponse | null | undefined>(undefined);

  useEffect(() => {
    fetch("/api/billing/plans")
      .then((res) => res.json())
      .then((data) => {
        setPlans(data.plans);
        setRate(data.usdToNgnRate);
      })
      .catch(() => setErrorMessage("Couldn't load plans, try refreshing."));

    fetch("/api/billing/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setMe(data))
      .catch(() => setMe(null));
  }, []);

  async function handleSubscribe(planId: string) {
    if (planId === "free") {
      return;
    }
    setErrorMessage(null);
    setPendingPlan(planId);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Checkout failed");
      }
      window.location.href = data.authorizationUrl;
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Checkout failed");
      setPendingPlan(null);
    }
  }

  return (
    <div className="landing relative isolate min-h-screen bg-(--l-bg) text-(--l-fg) selection:bg-(--l-fg)/20">
      <div className="relative z-10">
        <LandingNav showSignIn />

        <section className="pt-32 pb-16 md:pt-44 md:pb-24">
          <div className="mx-auto max-w-[1320px] px-6">
            <div className="max-w-[740px]">
              <h1 className="text-4xl font-semibold leading-[1.03] tracking-tighter sm:text-5xl md:text-6xl">
                Plans.
              </h1>
              <p className="mt-4 text-balance text-base leading-relaxed text-(--l-fg-2) sm:mt-6 sm:text-xl">
                Credit-based pricing -- $1 in credit is $1 of usage, no markup.
                Subscriptions include a bonus credit top-up every month.
              </p>
              <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-(--l-border) px-4 py-2 text-sm text-(--l-fg-2)">
                🇳🇬 Nigerian debit &amp; credit cards accepted -- checkout is in
                Naira via Paystack, converted at the live USD/NGN rate.
              </div>
            </div>

            {errorMessage && (
              <p className="mt-6 text-sm text-red-500">{errorMessage}</p>
            )}

            {me && (
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-(--l-border) bg-(--l-fg)/[0.04] px-5 py-4">
                <p className="text-sm text-(--l-fg-2)">
                  You&apos;re on the{" "}
                  <span className="font-semibold text-(--l-fg)">
                    {me.planName}
                  </span>{" "}
                  plan -- {formatUsd(me.creditBalanceCents)} credit remaining.
                </p>
              </div>
            )}

            <div className="mt-12 grid gap-4 md:mt-16 md:grid-cols-4">
              {(plans ?? []).map((plan) => {
                const isCurrentPlan = me?.plan === plan.id;
                return (
                  <div
                    key={plan.id}
                    className={`flex flex-col justify-between rounded-2xl border p-6 ${
                      isCurrentPlan
                        ? "border-(--l-fg) ring-1 ring-(--l-fg)/20"
                        : "border-(--l-border)"
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <div className="text-lg font-semibold">{plan.name}</div>
                        {isCurrentPlan && (
                          <span className="rounded-full bg-(--l-fg) px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-(--l-bg)">
                            Current plan
                          </span>
                        )}
                      </div>
                      <div className="mt-2 text-3xl font-semibold tracking-tight">
                        {formatUsd(plan.priceUsdCents)}
                        <span className="text-sm font-normal text-(--l-fg-3)">
                          /mo
                        </span>
                      </div>
                      {plan.priceUsdCents > 0 && (
                        <div className="mt-1 text-sm text-(--l-fg-3)">
                          ≈ {formatNgn(plan.priceNgnKobo)}/mo charged in Naira
                        </div>
                      )}
                      <p className="mt-3 text-sm text-(--l-fg-2)">
                        {PLAN_BLURB[plan.id]}
                      </p>
                      <p className="mt-3 text-sm text-(--l-fg-2)">
                        {plan.creditGrantCents > 0
                          ? `${formatUsd(plan.creditGrantCents)} credit ${
                              plan.priceUsdCents === 0
                                ? "one-time"
                                : "every renewal"
                            }`
                          : "No credit included"}
                      </p>
                      <p className="mt-1 text-sm text-(--l-fg-2)">
                        {plan.modelAccess === "all"
                          ? "Every model, full access"
                          : "GPT-5.6 Luna only"}
                      </p>
                    </div>

                    <button
                      type="button"
                      disabled={
                        plan.id === "free" ||
                        pendingPlan === plan.id ||
                        isCurrentPlan
                      }
                      onClick={() => handleSubscribe(plan.id)}
                      className={`mt-6 rounded-full px-6 py-2.5 text-sm font-medium disabled:opacity-50 ${
                        isCurrentPlan
                          ? "border border-(--l-border) bg-transparent text-(--l-fg)"
                          : "bg-(--l-fg) text-(--l-bg)"
                      }`}
                    >
                      {isCurrentPlan
                        ? "Your plan"
                        : plan.id === "free"
                          ? "Default"
                          : pendingPlan === plan.id
                            ? "Redirecting..."
                            : me
                              ? "Switch"
                              : "Subscribe"}
                    </button>
                  </div>
                );
              })}
            </div>

            {rate && (
              <p className="mt-8 text-sm text-(--l-fg-3)">
                Live rate: $1 ≈ ₦{Math.round(rate).toLocaleString("en-NG")}.
                Refreshed every few minutes, never hardcoded.
              </p>
            )}
          </div>
        </section>
      </div>

      <LandingFooter />
    </div>
  );
}
