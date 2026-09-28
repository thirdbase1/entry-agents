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
    <div className="landing relative isolate overflow-hidden bg-(--l-bg) text-(--l-fg) selection:bg-(--l-fg) selection:text-(--l-surface)">
      <LandingNav showSignIn={showNavCta} />
      <main>
        <section className="relative min-h-[760px] border-b border-(--l-border) px-6 pb-16 pt-24 sm:pt-32 lg:pt-40">
          <div className="mx-auto grid max-w-[1320px] lg:grid-cols-[72px_1fr]">
            <div className="hidden border-r border-(--l-border) pr-4 lg:block"><span className="font-mono text-[10px] uppercase text-(--l-fg-3) [writing-mode:vertical-rl]">Entry / Field notes / 001</span></div>
            <div className="lg:pl-16">
              <div className="mb-16 flex justify-between border-t border-(--l-border) pt-4 text-[10px] font-semibold uppercase text-(--l-fg-3)"><span>Agent infrastructure for people who ship</span><span className="hidden sm:block">A new kind of workspace</span></div>
              <div className="grid gap-16 lg:grid-cols-[1fr_300px] lg:gap-24">
                <div>
                  <p className="mb-7 font-mono text-[11px] uppercase text-(--l-fg-2)">A place for unfinished ideas</p>
                  <h1 className="max-w-[900px] text-balance text-[clamp(4rem,10vw,10rem)] font-medium leading-[.79] tracking-[-.105em]">Make the<br /><em className="font-serif not-italic">next thing.</em></h1>
                  <div ref={ctaRef} className="mt-14 flex flex-wrap items-center gap-6"><SignInButton size="lg" /><span className="max-w-[250px] border-l border-(--l-border) pl-5 text-sm leading-relaxed text-(--l-fg-2)">Turn a thought into a repository, a running system, and a pull request.</span></div>
                </div>
                <aside className="self-end border-t border-(--l-border) pt-5 lg:mb-2"><p className="font-mono text-[10px] uppercase text-(--l-fg-3)">The premise</p><p className="mt-5 text-xl leading-tight">Software is not a document. It is a sequence of proof.</p><p className="mt-8 text-sm leading-relaxed text-(--l-fg-2)">Entry keeps the context, tools, agents, and decisions together until the idea can stand on its own.</p></aside>
              </div>
              <div className="mt-24 grid border-y border-(--l-border) sm:grid-cols-3"><div className="border-r border-(--l-border) py-4 pr-5"><span className="font-mono text-[10px] text-(--l-fg-3)">01 / FRAME</span><p className="mt-3 text-sm">Give the idea a shape.</p></div><div className="border-r border-(--l-border) py-4 px-5"><span className="font-mono text-[10px] text-(--l-fg-3)">02 / RUN</span><p className="mt-3 text-sm">Let the work move.</p></div><div className="py-4 pl-5"><span className="font-mono text-[10px] text-(--l-fg-3)">03 / PROVE</span><p className="mt-3 text-sm">Ship something real.</p></div></div>
            </div>
          </div>
        </section>
        <section className="border-b border-(--l-border) px-6 py-20 sm:py-28"><div className="mx-auto grid max-w-[1320px] gap-8 lg:grid-cols-[180px_1fr]"><div className="font-mono text-[10px] uppercase text-(--l-fg-3)">The room<br />where it happens</div><Stage tone="slate"><div className="mx-auto w-full max-w-[1160px]"><AppMockup /></div></Stage></div></section>
        <LandingFeatures />
        <LandingBento />
        <LandingFooter />
      </main>
    </div>
  );
}
