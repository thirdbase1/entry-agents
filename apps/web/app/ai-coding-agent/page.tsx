import type { Metadata } from "next";
import Link from "next/link";
import { LandingFooter } from "@/components/landing/footer";
import { LandingNav } from "@/components/landing/nav";
import { SITE_URL } from "@/lib/site";

const title = "AI Coding Agent for Building Software";
const description =
  "Entry Agents is an affordable autonomous AI coding agent for building apps, scripts, websites, and software projects in a private Workspace, with or without a GitHub repository.";

export const metadata: Metadata = {
  title,
  description,
  alternates: {
    canonical: "/ai-coding-agent",
  },
  openGraph: {
    url: "/ai-coding-agent",
    title: "Entry Agents — AI coding agent for building software",
    description,
  },
  twitter: {
    title: "Entry Agents — AI coding agent for building software",
    description,
  },
};

const structuredData = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: "Entry Agents — AI coding agent for building software",
  description,
  url: `${SITE_URL}/ai-coding-agent`,
  about: {
    "@type": "SoftwareApplication",
    name: "Entry Agents",
    applicationCategory: "DeveloperApplication",
  },
};

export default function AiCodingAgentPage() {
  return (
    <div className="landing min-h-screen bg-(--l-bg) text-(--l-fg)">
      <LandingNav showSignIn />
      <main className="mx-auto max-w-[960px] px-6 pb-24 pt-32 md:pt-44">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
          }}
        />
        <p className="font-mono text-xs uppercase tracking-widest text-(--l-fg-3)">
          Entry Agents
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tighter sm:text-5xl md:text-6xl">
          An AI coding agent for building software.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-(--l-fg-2)">
          Entry Agents works on software tasks inside a private cloud Workspace.
          Give it a plain-language idea, files, or a repository. It can
          research, write code, use the shell, build apps, run tests, and
          optionally deliver the result through Git, without requiring a local
          development environment.
        </p>

        <section className="mt-20 grid gap-10 border-t border-(--l-border) pt-12 md:grid-cols-3">
          <article>
            <h2 className="text-xl font-semibold tracking-tight">
              Work in an isolated sandbox
            </h2>
            <p className="mt-3 leading-relaxed text-(--l-fg-2)">
              Each session has filesystem, outbound network, and runtime access in its
              own private Workspace. The agent can start from nothing, inspect
              files, research the web, and run the tools needed to complete a task.
            </p>
          </article>
          <article>
            <h2 className="text-xl font-semibold tracking-tight">
              Keep work in Git
            </h2>
            <p className="mt-3 leading-relaxed text-(--l-fg-2)">
              Sessions can use branches and commit or push completed work when a
              repository is connected. Git delivery is useful, but never
              required to build and download a result.
            </p>
          </article>
          <article>
            <h2 className="text-xl font-semibold tracking-tight">
              Run durable workflows
            </h2>
            <p className="mt-3 leading-relaxed text-(--l-fg-2)">
              Entry Agents coordinates multi-step work as durable workflows,
              allowing agent runs to recover from transient failures and resume
              their progress.
            </p>
          </article>
        </section>

        <section className="mt-20 border-t border-(--l-border) pt-12">
          <h2 className="text-2xl font-semibold tracking-tight">
            What can your agents help with?
          </h2>
          <ul className="mt-6 grid gap-3 text-(--l-fg-2) sm:grid-cols-2">
            <li>Understand an unfamiliar repository and its architecture.</li>
            <li>Implement a focused feature or bug fix.</li>
            <li>Run code and inspect failures in an isolated environment.</li>
            <li>Prepare commits and pull requests for review.</li>
          </ul>
        </section>

        <div className="mt-16 flex flex-wrap gap-4">
          <Link
            className="rounded-md bg-(--l-fg) px-4 py-2 text-sm font-medium text-(--l-bg)"
            href="/"
          >
            Start with Entry Agents
          </Link>
          <Link
            className="rounded-md border border-(--l-border) px-4 py-2 text-sm font-medium"
            href="/pricing"
          >
            View pricing
          </Link>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
