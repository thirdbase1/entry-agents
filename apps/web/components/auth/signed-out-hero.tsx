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
  const heroButtonsRef = useRef<HTMLDivElement>(null);
  const [heroButtonsVisible, setHeroButtonsVisible] = useState(true);

  useEffect(() => {
    const el = heroButtonsRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setHeroButtonsVisible(entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="landing relative isolate min-h-screen bg-(--l-bg) text-(--l-fg) selection:bg-(--l-fg)/20">
      <div className="pointer-events-none absolute inset-y-0 left-0 right-0 hidden md:block">
        <div className="mx-auto h-full max-w-[1320px] border-x border-x-(--l-border)" />
      </div>

      <div className="relative z-10">
        <LandingNav showSignIn={!heroButtonsVisible} />

        <section className="relative overflow-hidden pb-0 pt-24 md:pt-36">
          <div className="mx-auto max-w-[1320px] px-6">
            <div className="landing-hero-grid grid gap-12 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-20">
              <div className="max-w-[900px]">
                <div className="mb-7 flex items-center gap-3 text-[11px] font-medium uppercase text-(--l-fg-3)">
                  <span className="size-2 rounded-full bg-(--l-accent)" aria-hidden="true" />
                  <span>Autonomous engineering / 01</span>
                </div>
                <h1 className="max-w-[900px] text-balance text-[clamp(3.5rem,9vw,9.25rem)] font-medium leading-[0.86] tracking-[-0.075em]">
                  Ship the <span className="text-(--l-accent)">work.</span>
                </h1>
                <p className="mt-8 max-w-[600px] text-pretty text-base leading-relaxed text-(--l-fg-2) sm:text-xl">
                  Give an AI coding agent a task and a repository. It works autonomously in an isolated cloud sandbox, then commits and pushes the result.
                </p>
                <div ref={heroButtonsRef} className="mt-8 flex items-center gap-3 sm:mt-10">
                  <SignInButton size="lg" callbackUrl="/sessions" />
                  <span className="hidden text-xs text-(--l-fg-3) sm:inline">No local setup required</span>
                </div>
              </div>

              <div className="hidden border-l border-(--l-border) pl-6 pt-1 lg:block">
                <p className="text-xs uppercase text-(--l-fg-3)">The brief</p>
                <p className="mt-6 text-lg leading-snug text-(--l-fg-2)">From first prompt to pushed commit, Entry handles the handoff.</p>
                <div className="mt-12 border-t border-(--l-border) pt-4 text-xs text-(--l-fg-3)">
                  <span className="tabular-nums">01—03</span>
                  <span className="ml-3">prompt / build / deliver</span>
                </div>
              </div>
            </div>
          </div>

          <div className="mx-auto mt-16 max-w-[1320px] px-4 sm:px-6 md:mt-24 md:px-0">
            <Stage tone="slate">
              <div className="mx-auto w-full max-w-[1160px]"><AppMockup /></div>
            </Stage>
          </div>
        </section>

        <LandingFeatures />
        <LandingBento />
        <LandingFooter />
      </div>
    </div>
  );
}
