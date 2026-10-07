import { SITE_URL } from "@/lib/site";

/**
 * Answer-engine block: real, visible question/answer content that
 * matches the FAQPage JSON-LD below, so AI answer engines (ChatGPT,
 * Perplexity, AI Overviews) can quote both from the rendered page and
 * the structured data without any mismatch.
 *
 * Questions are written the way people actually ask ("What is...",
 * "Do I need..."), not as marketing fragments.
 */
const faqs: readonly { question: string; answer: string }[] = [
  {
    question: "What is Entry Agents?",
    answer:
      "Entry Agents is a cloud platform for AI coding agents. You give an agent a task and a Git repository, it works autonomously in an isolated cloud sandbox with filesystem, network and runtime access, then commits and pushes the result. No local setup is required.",
  },
  {
    question: "How does an Entry Agents session work?",
    answer:
      "Each session provisions an isolated cloud sandbox with its own branch of your repository. The agent explores the codebase, edits files, runs tests and shell commands, then commits and opens a pull request. Sessions hibernate on inactivity and can be restored with their filesystem state intact.",
  },
  {
    question: "Which AI models does Entry Agents support?",
    answer:
      "Entry Agents routes through an AI model gateway that supports many providers and models, from Claude and GPT to DeepSeek and Qwen, with per-token pay-as-you-go pricing. You can pick a default model and switch it per session.",
  },
  {
    question: "Do I need to install anything to use Entry Agents?",
    answer:
      "No. Entry Agents runs entirely in the cloud: the agent, the sandbox and the Git integration all live on the platform. Sign in with Vercel, Google or GitHub, point the agent at a repository, and start a session from the browser.",
  },
  {
    question: "How does Entry Agents keep my code safe?",
    answer:
      "Every session runs in an isolated sandbox that no other session can reach, and your accounts connect through standard OAuth with encryption. Agents only see the repository you give them, and sandbox filesystems are discarded when they expire.",
  },
  {
    question: "What does Entry Agents cost?",
    answer:
      "Usage is credit-based with no markup: $1 of credit is $1 of model and sandbox usage, and subscriptions include bonus credits. You pay per token and per minute of sandbox time, so costs scale with what you actually run.",
  },
];

const faqStructuredData = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((f) => ({
    "@type": "Question",
    name: f.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: f.answer,
    },
  })),
};

export function LandingFaq() {
  return (
    <section aria-label="Frequently asked questions">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqStructuredData) }}
      />
      <div className="mx-auto max-w-[1320px] md:border-t md:border-(--l-border)">
        <div className="grid gap-10 px-6 py-16 sm:px-10 md:py-24 lg:grid-cols-[minmax(240px,340px)_1fr]">
          <div>
            <div className="font-mono text-xs uppercase tracking-widest text-(--l-fg-3)">
              FAQ
            </div>
            <h2 className="mt-3 text-balance text-2xl font-semibold tracking-tighter sm:text-3xl md:text-4xl">
              Questions,
              <br />
              answered.
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-(--l-fg-2)">
              What Entry Agents is, how sessions run, and what it costs.
              More on the{" "}
              <a
                href={`${SITE_URL}/pricing`}
                className="underline underline-offset-4 hover:text-(--l-fg)"
              >
                pricing
              </a>{" "}
              and{" "}
              <a
                href={`${SITE_URL}/model`}
                className="underline underline-offset-4 hover:text-(--l-fg)"
              >
                model
              </a>{" "}
              pages.
            </p>
          </div>

          <div className="border-t border-(--l-border-subtle)">
            {faqs.map((f) => (
              <details
                key={f.question}
                className="group border-b border-(--l-border-subtle)"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 text-sm font-medium text-(--l-fg) marker:hidden [&::-webkit-details-marker]:hidden">
                  {f.question}
                  <span
                    aria-hidden="true"
                    className="text-(--l-fg-3) transition-transform group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className="pb-5 pr-8 text-sm leading-relaxed text-(--l-fg-2)">
                  {f.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
