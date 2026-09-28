import { ArrowUpRight, GitBranch, Terminal, Waypoints } from "lucide-react";

const proof = [
  { icon: Terminal, index: "A", title: "The command is visible", copy: "Stream output as the agent works. Know what happened before you read the summary." },
  { icon: GitBranch, index: "B", title: "The branch is yours", copy: "Move from a clean branch, preserve the source, and decide what earns a merge." },
  { icon: Waypoints, index: "C", title: "The handoff has shape", copy: "Delegated agents return findings, not fog. Every contribution has a place in the trace." },
];

export function LandingBento() {
  return <section className="border-b border-(--l-border) px-6 py-24 sm:py-36"><div className="mx-auto max-w-[1320px]"><div className="flex flex-col justify-between gap-8 border-b-2 border-(--l-fg) pb-8 sm:flex-row sm:items-end"><div><p className="font-mono text-[9px] uppercase text-(--l-fg-3)">05 / The proof layer</p><h2 className="mt-5 max-w-3xl text-balance text-5xl font-medium leading-[.84] tracking-[-.1em] sm:text-8xl">Good work<br />can explain itself.</h2></div><p className="max-w-xs text-sm leading-relaxed text-(--l-fg-2)">A useful system does not hide the messy middle. It gives the middle structure.</p></div><div className="grid border-l border-(--l-border) sm:grid-cols-3">{proof.map(({ icon: Icon, index, title, copy }) => <article key={index} className="group border-b border-r border-(--l-border) p-7 sm:min-h-[300px] sm:p-10"><div className="flex items-center justify-between"><span className="font-mono text-[10px] text-(--l-fg-3)">{index}</span><Icon className="size-5 stroke-[1.2] text-(--l-fg-3)" /></div><h3 className="mt-28 max-w-[220px] text-3xl font-medium leading-[.9] tracking-[-.07em]">{title}</h3><p className="mt-5 max-w-[250px] text-sm leading-relaxed text-(--l-fg-2)">{copy}</p><ArrowUpRight className="mt-10 size-4 text-(--l-fg-3) transition-transform duration-150 ease-out group-hover:translate-x-1 group-hover:-translate-y-1" /></article>)}</div></div></section>;
}
