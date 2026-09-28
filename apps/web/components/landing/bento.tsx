import { SignInButton } from "@/components/auth/sign-in-button";

type BentoItem = { readonly id: string; readonly title: string; readonly body: string; readonly tag: string };
const items: readonly BentoItem[] = [
  { id: "01", title: "AI SDK", tag: "model layer", body: "One clean interface for streaming, tools, and switching models without rewriting the agent." },
  { id: "02", title: "Entry Gateway", tag: "routing layer", body: "Provider routing, fallbacks, rate limits, and observability in one deliberate control plane." },
  { id: "03", title: "Sandbox", tag: "runtime layer", body: "A private, disposable machine for every session with the filesystem and network access work needs." },
  { id: "04", title: "Lightflow SDK", tag: "durability layer", body: "Long-running workflows that checkpoint, retry, and reconnect instead of disappearing mid-task." },
];

export function LandingBento() {
  return <section id="stack" className="mx-auto max-w-[1320px] px-6 sm:px-0"><div className="border-b border-(--l-border) px-0 py-5 sm:px-10"><div className="flex justify-between text-[10px] font-semibold uppercase text-(--l-fg-3)"><span>03 / The system</span><span className="hidden sm:inline">One loop, no loose ends.</span></div></div><div className="grid border-b border-(--l-border) lg:grid-cols-[.9fr_1.1fr]"><div className="border-b border-(--l-border) px-0 py-16 sm:px-10 sm:py-24 lg:border-b-0 lg:border-r"><p className="font-mono text-[10px] uppercase text-(--l-accent)">The compounding advantage</p><h2 className="mt-6 max-w-xl text-balance text-5xl font-medium leading-[.85] tracking-[-.08em] sm:text-7xl">The system is<br /><span className="text-(--l-accent)">the product.</span></h2><p className="mt-8 max-w-md text-pretty text-lg leading-relaxed text-(--l-fg-2)">The parts share context, so your team can spend its energy on the decision — not the handoff.</p><div className="mt-10"><SignInButton /></div></div><div className="grid sm:grid-cols-2">{items.map((item) => <article key={item.id} className="group border-b border-(--l-border) p-6 transition-colors duration-150 hover:bg-(--l-accent) hover:text-white sm:p-10 sm:nth-[2n+1]:border-r lg:nth-[3],lg:nth-[4]:border-b-0"><div className="flex items-center justify-between font-mono text-[10px] text-(--l-accent) group-hover:text-white"><span>{item.id}</span><span>{item.tag}</span></div><h3 className="mt-16 text-2xl font-medium tracking-[-.05em]">{item.title}</h3><p className="mt-4 max-w-xs text-sm leading-relaxed text-(--l-fg-2) group-hover:text-white/80">{item.body}</p></article>)}</div></div></section>;
}
