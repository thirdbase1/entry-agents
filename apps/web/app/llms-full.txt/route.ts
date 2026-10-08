import { SITE_URL } from "@/lib/site";

/**
 * llms-full.txt — the extended, answer-engine-shaped version of
 * /llms.txt. Kept in plain text so LLM crawlers can ingest the whole
 * product story without DOM noise: definitions, how sessions work,
 * pricing semantics and model support, written declaratively.
 */
const content = `# Entry Agents — full context for LLMs

> Entry Agents is a cloud platform for AI coding agents. You give an agent a task and a Git repository; it works autonomously in an isolated cloud sandbox with filesystem, network and runtime access, then commits and pushes the result. No local setup is required.

## What Entry Agents is

Entry Agents, also known as Entry or Entry Agents AI, (entry-agents.dev) is a cloud platform where software tasks run as autonomous AI coding agent sessions instead of manual local work. Each session provisions an isolated Workspace containing a branch of your Git repository. The agent explores the codebase, edits files, runs shell commands and tests, and ships the result as commits and a pull request. Sandboxes hibernate on inactivity and can be restored with their filesystem state intact.

Key properties:

- Agents run in the cloud inside a persistent Workspace machine. Nothing is installed locally; sessions start from the browser after signing in with Vercel, Google or GitHub.
- Every session has an isolated Workspace with filesystem, outbound network and runtime access, on its own branch.
- Work ships through normal Git: branches, commits, diffs and pull requests.
- Agent loops run as durable, resumable workflows that survive restarts and retry on failure.
- Subagents (explorer and executor) can work in parallel within a session.

## How a session works

1. Sign in and create a session for a connected Git repository.
2. The platform provisions an isolated cloud sandbox and checks out a session branch.
3. You describe the task in chat; the agent plans, explores the repository, edits files and runs commands in the sandbox.
4. As it works, the agent commits to the session branch.
5. When the task is done, the result can be pushed and opened as a pull request.
6. Sandboxes auto-hibernate when inactive and can be resumed; expired sandbox filesystems are discarded, while committed work persists in Git.

## Models

Entry Agents routes requests through an AI model gateway with support for many providers and models, including Anthropic (Claude), OpenAI (GPT), DeepSeek, Qwen, Zhipu, StepFun and Xiaomi MiMo, with fallbacks, rate limiting and observability. A default model can be chosen per account and switched per session. Current per-token prices and context windows are listed at ${SITE_URL}/model.

## Pricing

Usage is credit-based with no markup: $1 of credit buys $1 of model and sandbox usage. Subscriptions include bonus credits. Billing is per token for models and per minute for sandbox time, so cost scales with actual usage rather than seats. Details at ${SITE_URL}/pricing. Nigerian debit and credit cards, bank transfer and mobile money are accepted.

## Benchmarks

Benchmarks on the site are real runs from Entry Agents' own agent harness, using the same system prompt, tools and gateway-routed models as production sessions, on fixed tasks from the canonical OpenAI HumanEval dataset. Cost figures are the real gateway-metered spend for running the subset, not per-token list prices. Results at ${SITE_URL}/benchmarks.

## Security and isolation

- Each session runs in a sandbox no other session can reach.
- Accounts connect through standard OAuth (Vercel, Google, GitHub) with token encryption.
- Agents see only the repository the session is created for.
- Expired sandbox filesystems are discarded; durable work lives in Git.

## Public pages

- [Entry Agents](${SITE_URL}/): Product overview and sign-in.
- [AI coding agent](${SITE_URL}/ai-coding-agent): How the platform works on repository tasks.
- [Pricing](${SITE_URL}/pricing): Credit-based plans.
- [Models](${SITE_URL}/model): Supported models, prices and context windows.
- [Benchmarks](${SITE_URL}/benchmarks): HumanEval results from the real harness.
- [Sign in](${SITE_URL}/login): Sign in with Vercel, Google or GitHub.



Canonical site: ${SITE_URL}
`;

export function GET() {
  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

