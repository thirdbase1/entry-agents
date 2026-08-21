import type { Metadata } from "next";
import { getLatestBenchmarkRunSummary } from "@/lib/db/benchmarks";
import { LandingFooter } from "@/components/landing/footer";
import { LandingNav } from "@/components/landing/nav";
import { BenchmarkLive, type BenchmarkLiveSummary } from "./benchmark-live";

export const metadata: Metadata = {
  title: "Benchmarks",
  description:
    "Real HumanEval results from Entry Agent's own harness -- the same system prompt, tools, and gateway-routed models real chats use.",
};

export const dynamic = "force-dynamic";

export default async function BenchmarksPage() {
  const run = await getLatestBenchmarkRunSummary();

  const initialSummary: BenchmarkLiveSummary | null = run
    ? {
        runId: run.runId,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
        suiteVersion: run.suiteVersion,
        modelIds: run.modelIds,
        models: run.models,
      }
    : null;

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
                Benchmarks.
              </h1>
              <p className="mt-4 text-balance text-base leading-relaxed text-(--l-fg-2) sm:mt-6 sm:text-xl">
                Real results from Entry&apos;s own agent harness -- the same
                system prompt, tools, and gateway-routed models every real chat
                uses. No cherry-picked transcripts: every task is graded by an
                independent script, not the model itself.
              </p>
            </div>

            <div className="mt-12 md:mt-16">
              <BenchmarkLive initialSummary={initialSummary} />
            </div>
          </div>
        </section>
      </div>

      <LandingFooter />
    </div>
  );
}
