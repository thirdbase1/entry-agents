"use client";

import { useEffect, useRef, useState } from "react";
import { SignInButton } from "@/components/auth/sign-in-button";
import { AppMockup } from "@/components/landing/app-mockup";
import { LandingBento } from "@/components/landing/bento";
import { LandingFeatures } from "@/components/landing/features";
import { LandingFooter } from "@/components/landing/footer";
import { LandingNav } from "@/components/landing/nav";

const primitives = [
  ["01", "TRACE", "Every decision leaves a readable path."],
  ["02", "SANDBOX", "Every attempt gets a place to run."],
  ["03", "HANDOFF", "Every agent inherits the context."],
  ["04", "RELEASE", "Every useful result becomes a change."],
] as const;

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
        <section className="relative overflow-hidden border-b border-(--l-border) px-6 pb-0 pt-28 sm:pt-36">
          <div className="mx-auto max-w-[1320px]">
            <div className="flex items-center justify-between border-y border-(--l-border) py-4 font-mono text-[10px] uppercase text-(--l-fg-3)">
              <span>Entry / control room for software work</span>
              <span className="hidden sm:inline">System ready · 2026</span>
            </div>
            <div className="grid gap-12 py-16 md:grid-cols-[1fr_280px] md:py-24">
              <div>
                <p className="mb-8 max-w-md font-mono text-[11px] uppercase leading-relaxed text-(--l-fg-2)">A repository-aware workspace for turning unfinished ideas into shipped software.</p>
                <h1 className="max-w-[900px] text-balance text-[clamp(4.25rem,11vw,10rem)] font-medium leading-[0.78] tracking-[-0.1em]">The work<br /><span className="text-(--l-accent)">has a pulse.</span></h1>
                <div ref={ctaRef} className="mt-14 flex flex-col gap-6 sm:flex-row sm:items-center"><SignInButton size="lg" /><span className="max-w-xs border-l border-(--l-border) pl-5 text-sm leading-relaxed text-(--l-fg-2)">Give an agent the repo, the runtime, and the room to make a real move.</span></div>
              </div>
              <aside className="self-end border-l border-(--l-border) pl-6 md:mb-3"><p className="font-mono text-[10px] uppercase text-(--l-fg-3)">Live system note</p><p className="mt-5 text-3xl leading-[0.9] tracking-[-0.06em]">Not a chat window. A place where changes happen.</p></aside>
            </div>
            <div className="grid border-t border-(--l-border) sm:grid-cols-4">
              {primitives.map(([number, title, copy]) => <div key={number} className="border-b border-(--l-border) py-6 sm:border-b-0 sm:border-r sm:px-5 sm:first:pl-0 sm:last:border-r-0"><span className="font-mono text-[10px] text-(--l-fg-3)">{number} / {title}</span><p className="mt-4 max-w-[170px] text-sm leading-snug">{copy}</p></div>)}
            </div>
          </div>
        </section>
        <section className="border-b border-(--l-border) px-6 py-20 sm:py-28"><div className="mx-auto grid max-w-[1320px] gap-8 md:grid-cols-[120px_1fr]"><div className="font-mono text-[10px] uppercase text-(--l-fg-3)">01<br />/ Observe</div><div><div className="mb-7 flex items-end justify-between"><div><p className="font-mono text-[10px] uppercase text-(--l-fg-3)">A working session, not a mockup</p><h2 className="mt-4 text-4xl font-medium tracking-[-0.07em] sm:text-6xl">See the system think.</h2></div><span className="hidden font-mono text-[10px] text-(--l-fg-3) sm:inline">TRACE 0001 — OPEN</span></div><div className="border border-(--l-border) bg-(--l-surface-2) p-2 sm:p-5"><AppMockup /></div></div></div></section>
        <LandingFeatures />
        <LandingBento />
        <LandingFooter />
      </main>
    </div>
  );
}
