import type { Metadata } from "next";
import { fetchAvailableLanguageModelsWithContext } from "@/lib/models-with-context";
import { LandingFooter } from "@/components/landing/footer";
import { LandingNav } from "@/components/landing/nav";
import { PricingTable } from "./pricing-table";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Model pricing for every provider available in Entry Agent.",
};

export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const models = await fetchAvailableLanguageModelsWithContext();

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
                Pricing.
              </h1>
              <p className="mt-4 text-balance text-base leading-relaxed text-(--l-fg-2) sm:mt-6 sm:text-xl">
                Pay-as-you-go, per token. No markup, no subscription required to
                start. Free models cost nothing to run.
              </p>
            </div>

            <div className="mt-12 md:mt-16">
              <PricingTable models={models} />
            </div>

            <p className="mt-8 text-sm text-(--l-fg-3)">
              Prices shown are per 1M tokens (USD). Cached input tokens are
              billed at the cache rate shown where a model supports prompt
              caching.
            </p>
          </div>
        </section>
      </div>

      <LandingFooter />
    </div>
  );
}
