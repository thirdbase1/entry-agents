"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FeatureAgent } from "./feature-agent";
import { FeatureSandbox } from "./feature-sandbox";
import { FeatureWorkflow } from "./feature-workflow";
import { Stage, type StageTone } from "./stage";
import { Window } from "./window";

function Spotlight({ tone, title, description, bullets, flip, window: content }: { readonly tone: StageTone; readonly title: string; readonly description: string; readonly bullets: readonly string[]; readonly flip?: boolean; readonly window: ReactNode }) {
  return <article className="grid border-b border-(--l-border) md:grid-cols-2">
    <div className={cn("flex flex-col justify-center px-6 py-16 sm:px-10 md:py-24", flip ? "md:order-2" : "md:order-1")}>
      <span className="font-mono text-xs text-(--l-accent)">0{flip ? 2 : 1} / CAPABILITY</span>
      <h2 className="mt-6 max-w-md text-balance text-3xl font-medium leading-[.95] tracking-[-.06em] sm:text-5xl">{title}</h2>
      <p className="mt-6 max-w-lg text-pretty text-base leading-relaxed text-(--l-fg-2) sm:text-lg">{description}</p>
      <ul className="mt-8 grid gap-3 text-sm text-(--l-fg-2)">{bullets.map((bullet) => <li key={bullet} className="flex gap-3"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-(--l-accent)" />{bullet}</li>)}</ul>
    </div>
    <div className={cn("flex items-center bg-(--l-surface-2) p-4 sm:p-10", flip ? "md:order-1" : "md:order-2")}><Stage tone={tone}><div className="mx-auto w-full max-w-[1160px]"><Window>{content}</Window></div></Stage></div>
  </article>;
}

export function LandingFeatures() {
  return <section id="how-it-works" className="mx-auto max-w-[1320px] px-6 sm:px-0"><div className="border-y border-(--l-border) px-0 py-5 sm:px-10"><div className="flex justify-between text-[11px] font-medium uppercase text-(--l-fg-3)"><span>02 / How it works</span><span className="hidden sm:inline">From brief to shipped</span></div></div><Spotlight tone="slate" title="A real place for the work." description="Every agent gets a repository, a runtime, and the room to make decisions. Entry replaces the fragile handoff between an idea and the first useful commit." bullets={["Full filesystem, network, and runtime access", "Explorer and executor agents working together", "Entry Gateway for reliable model routing"]} window={<FeatureAgent />} /><Spotlight tone="ash" title="Every session starts clean." description="A private cloud sandbox keeps experiments fast and consequences small. When the work is ready, the branch is already waiting for review." bullets={["Ephemeral environments with git integration", "Automatic snapshots and instant restore", "No local setup or dependency drift"]} flip window={<FeatureSandbox />} /><Spotlight tone="iron" title="The work keeps moving." description="Lightflow SDK makes long-running agent loops durable and visible, so a network blip or a closed laptop never becomes a lost afternoon." bullets={["Checkpointed workflows with retry semantics", "Usage tracking and diff caching", "Reconnect from any client"]} window={<FeatureWorkflow />} /></section>;
}
