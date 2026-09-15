import type { Metadata } from "next";
import { fetchAllLanguageModelsWithContext } from "@/lib/models-with-context";
import { LandingFooter } from "@/components/landing/footer";
import { LandingNav } from "@/components/landing/nav";
import { PricingTable } from "./pricing-table";

export const metadata: Metadata = {
  title: "Model",
  description:
    "Price and context window for every model available in Entry -- pay-as-you-go, per token, no markup.",
};

export const dynamic = "force-dynamic";

/**
 * Public model price page (owner 2026-09-15: "model pricing change to
 * just model and show all model price"). Was /pricing ("Pricing."),
 * now named "Model." -- the Pricing name belongs to the plans page.
 *
 * Shows EVERY model the gateway knows about, unfiltered: admin-disabled
 * models, hard-blocked Mythos/kimi/grok entries, everything -- a price
 * list, not a picker. Availability filtering stays picker-only.
 */
export default async function ModelPage() {
  const models = await fetchAllLanguageModelsWithContext();

  return (
    <div className="landing relative isolate min-h-screen bg-(--l-bg) text-(--l-fg) selection:bg-(--l-fg)/20">
      <div className="pointer-events-none absolute inset-y-0 left-0 right-0 hidden md:block">
        <div className="mx-auto h-full max-w-[1320px] border-x border-x-(--l-border)" />
      </div>

      <div className="relative z-10">
        <LandingNav showSignIn />

        <section className="pt-32 pb-16 md:pt-44 md:pb-24">
          <div className="mx-auto max-w-[1320px] px-6">
            <div className="max-w-[740px]">
              <h1 className="text-4xl font-semibold leading-[1.03] tracking-tighter sm:text-5xl md:text-6xl">
                Model.
              </h1>
              <p className="mt-4 text-balance text-base leading-relaxed text-(--l-fg-2) sm:mt-6 sm:text-xl">
                Pay-as-you-go, per token. No markup, no subscription required
                to start. Free models cost nothing to run. Every model the
                platform can route is listed -- see{" "}
                <a
                  href="/pricing"
                  className="underline decoration-(--l-fg-3) underline-offset-4 transition-colors hover:text-(--l-fg)"
                >
                  plans
                </a>{" "}
                for monthly credit bundles.
              </p>
            </div>

            <div className="mt-12 md:mt-16">
              <PricingTable models={models} />
            </div>
          </div>
        </section>
      </div>

      <LandingFooter />
    </div>
  );
}
