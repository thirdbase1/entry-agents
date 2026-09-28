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
    <div className="landing relative isolate overflow-hidden bg-(--l-bg) text-(--l-fg) selection:bg-(--l-fg) selection:text-(--l-bg)">
      <LandingNav showSignIn={showNavCta} />
      <main>
        <section className="relative border-b border-(--l-border) px-6 pb-12 pt-28 sm:pt-36">
          <div className="mx-auto max-w-[1320px]">
            <div className="grid gap-10 border-y border-(--l-border) py-5 lg:grid-cols-[1fr_220px]">
              <div className="flex items-center gap-4 font-mono text-[10px] uppercase text-(--l-fg-3)"><span className="size-2 bg-(--l-fg)" />Entry / Build log 001</div>
              <span className="font-mono text-[10px] uppercase text-(--l-fg-3) lg:text-right">No handoff required</span>
            </div>
            <div className="grid gap-12 py-20 lg:grid-cols-[minmax(0,1fr)_280px] lg:py-28">
              <div>
                <p className="mb-8 max-w-xs font-mono text-[11px] uppercase leading-relaxed text-(--l-fg-2)">The gap between a good idea and a working system is now a place you can enter.</p>
                <h1 className="max-w-[1000px] text-balance text-[clamp(4rem,12vw,11.5rem)] font-medium leading-[.76] tracking-[-.11em]">Build<br /><span className="relative inline-block">in public<span className="absolute -right-6 top-1/2 hidden size-3 -translate-y-1/2 bg-(--l-fg) sm:block" /></span></h1>
                <div ref={ctaRef} className="mt-16 flex flex-col gap-7 sm:flex-row sm:items-center"><SignInButton size="lg" /><p className="max-w-[280px] border-l border-(--l-border) pl-5 text-sm leading-relaxed text-(--l-fg-2)">A real repository. A real runtime. A clear path from intent to shipped work.</p></div>
              </div>
              <aside className="flex flex-col justify-between border-l border-(--l-border) pl-6 lg:pt-2"><div><span className="font-mono text-[10px] uppercase text-(--l-fg-3)">01 / The thesis</span><p className="mt-6 text-2xl leading-[.95]">Software gets better when the process stays visible.</p></div><p className="mt-12 text-sm leading-relaxed text-(--l-fg-2)">Entry is the working surface for ideas that need more than a prompt and less than a committee.</p></aside>
            </div>
            <div className="grid border-t border-(--l-border) sm:grid-cols-3"><div className="border-b border-(--l-border) py-5 sm:border-b-0 sm:border-r sm:pr-6"><span className="font-mono text-[10px] text-(--l-fg-3)">A / CONTEXT</span><p className="mt-3 text-sm">Start with the whole problem.</p></div><div className="border-b border-(--l-border) py-5 sm:border-b-0 sm:border-r sm:px-6"><span className="font-mono text-[10px] text-(--l-fg-3)">B / MOTION</span><p className="mt-3 text-sm">Let the system do the busywork.</p></div><div className="py-5 sm:pl-6"><span className="font-mono text-[10px] text-(--l-fg-3)">C / EVIDENCE</span><p className="mt-3 text-sm">Keep the proof with the work.</p></div></div>
          </div>
        </section>
        <section className="border-b border-(--l-border) px-6 py-20 sm:py-28"><div className="mx-auto grid max-w-[1320px] gap-8 lg:grid-cols-[180px_1fr]"><div className="font-mono text-[10px] uppercase text-(--l-fg-3)">02 / The<br />workbench</div><Stage tone="slate"><div className="mx-auto w-full max-w-[1160px]"><AppMockup /></div></Stage></div></section>
        <LandingFeatures />
        <LandingBento />
        <LandingFooter />
      </main>
    </div>
  );
}
