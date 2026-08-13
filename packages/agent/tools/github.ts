import { tool } from "ai";
import { z } from "zod";
import { isAgentContext } from "./utils";
import type { GithubCommitToolResult } from "../types";

const githubCommitInputSchema = z.object({
  commitTitle: z
    .string()
    .max(72)
    .optional()
    .describe(
      "Short, conventional-commit style title (e.g. 'fix: handle nested repos'). If omitted, one is auto-generated from the staged diff.",
    ),
  commitBody: z
    .string()
    .optional()
    .describe("Optional longer commit body/description."),
});

export type GithubCommitToolInput = z.infer<typeof githubCommitInputSchema>;

/**
 * Lets the agent commit and push the current sandbox changes to the
 * connected GitHub repository on its own initiative (e.g. when the user
 * asks it to save/commit/push work), instead of waiting for the
 * end-of-turn auto-commit or the user clicking the UI's "Commit & Push"
 * button.
 *
 * Deliberately routes through the SAME verified-commit path as both of
 * those (stage-all -> build commit intent -> signed GitHub API commit) via
 * the `commitAndPush` closure injected by the web app in
 * AgentContext.github -- see apps/web/app/workflows/chat.ts. This tool
 * itself never touches git credentials or the GitHub API directly; it
 * can't exist without that injected context (packages/agent has no DB or
 * GitHub App access), so it degrades to a clear error instead of failing
 * silently when nothing is injected.
 */
export function githubCommitTool() {
  return tool({
    description:
      "Commit and push all current uncommitted changes in the sandbox to the connected GitHub repository, on the current branch. Uses the exact same verified commit path as the UI's 'Commit & Push' button. Use this when the user asks you to commit, push, or save their work to GitHub. If no repository is connected to this session yet, this returns an error explaining that -- tell the user to connect one first (repo icon next to the chat), don't try to work around it with raw git commands.",
    inputSchema: githubCommitInputSchema,
    execute: async (
      input,
      { experimental_context },
    ): Promise<GithubCommitToolResult> => {
      if (
        !isAgentContext(experimental_context) ||
        !experimental_context.github
      ) {
        return {
          committed: false,
          pushed: false,
          error: "GitHub commit/push isn't available in this environment.",
        };
      }

      const { github } = experimental_context;
      if (!github.hasRepo) {
        return {
          committed: false,
          pushed: false,
          error:
            "No GitHub repository is connected to this session yet. Ask the user to connect one via the repo icon next to the chat, then try again.",
        };
      }

      try {
        return await github.commitAndPush(input);
      } catch (error) {
        return {
          committed: false,
          pushed: false,
          error: error instanceof Error ? error.message : "Commit failed",
        };
      }
    },
  });
}
