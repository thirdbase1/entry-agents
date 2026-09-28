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
    <div className="landing relative isolate min-h-screen overflow-hidden bg-(--l-bg) text-(--l-fg) selection:bg-(--l-accent)/20">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,transparent_0,transparent_calc(50%-1px),var(--l-border-subtle)_50%,transparent_calc(50%+1px),transparent_100%)] opacity-60" />
      <div className="relative z-10">
        <LandingNav showSignIn={showNavCta} />
        <main>
          <section className="relative px-6 pb-20 pt-24 sm:pt-32 md:pb-28 md:pt-44">
            <div className="mx-auto max-w-[1320px]">
              <div className="grid gap-14 lg:grid-cols-[1.3fr_.7fr] lg:gap-24">
                <div>
                  <div className="mb-8 flex items-center gap-3 text-[11px] font-medium uppercase text-(--l-fg-3)"><span className="size-2 rounded-full bg-(--l-accent)" /> Open harness for serious shipping</div>
                  <h1 className="max-w-[940px] text-balance text-[clamp(4.25rem,11vw,10.5rem)] font-medium leading-[.8] tracking-[-.09em]">Build less.<br /><span className="text-(--l-accent)">Ship more.</span></h1>
                  <p className="mt-10 max-w-[560px] text-pretty text-lg leading-relaxed text-(--l-fg-2) sm:text-xl">Entry turns a plain-English brief into a working branch. Agents explore, build, test, and deliver from an isolated cloud workspace.</p>
                  <div ref={ctaRef} className="mt-9 flex flex-wrap items-center gap-4"><SignInButton size="lg" callbackUrl="/sessions" /><span className="text-xs uppercase text-(--l-fg-3)">01 / prompt to pull request</span></div>
                </div>
                <div className="self-end border-l border-(--l-border) pl-6 lg:mb-2">
                  <p className="font-mono text-xs text-(--l-accent)">ENTRY / 2026</p>
                  <p className="mt-6 max-w-xs text-2xl leading-tight">A calmer way to put autonomous engineering into production.</p>
                  <div className="mt-12 grid grid-cols-2 gap-4 border-t border-(--l-border) pt-4 text-xs text-(--l-fg-3)"><span>AGENT<br /><b className="font-normal text-(--l-fg)">autonomous</b></span><span>RUNTIME<br /><b className="font-normal text-(--l-fg)">isolated</b></span></div>
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
