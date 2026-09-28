import { SignInButton } from "@/components/auth/sign-in-button";

const layers = [
  ["01", "AI SDK", "language"],
  ["02", "Entry Gateway", "routing"],
  ["03", "Sandbox", "execution"],
  ["04", "Lightflow SDK", "continuity"],
] as const;

export function LandingBento() {
  return <section id="stack" className="mx-auto max-w-[1320px] px-6 sm:px-0"><div className="grid border-b border-(--l-border) py-5 md:grid-cols-[80px_1fr]"><div className="hidden border-r border-(--l-border) font-mono text-[10px] text-(--l-fg-3) md:block">06</div><div className="px-0 text-[10px] uppercase text-(--l-fg-2) md:px-8">The system / four layers, one direction</div></div><div className="grid border-b border-(--l-border) lg:grid-cols-[.8fr_1.2fr]"><div className="flex flex-col justify-between border-b border-(--l-border) px-0 py-16 sm:px-10 sm:py-24 lg:border-b-0 lg:border-r"><div><p className="font-mono text-[10px] uppercase text-(--l-fg-3)">The compounding advantage</p><h2 className="mt-8 max-w-lg text-balance text-5xl font-medium leading-[.82] tracking-[-.08em] sm:text-7xl">Nothing<br />gets lost.</h2><p className="mt-8 max-w-sm text-lg leading-relaxed text-(--l-fg-2)">Each layer hands its context to the next. The result is not a collection of tools. It is a line you can follow.</p></div><div className="mt-12"><SignInButton /></div></div><div className="grid sm:grid-cols-2">{layers.map(([number, title, label], index) => <article key={number} className="relative min-h-64 border-b border-(--l-border) p-6 sm:p-10 sm:nth-[odd]:border-r lg:min-h-72"><span className="font-mono text-[10px] text-(--l-fg-3)">{number}</span><h3 className="mt-20 text-3xl font-medium tracking-[-.06em]">{title}</h3><p className="mt-3 font-mono text-[10px] uppercase text-(--l-fg-3)">{label}</p><span className="absolute bottom-8 right-8 font-mono text-[10px] text-(--l-fg-3)">{index === layers.length - 1 ? "→" : "↓"}</span></article>)}</div></div></section>;
}
