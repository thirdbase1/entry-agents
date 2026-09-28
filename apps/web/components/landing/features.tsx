"use client";

import { cn } from "@/lib/utils";
import { FeatureAgent } from "./feature-agent";
import { FeatureSandbox } from "./feature-sandbox";
import { FeatureWorkflow } from "./feature-workflow";
import { Window } from "./window";

const features = [
  { number: "02", label: "Context", title: "The brief becomes a room.", body: "Entry does not ask an agent to guess. It gives the work a filesystem, a history, and enough room to make a considered move.", bullets: ["Repository-aware exploration", "One shared working memory", "A clear trail from ask to answer"], content: <FeatureAgent /> },
  { number: "03", label: "Momentum", title: "The attempt becomes evidence.", body: "Every experiment leaves something useful behind: a branch, a snapshot, a diff, or a better question for the next pass.", bullets: ["Disposable environments", "Instant restore points", "Reviewable work, not black boxes"], content: <FeatureSandbox />, reverse: true },
  { number: "04", label: "Continuity", title: "The work survives the day.", body: "Long-running work keeps its place when a laptop closes or a network drops. Pick it up where the thought was strongest.", bullets: ["Checkpointed execution", "Durable retries", "Reconnect from any client"], content: <FeatureWorkflow /> },
];

function Feature({ feature }: { readonly feature: (typeof features)[number] }) {
  return <article className="grid border-b border-(--l-border) md:grid-cols-[80px_1fr_1fr]"><div className="hidden border-r border-(--l-border) p-8 font-mono text-[10px] text-(--l-fg-3) md:block">{feature.number}</div><div className={cn("flex flex-col justify-center px-6 py-16 sm:px-10 md:py-28", feature.reverse && "md:order-3 md:border-l")}><p className="font-mono text-[10px] uppercase text-(--l-fg-3)">{feature.label} / capability</p><h2 className="mt-8 max-w-md text-balance text-4xl font-medium leading-[.88] tracking-[-.07em] sm:text-6xl">{feature.title}</h2><p className="mt-7 max-w-md text-pretty leading-relaxed text-(--l-fg-2)">{feature.body}</p><ul className="mt-10 grid gap-3 text-sm">{feature.bullets.map((bullet) => <li key={bullet} className="border-t border-(--l-border) py-3 text-(--l-fg-2)"><span className="mr-3 font-mono text-[10px] text-(--l-fg-3)">—</span>{bullet}</li>)}</ul></div><div className={cn("flex items-center border-t border-(--l-border) p-4 sm:p-10 md:border-t-0", feature.reverse ? "md:order-2" : "md:order-3")}><div className="w-full border border-(--l-border) p-2"><Window><div className="p-1">{feature.content}</div></Window></div></div></article>;
}

export function LandingFeatures() {
  return <section id="how-it-works" className="mx-auto max-w-[1320px] px-6 sm:px-0"><div className="grid border-b border-(--l-border) py-5 md:grid-cols-[80px_1fr]"><div className="hidden border-r border-(--l-border) font-mono text-[10px] text-(--l-fg-3) md:block">02</div><div className="px-0 text-[10px] uppercase text-(--l-fg-2) md:px-8">The method / three changes to the way work moves</div></div>{features.map((feature) => <Feature key={feature.number} feature={feature} />)}</section>;
}
