import { SITE_URL } from "@/lib/site";

const content = `# Entry Agents

> Entry Agents is a cloud platform for AI coding agents that work on repository tasks in isolated sandboxes and ship code through Git.

## Public pages

- [Entry Agents](${SITE_URL}/): Product overview and sign-in.
- [AI coding agent](${SITE_URL}/ai-coding-agent): How the Entry Agents platform works on repository tasks.
- [Pricing](${SITE_URL}/pricing): Credit-based plans for Entry Agents.
- [Models](${SITE_URL}/model): Supported model prices and context windows.
- [Benchmarks](${SITE_URL}/benchmarks): HumanEval results from Entry Agents' own harness.
- [Deploy your own](${SITE_URL}/deploy-your-own): Deploy a copy of the Entry Agents platform to Vercel.

## Product capabilities

- AI coding agents for software tasks in Git repositories.
- Isolated cloud sandboxes with filesystem, network, and runtime access.
- Git branches, commits, and pull requests.
- Durable, resumable agent workflows.

Canonical site: ${SITE_URL}
`;

export function GET() {
  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
