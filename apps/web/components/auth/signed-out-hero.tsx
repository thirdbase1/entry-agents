"use client";

import { useEffect, useRef, useState } from "react";
import { SignInButton } from "@/components/auth/sign-in-button";
import { AppMockup } from "@/components/landing/app-mockup";
import { LandingBento } from "@/components/landing/bento";
import { LandingFeatures } from "@/components/landing/features";
import { LandingFooter } from "@/components/landing/footer";
import { LandingNav } from "@/components/landing/nav";

const flow = [
  ["01", "Brief", "Describe the outcome, not the implementation."],
  ["02", "Ground", "Attach the repository, branch, and constraints."],
  ["03", "Run", "Let delegated work happen in an isolated room."],
  ["04", "Review", "Keep the evidence. Reject the noise."],
] as const;

function OrbitalIndex() {
  return (
    <div aria-hidden="true" className="relative size-36 shrink-0 rounded-full border border-(--l-fg) p-3 sm:size-44">
      <div className="absolute inset-5 rounded-full border border-(--l-border)" />
      <div className="absolute inset-[2.65rem] rounded-full bg-(--l-fg) sm:inset-[3.25rem]" />
      <span className="absolute left-1/2 top-1 -translate-x-1/2 font-mono text-[9px]">ENTRY / 001</span>
      <span className="absolute bottom-1 left-1/2 -translate-x-1/2 font-mono text-[9px]">OPEN SYSTEM</span>
      <span className="absolute left-1 top-1/2 -translate-y-1/2 font-mono text-[9px]">INPUT</span>
      <span className="absolute right-1 top-1/2 -translate-y-1/2 font-mono text-[9px]">OUTPUT</span>
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
        <section className="border-b border-(--l-border) px-6 pb-20 pt-28 sm:pb-32 sm:pt-40">
          <div className="mx-auto max-w-[1320px]">
            <div className="flex items-center justify-between border-y border-(--l-fg) py-3 font-mono text-[9px] uppercase">
              <span>Entry / operating layer for software work</span>
              <span className="hidden sm:inline">Status: accepting intent</span>
            </div>
            <div className="grid gap-16 pt-16 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-24 lg:pt-24">
              <div>
                <div className="mb-12 flex items-center gap-7"><OrbitalIndex /><p className="max-w-[170px] text-xs uppercase leading-relaxed text-(--l-fg-3)">A new surface for turning repository context into shipped software.</p></div>
                <h1 className="max-w-[980px] text-balance text-[clamp(4rem,11vw,10.5rem)] font-medium leading-[0.78] tracking-[-0.12em]">Make the<br /><span className="ml-[11vw]">next move.</span></h1>
                <div ref={ctaRef} className="mt-16 flex flex-col gap-7 sm:flex-row sm:items-center"><SignInButton size="lg" /><p className="max-w-xs border-l border-(--l-border) pl-5 text-sm leading-relaxed text-(--l-fg-2)">Entry gives every serious software request a place to become specific, runnable, and reviewable.</p></div>
              </div>
              <aside className="self-end border-l border-(--l-border) pl-6 lg:mb-2"><p className="font-mono text-[9px] uppercase text-(--l-fg-3)">A better unit of work</p><p className="mt-7 text-4xl leading-[0.86] tracking-[-0.08em]">Not a prompt. A complete attempt.</p><p className="mt-10 border-t border-(--l-border) pt-4 font-mono text-[9px] uppercase text-(--l-fg-3)">Repository → room → proof</p></aside>
            </div>
          </div>
        </section>
        <section className="border-b border-(--l-border) px-6 py-6"><div className="mx-auto grid max-w-[1320px] border-l border-(--l-border) sm:grid-cols-4">{flow.map(([number, title, copy]) => <div key={number} className="border-b border-(--l-border) p-6 last:border-b-0 sm:border-b-0 sm:border-r sm:p-8 sm:last:border-r-0"><div className="flex justify-between font-mono text-[9px] text-(--l-fg-3)"><span>{number}</span><span>+</span></div><p className="mt-14 text-2xl font-medium tracking-[-0.06em]">{title}</p><p className="mt-3 max-w-[190px] text-sm leading-snug text-(--l-fg-2)">{copy}</p></div>)}</div></section>
        <section className="border-b border-(--l-border) px-6 py-24 sm:py-36"><div className="mx-auto grid max-w-[1320px] gap-12 lg:grid-cols-[180px_1fr]"><p className="font-mono text-[9px] uppercase text-(--l-fg-3)">01 / The working surface</p><div><div className="mb-10 flex flex-col justify-between gap-5 border-b border-(--l-border) pb-7 sm:flex-row sm:items-end"><h2 className="max-w-2xl text-balance text-5xl font-medium leading-[0.84] tracking-[-0.1em] sm:text-8xl">See the work<br />while it happens.</h2><span className="font-mono text-[9px] uppercase text-(--l-fg-3)">Live trace / 0001</span></div><div className="border border-(--l-fg) p-2 sm:p-6"><AppMockup /></div></div></div></section>
        <LandingFeatures />
        <LandingBento />
        <LandingFooter />
      </main>
    </div>
  );
}
