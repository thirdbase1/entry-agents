"use client";

import { useEffect, useRef, useState } from "react";
import { SignInButton } from "@/components/auth/sign-in-button";
import { AppMockup } from "@/components/landing/app-mockup";
import { LandingBento } from "@/components/landing/bento";
import { LandingFeatures } from "@/components/landing/features";
import { LandingFooter } from "@/components/landing/footer";
import { LandingNav } from "@/components/landing/nav";

const systemMap = [
  ["01", "INTENT", "A brief with enough signal to act on."],
  ["02", "CONTEXT", "A repository, branch, and living memory."],
  ["03", "EXECUTION", "A sandbox where the attempt becomes visible."],
  ["04", "PROOF", "A diff you can inspect, keep, or discard."],
] as const;

function SignalMark() {
  return (
    <div aria-hidden="true" className="relative size-16 shrink-0 border border-(--l-fg) p-2">
      <div className="grid size-full grid-cols-4 gap-1">
        {Array.from({ length: 16 }, (_, index) => (
          <span key={index} className={index % 5 === 0 || index === 10 ? "bg-(--l-fg)" : "border border-(--l-fg-5)"} />
        ))}
      </div>
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
    <div className="landing bg-(--l-bg) text-(--l-fg) selection:bg-(--l-fg) selection:text-white">
      <LandingNav showSignIn={showNavCta} />
      <main>
        <section className="border-b border-(--l-border) px-6 pb-20 pt-28 sm:pb-28 sm:pt-40">
          <div className="mx-auto max-w-[1320px]">
            <div className="flex items-start justify-between gap-8 border-t border-(--l-fg) pt-5 font-mono text-[10px] uppercase">
              <span>Entry / software work, made inspectable</span>
              <span className="hidden max-w-48 text-right text-(--l-fg-3) sm:block">A repository-aware control surface for agents</span>
            </div>
            <div className="grid gap-14 pt-16 lg:grid-cols-[1fr_300px] lg:gap-24 lg:pt-24">
              <div>
                <div className="mb-10 flex items-center gap-5">
                  <SignalMark />
                  <p className="max-w-xs font-mono text-[10px] uppercase leading-relaxed text-(--l-fg-3)">One place to brief, run, review, and release software work.</p>
                </div>
                <h1 className="max-w-[980px] text-balance text-[clamp(4rem,10.5vw,10rem)] font-medium leading-[0.78] tracking-[-0.11em]">
                  Work in<br /><span className="ml-[8vw]">public.</span>
                </h1>
                <div ref={ctaRef} className="mt-16 flex flex-col gap-7 sm:flex-row sm:items-center">
                  <SignInButton size="lg" />
                  <p className="max-w-xs border-l border-(--l-border) pl-5 text-sm leading-relaxed text-(--l-fg-2)">Not another chat transcript. A visible path from intent to a change in your repository.</p>
                </div>
              </div>
              <div className="self-end lg:pb-2">
                <div className="border-y border-(--l-border) py-5">
                  <p className="font-mono text-[10px] uppercase text-(--l-fg-3)">The premise</p>
                  <p className="mt-6 text-3xl leading-[0.9] tracking-[-0.07em] sm:text-4xl">If the work matters, the path to it should be legible.</p>
                </div>
                <div className="mt-5 flex justify-between font-mono text-[10px] uppercase text-(--l-fg-3)"><span>Trace 001</span><span>Ready / 24h</span></div>
              </div>
            </div>
          </div>
        </section>

        <section className="border-b border-(--l-border) px-6 py-5">
          <div className="mx-auto grid max-w-[1320px] border-l border-(--l-border) sm:grid-cols-4">
            {systemMap.map(([number, title, copy]) => (
              <div key={number} className="border-b border-(--l-border) p-5 last:border-b-0 sm:border-b-0 sm:border-r sm:p-7 sm:last:border-r-0">
                <div className="flex items-center justify-between font-mono text-[10px] text-(--l-fg-3)"><span>{number}</span><span>↗</span></div>
                <p className="mt-12 font-mono text-[10px] uppercase">{title}</p>
                <p className="mt-3 max-w-[190px] text-sm leading-snug text-(--l-fg-2)">{copy}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-b border-(--l-border) px-6 py-24 sm:py-36">
          <div className="mx-auto grid max-w-[1320px] gap-12 lg:grid-cols-[180px_1fr]">
            <div className="font-mono text-[10px] uppercase text-(--l-fg-3)"><span className="text-(--l-fg)">01</span><br />The room</div>
            <div>
              <div className="mb-10 flex flex-col justify-between gap-5 border-b border-(--l-border) pb-6 sm:flex-row sm:items-end"><div><p className="font-mono text-[10px] uppercase text-(--l-fg-3)">A live working surface</p><h2 className="mt-5 max-w-2xl text-balance text-5xl font-medium leading-[0.85] tracking-[-0.09em] sm:text-7xl">The interface is the evidence.</h2></div><span className="font-mono text-[10px] uppercase text-(--l-fg-3)">Observe / 0001</span></div>
              <div className="border border-(--l-fg) p-2 sm:p-6"><AppMockup /></div>
            </div>
          </div>
        </section>

        <LandingFeatures />
        <LandingBento />
        <LandingFooter />
      </main>
    </div>
  );
}
