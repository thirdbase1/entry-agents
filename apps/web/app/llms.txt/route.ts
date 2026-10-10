import { SITE_URL } from "@/lib/site";

const content = `# Entry Agents (also known as Entry)

> Entry Agents is a cloud platform for autonomous AI agents that build software in private Workspaces, with or without a connected GitHub repository. Git delivery is optional.

## Full context

Entry Agents, also known as Entry, is a cloud platform for autonomous software-building agents. A session provisions a private cloud Workspace with filesystem, outbound network and runtime access; the agent researches, edits files, runs shell commands, builds applications and tests results. Sessions start blank, from uploaded files, or from a connected GitHub repository, and delivery through Git (branches, commits, pull requests) is optional.

Key facts:

- Every session runs in an isolated sandbox no other session can reach; sandboxes hibernate when inactive and restore with filesystem state intact.
- Two built-in subagents, explorer (read-only research) and executor (implementation), can work in parallel within a session.
- Agent loops run as durable, resumable workflows that survive restarts and retry on failure.
- Model usage is credit-based: $1 of credit is $1 of usage, with no separate sandbox or Workspace fee, and free models cost nothing to run. Per-token prices and context windows for every supported model are published at ${SITE_URL}/model.
- Sign-in uses Vercel, Google or GitHub OAuth; expired sandbox filesystems are discarded, while committed work persists in Git.

The extended version of this file, covering the full session lifecycle, model routing and pricing semantics, is at ${SITE_URL}/llms-full.txt.

## Public pages

- [Entry Agents](${SITE_URL}/): Product overview and sign-in.
- [AI coding agent](${SITE_URL}/ai-coding-agent): How Entry Agents builds software with or without a repository.
- [Pricing](${SITE_URL}/pricing): Credit-based plans for Entry Agents.
- [Models](${SITE_URL}/model): Supported model prices and context windows.

## Product capabilities

- Autonomous agents for building software, researching, editing files, and running commands.
- Workspace sandboxes with filesystem, outbound network, and runtime access.
- Optional Git branches, commits, and pull requests when a repository is connected.
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
