"use client";

import { useEffect, useRef, useState } from "react";
import { SignInButton } from "@/components/auth/sign-in-button";
import { AppMockup } from "@/components/landing/app-mockup";
import { LandingBento } from "@/components/landing/bento";
import { LandingFeatures } from "@/components/landing/features";
import { LandingFooter } from "@/components/landing/footer";
import { LandingNav } from "@/components/landing/nav";

export function SignedOutHero() {
  const ctaRef = useRef<HTMLDivElement>(null);
  const [showNavCta, setShowNavCta] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setShowNavCta(!entry.isIntersecting), { threshold: 0 });
    if (ctaRef.current) observer.observe(ctaRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="landing bg-(--l-bg) text-(--l-fg) selection:bg-(--l-fg) selection:text-(--l-bg)">
      <LandingNav showSignIn={showNavCta} />
      <main>
        <section className="border-b border-(--l-border) px-6 pb-0 pt-28 sm:pt-36">
          <div className="mx-auto max-w-[1320px]">
            <div className="grid border-y border-(--l-border) md:grid-cols-[80px_1fr_180px]">
              <div className="hidden border-r border-(--l-border) py-4 font-mono text-[10px] text-(--l-fg-3) md:block">00</div>
              <div className="px-0 py-4 font-mono text-[10px] uppercase text-(--l-fg-2) md:px-8">Entry / an operating system for unfinished ideas</div>
              <div className="border-t border-(--l-border) py-4 font-mono text-[10px] uppercase text-(--l-fg-3) md:border-l md:border-t-0 md:pl-5">Open for business</div>
            </div>
            <div className="grid gap-12 py-20 md:grid-cols-[80px_1fr_240px] md:py-28">
              <div className="hidden font-mono text-[10px] text-(--l-fg-3) md:block">THESIS<br />/ 2026</div>
              <div>
                <p className="mb-8 max-w-sm text-sm leading-relaxed text-(--l-fg-2)">The best products do not begin as tickets. They begin as a signal, then a decision, then a system.</p>
                <h1 className="max-w-[950px] text-balance text-[clamp(4rem,12vw,11rem)] font-medium leading-[0.78] tracking-[-0.1em]">Make<br /><span className="italic">the move.</span></h1>
                <div ref={ctaRef} className="mt-16 flex flex-col gap-6 sm:flex-row sm:items-center"><SignInButton size="lg" /><span className="max-w-[250px] border-l border-(--l-border) pl-5 text-sm leading-relaxed text-(--l-fg-2)">Turn a thought into a branch, a runtime, and a reason to ship.</span></div>
              </div>
              <div className="border-l border-(--l-border) pl-6 md:pt-20"><span className="font-mono text-[10px] text-(--l-fg-3)">A NOTE FROM THE MACHINE</span><p className="mt-5 text-2xl leading-[0.9]">You bring the direction. We keep the work moving.</p></div>
            </div>
            <div className="grid border-t border-(--l-border) sm:grid-cols-4"><div className="border-b border-(--l-border) py-5 sm:border-r sm:border-b-0 sm:pr-5"><span className="font-mono text-[10px] text-(--l-fg-3)">01 / SIGNAL</span><p className="mt-3 text-sm">A sharp brief.</p></div><div className="border-b border-(--l-border) py-5 sm:border-r sm:border-b-0 sm:px-5"><span className="font-mono text-[10px] text-(--l-fg-3)">02 / SYSTEM</span><p className="mt-3 text-sm">A living repo.</p></div><div className="border-b border-(--l-border) py-5 sm:border-r sm:border-b-0 sm:px-5"><span className="font-mono text-[10px] text-(--l-fg-3)">03 / PROOF</span><p className="mt-3 text-sm">A visible diff.</p></div><div className="py-5 sm:pl-5"><span className="font-mono text-[10px] text-(--l-fg-3)">04 / RELEASE</span><p className="mt-3 text-sm">A thing in the world.</p></div></div>
          </div>
        </section>
        <section className="border-b border-(--l-border) px-6 py-20 sm:py-28"><div className="mx-auto grid max-w-[1320px] gap-8 md:grid-cols-[80px_1fr]"><div className="font-mono text-[10px] uppercase text-(--l-fg-3)">01<br />/ Live room</div><div className="border border-(--l-border) p-2 sm:p-5"><div className="border border-(--l-border) p-2 sm:p-8"><AppMockup /></div></div></div></section>
        <LandingFeatures />
        <LandingBento />
        <LandingFooter />
      </main>
    </div>
  );
}
