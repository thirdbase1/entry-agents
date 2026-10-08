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
      "Entry Agents is a cloud platform for autonomous AI agents that can build software, investigate problems, create files, run commands, research the web, and work with or without a connected GitHub repository. Every session runs in a private Workspace with filesystem, outbound network and runtime access.",
  },
  {
    question: "How does an Entry Agents session work?",
    answer:
      "Each session provisions a private Workspace. Start from a blank workspace, attach a GitHub repository, or ask the agent to create something from scratch. The agent can explore files, run commands, build software, test it, and optionally commit or push the result through Git.",
  },
  {
    question: "Which AI models does Entry Agents support?",
    answer:
      "Entry Agents routes through Entry Gateway that supports many providers and models, from Claude and GPT to DeepSeek and Qwen, with per-token pay-as-you-go pricing. You can pick a default model and switch it per session.",
  },
  {
    question: "Do I need to install anything to use Entry Agents?",
    answer:
      "No. Entry Agents runs entirely in the cloud. Sign in with Vercel, Google or GitHub and start from a blank Workspace, a connected repository, an uploaded file, or a plain-language idea.",
  },
  {
    question: "How does Entry Agents keep my code safe?",
    answer:
      "Every session runs in a private Workspace that no other session can reach. Accounts connect through standard OAuth with encryption. If you connect a repository, the agent only receives the repository and access you authorize; blank Workspace work remains separate.",
  },
  {
    question: "What does Entry Agents cost?",
    answer:
      "Usage is credit-based for model usage. Entry Agents does not charge a separate sandbox or Workspace fee. Subscriptions include bonus credits, and your balance is used for the model tokens consumed by your agent.",
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
