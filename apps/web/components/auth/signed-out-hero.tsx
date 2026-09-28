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
    <div className="landing relative isolate overflow-hidden bg-(--l-bg) text-(--l-fg) selection:bg-(--l-accent) selection:text-white">
      <LandingNav showSignIn={showNavCta} />
      <main>
        <section className="relative border-b border-(--l-border) px-6 pb-20 pt-24 sm:pb-28 sm:pt-32 lg:pb-36 lg:pt-40">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-(--l-accent)" />
          <div className="mx-auto max-w-[1320px]">
            <div className="mb-20 flex items-start justify-between border-t border-(--l-border) pt-4 text-[10px] font-semibold uppercase text-(--l-fg-3)">
              <span>Entry / 001</span><span className="hidden max-w-[180px] text-right sm:block">The operating system for serious agent work</span>
            </div>
            <div className="grid gap-12 lg:grid-cols-[1.25fr_.75fr] lg:gap-20">
              <div>
                <p className="mb-8 font-mono text-[11px] uppercase text-(--l-accent)">A machine for making things real</p>
                <h1 className="max-w-[930px] text-balance text-[clamp(4rem,10vw,9.8rem)] font-medium leading-[.82] tracking-[-.1em]">Build the<br /><span className="text-(--l-accent)">unbuildable.</span></h1>
                <div ref={ctaRef} className="mt-12 flex flex-wrap items-center gap-5"><SignInButton size="lg" /><span className="max-w-[240px] text-sm leading-relaxed text-(--l-fg-2)">A repository, runtime, and agent team that turns momentum into shipped software.</span></div>
              </div>
              <div className="flex flex-col justify-end lg:pb-2"><div className="border-l-2 border-(--l-accent) pl-6"><p className="max-w-sm text-xl leading-tight text-(--l-fg)">Most software waits for instructions. Entry keeps the thread between intention and proof.</p><p className="mt-8 max-w-xs text-sm leading-relaxed text-(--l-fg-2)">Entry gives every idea a place to become real — from first prompt to production pull request.</p></div></div>
            </div>
            <div className="mt-24 grid grid-cols-2 border-y border-(--l-border) sm:grid-cols-4"><div className="border-r border-(--l-border) py-4 text-[10px] uppercase text-(--l-fg-3)">Brief <strong className="mt-2 block font-mono text-lg text-(--l-fg)">01</strong></div><div className="border-r border-(--l-border) py-4 pl-4 text-[10px] uppercase text-(--l-fg-3) sm:pl-6">Explore <strong className="mt-2 block font-mono text-lg text-(--l-fg)">02</strong></div><div className="border-r border-(--l-border) py-4 text-[10px] uppercase text-(--l-fg-3) sm:pl-6">Build <strong className="mt-2 block font-mono text-lg text-(--l-fg)">03</strong></div><div className="py-4 pl-4 text-[10px] uppercase text-(--l-fg-3) sm:pl-6">Ship <strong className="mt-2 block font-mono text-lg text-(--l-accent)">04</strong></div></div>
          </div>
        </section>
        <section className="border-b border-(--l-border) px-6 py-16 sm:py-24"><div className="mx-auto max-w-[1320px]"><div className="mb-8 flex justify-between text-[10px] uppercase text-(--l-fg-3)"><span>Live workspace</span><span>Every session starts here</span></div><Stage tone="slate"><div className="mx-auto w-full max-w-[1160px]"><AppMockup /></div></Stage></div></section>
        <LandingFeatures />
        <LandingBento />
        <LandingFooter />
      </main>
    </div>
  );
}
