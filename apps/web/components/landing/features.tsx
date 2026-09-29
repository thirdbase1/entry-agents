"use client";

import { cn } from "@/lib/utils";
import { FeatureAgent } from "./feature-agent";
import { FeatureSandbox } from "./feature-sandbox";
import { FeatureWorkflow } from "./feature-workflow";
import { Window } from "./window";

const features = [
  { number: "02", label: "Context", title: "The repository is part of the conversation.", body: "Entry starts where useful work starts: inside the files, history, branches, and constraints that make a change real.", bullets: ["Repository-aware exploration", "Branch-safe working rooms", "Shared context across delegated work"], content: <FeatureAgent /> },
  { number: "03", label: "Execution", title: "Every attempt leaves a trace.", body: "A sandbox is not a black box. It is an instrumented place where decisions, commands, and changes become inspectable evidence.", bullets: ["Isolated environments", "Streamed command output", "Snapshots you can restore"], content: <FeatureSandbox />, reverse: true },
  { number: "04", label: "Continuity", title: "Work that keeps its place.", body: "Long-running software work should not disappear when a tab closes. Resume the same thread with its state intact.", bullets: ["Durable execution", "Retries without lost context", "A handoff that is actually a handoff"], content: <FeatureWorkflow /> },
];

export function LandingFeatures() {
  return <section id="how-it-works" className="mx-auto max-w-[1320px] px-6"><div className="flex items-end justify-between border-b-2 border-(--l-fg) py-6"><div><p className="font-mono text-[9px] uppercase text-(--l-fg-3)">02 — 04 / The operating model</p><h2 className="mt-5 text-5xl font-medium leading-[.84] tracking-[-.1em] sm:text-8xl">From signal<br />to software.</h2></div><p className="hidden max-w-[180px] text-right text-sm leading-relaxed text-(--l-fg-2) sm:block">Three mechanisms turn an ambiguous request into a change you can stand behind.</p></div>{features.map((feature) => <article key={feature.number} className="grid border-b border-(--l-border) md:grid-cols-[100px_1fr_1fr]"><div className="hidden border-r border-(--l-border) pt-10 font-mono text-[10px] text-(--l-fg-3) md:block">{feature.number}</div><div className={cn("flex flex-col justify-center px-0 py-16 sm:px-10 md:py-28", feature.reverse && "md:order-3 md:border-l")}><p className="font-mono text-[9px] uppercase text-(--l-fg-3)">{feature.label} / mechanism</p><h3 className="mt-8 max-w-md text-balance text-4xl font-medium leading-[.88] tracking-[-.08em] sm:text-6xl">{feature.title}</h3><p className="mt-7 max-w-md text-pretty leading-relaxed text-(--l-fg-2)">{feature.body}</p><ul className="mt-10 grid gap-0 text-sm">{feature.bullets.map((bullet) => <li key={bullet} className="border-t border-(--l-border) py-3 text-(--l-fg-2)"><span className="mr-3 font-mono text-[10px] text-(--l-fg-3)">0{feature.bullets.indexOf(bullet) + 1}</span>{bullet}</li>)}</ul></div><div className={cn("flex items-center border-t border-(--l-border) p-4 sm:p-10 md:border-t-0", feature.reverse ? "md:order-2" : "md:order-3")}><div className="w-full border border-(--l-fg) p-2"><Window><div className="p-1">{feature.content}</div></Window></div></div></article>)}</section>;
}
