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
      <div className="relative z-10">
        <LandingNav showSignIn={showNavCta} />
        <main>
          <section className="relative overflow-hidden px-6 pb-20 pt-16 sm:pb-28 sm:pt-24 lg:pb-36 lg:pt-32">
            <div className="pointer-events-none absolute right-[-10%] top-[-16%] size-[620px] rounded-full border border-(--l-accent)/20" />
            <div className="pointer-events-none absolute right-[4%] top-[-2%] size-[380px] rounded-full border border-(--l-accent)/10" />
            <div className="mx-auto max-w-[1320px]">
              <div className="mb-12 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.16em] text-(--l-fg-3)">
                <span>Entry / Agent infrastructure</span><span className="hidden sm:inline">Built for the next category</span>
              </div>
              <div className="grid gap-14 lg:grid-cols-[1.1fr_.9fr] lg:items-end lg:gap-20">
                <div>
                  <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-(--l-border) px-3 py-1.5 font-mono text-[10px] uppercase text-(--l-accent)"><span className="size-1.5 rounded-full bg-(--l-accent)" /> The control plane for agentic work</p>
                  <h1 className="max-w-[900px] text-balance text-[clamp(3.8rem,9vw,8.5rem)] font-medium leading-[.86] tracking-[-.09em]">Software that<br /><span className="text-(--l-accent)">moves itself forward.</span></h1>
                  <div ref={ctaRef} className="mt-10 flex flex-wrap items-center gap-5"><SignInButton size="lg" /><span className="max-w-[220px] text-sm leading-relaxed text-(--l-fg-2)">Give a capable team the context, tools, and runtime to ship.</span></div>
                </div>
                <div className="max-w-md border-l-2 border-(--l-accent) pl-6 lg:mb-2">
                  <p className="text-xl leading-snug text-(--l-fg)">The shortest path from a sharp idea to a production-grade pull request.</p>
                  <div className="mt-8 grid grid-cols-3 gap-3 border-t border-(--l-border) pt-4 text-[10px] uppercase text-(--l-fg-3)"><div><strong className="block font-mono text-lg text-(--l-fg)">01</strong> brief</div><div><strong className="block font-mono text-lg text-(--l-fg)">02</strong> build</div><div><strong className="block font-mono text-lg text-(--l-fg)">03</strong> ship</div></div>
                </div>
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
