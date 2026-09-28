"use client";

import { useEffect, useRef, useState } from "react";
import { SignInButton } from "@/components/auth/sign-in-button";
import { AppMockup } from "@/components/landing/app-mockup";
import { LandingBento } from "@/components/landing/bento";
import { LandingFeatures } from "@/components/landing/features";
import { LandingFooter } from "@/components/landing/footer";
import { LandingNav } from "@/components/landing/nav";
import { Stage } from "@/components/landing/stage";

export function SignedOutHero() {
  const ctaRef = useRef<HTMLDivElement>(null);
  const [showNavCta, setShowNavCta] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setShowNavCta(!entry.isIntersecting), { threshold: 0 });
    if (ctaRef.current) observer.observe(ctaRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="landing relative isolate overflow-hidden bg-(--l-bg) text-(--l-fg) selection:bg-(--l-accent)/20">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-(--l-accent)" />
      <div className="relative z-10">
        <LandingNav showSignIn={showNavCta} />
        <main>
          <section className="relative px-6 pb-20 pt-20 sm:pt-28 md:pb-28 md:pt-36">
            <div className="mx-auto max-w-[1320px]">
              <div className="mb-10 flex items-center justify-between border-y border-(--l-border) py-3 text-[10px] font-medium uppercase text-(--l-fg-3)">
                <span>Entry Agents / Series B infrastructure</span>
                <span className="hidden sm:inline">Backed by builders</span>
              </div>
              <div className="grid gap-16 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-24">
                <div>
                  <p className="mb-7 font-mono text-xs uppercase text-(--l-accent)">The operating system for agentic work</p>
                  <h1 className="max-w-[900px] text-balance text-[clamp(4rem,10vw,9.5rem)] font-medium leading-[.8] tracking-[-.09em]">Turn intent<br /><span className="text-(--l-accent)">into output.</span></h1>
                  <div className="mt-10 grid max-w-[720px] gap-8 sm:grid-cols-[1fr_auto] sm:items-end">
                    <p className="text-pretty text-lg leading-relaxed text-(--l-fg-2) sm:text-xl">Entry gives every idea a team, a runtime, and a path to production. Describe the work. Watch a branch become software.</p>
                    <div ref={ctaRef} className="flex flex-wrap items-center gap-4"><SignInButton size="lg" /><span className="text-[10px] uppercase text-(--l-fg-3)">Start building →</span></div>
                  </div>
                </div>
                <aside className="border-l border-(--l-border) pl-6 lg:mt-20">
                  <div className="flex items-center gap-2 text-[10px] uppercase text-(--l-fg-3)"><span className="size-2 rounded-full bg-(--l-accent)" /> Live runtime</div>
                  <p className="mt-7 text-2xl leading-tight">The missing layer between a prompt and a pull request.</p>
                  <div className="mt-12 space-y-4 border-t border-(--l-border) pt-4 text-xs text-(--l-fg-2)"><div className="flex justify-between"><span>Branch</span><span className="font-mono text-(--l-fg)">entry/ready</span></div><div className="flex justify-between"><span>Runtime</span><span className="font-mono text-(--l-fg)">isolated</span></div><div className="flex justify-between"><span>Status</span><span className="font-mono text-(--l-accent)">building</span></div></div>
                </aside>
              </div>
            </div>
          </section>
          <div className="mx-auto max-w-[1320px] px-4 sm:px-6"><Stage tone="slate"><div className="mx-auto w-full max-w-[1160px]"><AppMockup /></div></Stage></div>
          <LandingFeatures />
          <LandingBento />
          <LandingFooter />
        </main>
      </div>
    </div>
  );
}
