import { SITE_URL } from "@/lib/site";

const content = `# Entry Agents (also known as Entry)

> Entry Agents is a cloud platform for autonomous AI agents that build software in private Workspaces, with or without a connected GitHub repository. Git delivery is optional.

## Full context


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
