import { tool } from "ai";
import { z } from "zod";
import { isAgentContext } from "./utils";
import type { GithubCliToolResult } from "../types";

const githubCliInputSchema = z.object({
  action: z
    .enum(["commit_and_push", "api"])
    .describe(
      "'commit_and_push': commit and push all current uncommitted sandbox changes to the connected repo on the current branch. 'api': call any GitHub REST API endpoint for this repo (or beyond) -- list/create/update/close/merge pull requests and issues, read or post comments and reviews, manage labels, branches, releases, etc.",
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
  method: z
    .enum(["GET", "POST", "PATCH", "PUT", "DELETE"])
    .optional()
    .describe(
      "Only used with action 'api'. HTTP method for the GitHub REST call. Defaults to GET.",
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Only used with action 'api'. GitHub REST API path. Relative to this session's connected repo by default -- e.g. 'pulls/12/comments', 'issues/3/labels', 'pulls/12/merge'. Prefix with '/' for any other endpoint, e.g. '/user' or '/orgs/{org}/repos'.",
    ),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Only used with action 'api'. Octokit-style params: keys matching {templates} in the path fill the URL, everything else becomes query params (GET/DELETE) or JSON body fields (POST/PATCH/PUT). E.g. for 'issues/{issue_number}/comments' pass { issue_number: 12, body: 'Looks good!' }.",
    ),
});

export type GithubCliToolInput = z.infer<typeof githubCliInputSchema>;

/**
 * Single entry point for every GitHub action the agent can take on its
 * own initiative, mirroring the vercelCliTool pattern: one action-based
 * tool instead of a tool-per-action, with a generic REST passthrough
 * (action 'api') so the agent can do essentially anything the GitHub API
 * supports -- not just the couple of actions we thought to hardcode.
 * Both actions route through closures injected by the web app in
 * AgentContext.github (see apps/web/app/workflows/chat.ts) rather than
 * touching git credentials or the GitHub API directly:
 *
 * - commit_and_push -> github.commitAndPush(): the SAME verified-commit
 *   path as the UI's "Commit & Push" button (stage-all -> build commit
 *   intent -> signed GitHub API commit). Kept as its own action because
 *   it depends on the sandbox's actual working-tree diff, which isn't
 *   expressible as a plain REST call.
 * - api -> github.request(): a generic Octokit request, same
 *   authenticated GitHub App client as commitAndPush -- see
 *   apps/web/lib/github/client.ts getOctokit().
 *
 * This tool can't exist without that injected context (packages/agent
 * has no DB or GitHub App access of its own), so each action degrades to
 * a clear error instead of failing silently when nothing is injected, or
 * when no repo is connected yet.
 */
export function githubCliTool() {
  return tool({
    description:
      "Take a GitHub action on the connected repository for this session: commit_and_push (commit and push all current uncommitted sandbox changes, using the exact same verified path as the UI's 'Commit & Push' button) or api (call any GitHub REST API endpoint -- PRs, issues, comments, reviews, labels, merges, branches, releases, anything). Use 'api' whenever the user asks about PR/issue feedback, wants to merge/close/label something, or any other GitHub action that isn't a plain commit. If no repository is connected yet, this returns a clear error -- relay that to the user (repo icon next to the chat), don't try to work around it with raw git commands.",
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

      if (!input.path) {
        return {
          success: false,
          action: input.action,
          error: "Action 'api' requires a 'path'.",
        };
      }

      try {
        const result = await github.request({
          method: input.method ?? "GET",
          path: input.path,
          params: input.params,
        });
        return {
          success: result.success,
          action: input.action,
          status: result.status,
          data: result.data,
          error: result.error,
        };
      } catch (error) {
        return {
          success: false,
          action: input.action,
          error:
            error instanceof Error
              ? error.message
              : "GitHub API request failed",
        };
      }
    },
  });
}
