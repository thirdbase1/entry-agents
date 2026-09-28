"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FeatureAgent } from "./feature-agent";
import { FeatureSandbox } from "./feature-sandbox";
import { FeatureWorkflow } from "./feature-workflow";
import { Stage, type StageTone } from "./stage";
import { Window } from "./window";

function Spotlight({ tone, title, description, bullets, flip, window: content, index }: { readonly tone: StageTone; readonly title: string; readonly description: string; readonly bullets: readonly string[]; readonly flip?: boolean; readonly window: ReactNode; readonly index: string }) {
  return <article className="grid border-b border-(--l-border) md:grid-cols-2"><div className={cn("flex flex-col justify-center px-6 py-16 sm:px-10 md:py-28", flip ? "md:order-2" : "md:order-1")}><div className="flex items-center gap-3 font-mono text-[10px] uppercase text-(--l-accent)"><span className="size-2 rounded-full bg-(--l-accent)" />{index} / Capability</div><h2 className="mt-6 max-w-md text-balance text-4xl font-medium leading-[.9] tracking-[-.07em] sm:text-6xl">{title}</h2><p className="mt-6 max-w-lg text-pretty text-base leading-relaxed text-(--l-fg-2) sm:text-lg">{description}</p><ul className="mt-10 grid gap-3 text-sm text-(--l-fg-2)">{bullets.map((bullet) => <li key={bullet} className="flex items-center gap-3 border-t border-(--l-border-subtle) pt-3"><span className="font-mono text-[10px] text-(--l-accent)">→</span>{bullet}</li>)}</ul></div><div className={cn("flex items-center border-t border-(--l-border) bg-(--l-surface-2) p-4 sm:p-10 md:border-t-0", flip ? "md:order-1 md:border-r" : "md:order-2")}><Stage tone={tone}><div className="mx-auto w-full max-w-[1160px]"><Window>{content}</Window></div></Stage></div></article>;
}

export function LandingFeatures() {
  return <section id="how-it-works" className="mx-auto max-w-[1320px] px-6 sm:px-0"><div className="border-b border-(--l-border) px-0 py-5 sm:px-10"><div className="flex justify-between text-[10px] font-semibold uppercase text-(--l-fg-3)"><span>02 / The method</span><span className="hidden sm:inline">Less handoff. More follow-through.</span></div></div><Spotlight index="01" tone="slate" title="Give the work context." description="Agents become useful when they can see the whole shape of the problem. Entry gives them a real repository, runtime, and history — not a toy prompt box." bullets={["Filesystem, network, and runtime access", "Explorer and executor agents in one loop", "Entry Gateway for reliable model routing"]} window={<FeatureAgent />} /><Spotlight index="02" tone="ash" title="Make every attempt count." description="A private sandbox makes exploration cheap. When an idea earns its place, the branch, diff, and reasoning are already ready for review." bullets={["Ephemeral environments with git integration", "Automatic snapshots and instant restore", "No local setup or dependency drift"]} flip window={<FeatureSandbox />} /><Spotlight index="03" tone="iron" title="Keep momentum alive." description="Lightflow SDK keeps long-running work durable and visible, so a closed laptop or network blip never becomes a lost afternoon." bullets={["Checkpointed workflows with retry semantics", "Usage tracking and diff caching", "Reconnect from any client"]} window={<FeatureWorkflow />} /></section>;
}
