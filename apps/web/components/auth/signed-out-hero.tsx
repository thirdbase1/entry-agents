"use client";

import { ArrowUpRight, Check, ChevronRight, CircleDot, GitBranch, Play, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SignInButton } from "@/components/auth/sign-in-button";
import { AppMockup } from "@/components/landing/app-mockup";
import { LandingBento } from "@/components/landing/bento";
import { LandingFeatures } from "@/components/landing/features";
import { LandingFooter } from "@/components/landing/footer";
import { LandingNav } from "@/components/landing/nav";

const process = [
  { number: "01", title: "Frame", copy: "A real brief, pinned to the repo that matters.", icon: GitBranch },
  { number: "02", title: "Delegate", copy: "Specialists take the work in parallel, not in turns.", icon: CircleDot },
  { number: "03", title: "Prove", copy: "Every decision returns with a trace you can inspect.", icon: Check },
];

function TraceRail() {
  return (
    <div className="relative border-l border-(--l-border) pl-5 font-mono text-[10px] leading-loose text-(--l-fg-3)">
      <span className="absolute -left-[4px] top-1 size-2 rounded-full bg-(--l-accent)" />
      <p className="text-(--l-fg)">run / 8f2c1a</p>
      <p>repo attached</p>
      <p>3 agents delegated</p>
      <p className="text-(--l-accent)">waiting for review_</p>
    </div>
  );
}

export function SignedOutHero() {
  const ctaRef = useRef<HTMLDivElement>(null);
  const [showNavCta, setShowNavCta] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setShowNavCta(!entry.isIntersecting), { threshold: 0 });
    if (ctaRef.current) observer.observe(ctaRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="landing bg-(--l-bg) text-(--l-fg) selection:bg-(--l-accent) selection:text-white">
      <LandingNav showSignIn={showNavCta} />
      <main>
        <section className="relative overflow-hidden border-b border-(--l-border) px-6 pb-20 pt-28 sm:pb-32 sm:pt-40">
          <div className="mx-auto max-w-[1320px]">
            <div className="mb-14 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.08em] text-(--l-fg-3)">
              <span>Entry / software work system</span>
              <span className="hidden sm:inline">Online · 24 agents available</span>
            </div>
            <div className="grid gap-16 lg:grid-cols-[1fr_300px] lg:gap-24">
              <div>
                <p className="mb-7 flex items-center gap-2 font-mono text-[11px] uppercase text-(--l-accent)"><span className="size-2 rounded-full bg-(--l-accent)" />The interface between intent and shipped code</p>
                <h1 className="max-w-[980px] text-balance text-[clamp(4.2rem,10.5vw,10rem)] font-medium leading-[0.78] tracking-[-0.12em]">Software work,<br /><span className="ml-[12vw]">made visible.</span></h1>
                <div ref={ctaRef} className="mt-14 flex flex-col gap-8 sm:flex-row sm:items-center">
                  <SignInButton size="lg" />
                  <p className="max-w-[260px] border-l border-(--l-border) pl-5 text-sm leading-relaxed text-(--l-fg-2)">A repository-aware room for briefs, delegated agents, sandboxes, and the evidence between them.</p>
                </div>
              </div>
              <div className="self-end">
                <TraceRail />
                <div className="mt-14 border-t border-(--l-border) pt-4 font-mono text-[10px] uppercase text-(--l-fg-3)">One place to start<br />and finish the attempt.</div>
              </div>
            </div>
            <div className="mt-24 grid border-y border-(--l-border) sm:grid-cols-3">
              {process.map(({ number, title, copy, icon: Icon }) => (
                <div key={number} className="group border-b border-(--l-border) p-6 last:border-b-0 sm:border-b-0 sm:border-r sm:p-8 sm:last:border-r-0">
                  <div className="flex items-center justify-between font-mono text-[10px] text-(--l-fg-3)"><span>{number}</span><Icon className="size-4 stroke-[1.5] text-(--l-accent)" /></div>
                  <h2 className="mt-16 text-3xl font-medium tracking-[-0.08em]">{title}</h2>
                  <p className="mt-3 max-w-[210px] text-sm leading-relaxed text-(--l-fg-2)">{copy}</p>
                  <ChevronRight className="mt-8 size-4 -translate-x-1 text-(--l-fg-4) transition-transform duration-150 ease-out group-hover:translate-x-0" />
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-(--l-border) px-6 py-24 sm:py-36">
          <div className="mx-auto grid max-w-[1320px] gap-12 lg:grid-cols-[200px_1fr]">
            <div className="font-mono text-[10px] uppercase text-(--l-fg-3)"><span className="text-(--l-accent)">/ 01</span><br />The working room</div>
            <div>
              <div className="mb-10 flex flex-col justify-between gap-6 border-b border-(--l-border) pb-8 sm:flex-row sm:items-end"><h2 className="max-w-3xl text-balance text-5xl font-medium leading-[0.84] tracking-[-0.1em] sm:text-8xl">Not a chat.<br />A control room.</h2><p className="max-w-[190px] text-sm leading-relaxed text-(--l-fg-2)">The repo, the running sandbox, the agent handoffs, and the proof stay in one frame.</p></div>
              <div className="border border-(--l-fg) bg-(--l-panel) p-2 shadow-[12px_12px_0_var(--l-accent)] sm:p-5"><AppMockup /></div>
              <div className="mt-5 flex items-center justify-between font-mono text-[10px] uppercase text-(--l-fg-3)"><span className="flex items-center gap-2"><Play className="size-3 fill-current text-(--l-accent)" /> Live execution surface</span><span className="hidden sm:inline">stdout · diff · approvals · state</span></div>
            </div>
          </div>
        </section>

        <LandingFeatures />
        <LandingBento />
        <section className="border-y border-(--l-border) px-6 py-24 sm:py-36"><div className="mx-auto grid max-w-[1320px] gap-10 lg:grid-cols-[1fr_300px]"><h2 className="max-w-4xl text-balance text-6xl font-medium leading-[0.82] tracking-[-0.1em] sm:text-9xl">Bring the<br /><span className="text-(--l-accent)">hard thing.</span></h2><div className="self-end border-l border-(--l-border) pl-5"><SquareTerminal className="mb-10 size-5 text-(--l-accent)" /><p className="text-sm leading-relaxed text-(--l-fg-2)">The best work starts with a messy problem. Give it a home with enough context to become real.</p><a className="mt-7 inline-flex items-center gap-2 font-mono text-[10px] uppercase text-(--l-fg)" href="#top">Start a session <ArrowUpRight className="size-3" /></a></div></div></section>
        <LandingFooter />
      </main>
    </div>
  );
}
