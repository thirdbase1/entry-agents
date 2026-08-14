import { tool } from "ai";
import { z } from "zod";
import { isAgentContext } from "./utils";
import type { GithubCliToolResult } from "../types";

const githubCliInputSchema = z.object({
  action: z
    .enum(["commit_and_push", "pr_comments"])
    .describe(
      "'commit_and_push': commit and push all current uncommitted sandbox changes to the connected repo on the current branch. 'pr_comments': fetch every comment and review left on the pull request for this session's current branch.",
    ),
  commitTitle: z
    .string()
    .max(72)
    .optional()
    .describe(
      "Only used with action 'commit_and_push'. Short, conventional-commit style title (e.g. 'fix: handle nested repos'). If omitted, one is auto-generated from the staged diff.",
    ),
  commitBody: z
    .string()
    .optional()
    .describe(
      "Only used with action 'commit_and_push'. Optional longer commit body/description.",
    ),
});

export type GithubCliToolInput = z.infer<typeof githubCliInputSchema>;

/**
 * Single entry point for every GitHub action the agent can take on its
 * own initiative, mirroring the vercelCliTool pattern one action-based
 * tool instead of a tool-per-action. Both actions route through closures
 * injected by the web app in AgentContext.github (see
 * apps/web/app/workflows/chat.ts) rather than touching git credentials or
 * the GitHub API directly:
 *
 * - commit_and_push -> github.commitAndPush(): the SAME verified-commit
 *   path as the UI's "Commit & Push" button (stage-all -> build commit
 *   intent -> signed GitHub API commit).
 * - pr_comments -> github.listPrComments(): backed by
 *   apps/web/lib/github/pulls.ts getPullRequestComments().
 *
 * This tool can't exist without that injected context (packages/agent
 * has no DB or GitHub App access of its own), so each action degrades to
 * a clear error instead of failing silently when nothing is injected, or
 * when no repo/PR is connected yet.
 */
export function githubCliTool() {
  return tool({
    description:
      "Take a GitHub action on the connected repository for this session: commit_and_push (commit and push all current uncommitted sandbox changes, using the exact same verified path as the UI's 'Commit & Push' button) or pr_comments (fetch every comment/review left on the pull request for the current branch, instead of asking the user to paste it in). If no repository or pull request is connected yet, this returns a clear error -- relay that to the user (repo icon next to the chat), don't try to work around it with raw git commands.",
    inputSchema: githubCliInputSchema,
    execute: async (
      input,
      { experimental_context },
    ): Promise<GithubCliToolResult> => {
      if (
        !isAgentContext(experimental_context) ||
        !experimental_context.github
      ) {
        return {
          success: false,
          action: input.action,
          error: "GitHub tools aren't available in this environment.",
        };
      }

      const { github } = experimental_context;
      if (!github.hasRepo) {
        return {
          success: false,
          action: input.action,
          error:
            "No GitHub repository is connected to this session yet. Ask the user to connect one via the repo icon next to the chat, then try again.",
        };
      }

      if (input.action === "commit_and_push") {
        try {
          const result = await github.commitAndPush({
            commitTitle: input.commitTitle,
            commitBody: input.commitBody,
          });
          return {
            success: result.committed,
            action: input.action,
            committed: result.committed,
            pushed: result.pushed,
            commitSha: result.commitSha,
            commitUrl: result.commitUrl,
            error: result.error,
          };
        } catch (error) {
          return {
            success: false,
            action: input.action,
            committed: false,
            pushed: false,
            error: error instanceof Error ? error.message : "Commit failed",
          };
        }
      }

      try {
        const result = await github.listPrComments();
        return {
          success: result.success,
          action: input.action,
          prNumber: result.prNumber,
          comments: result.comments,
          error: result.error,
        };
      } catch (error) {
        return {
          success: false,
          action: input.action,
          comments: [],
          error:
            error instanceof Error
              ? error.message
              : "Failed to fetch pull request comments",
        };
      }
    },
  });
}
