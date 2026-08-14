import { tool } from "ai";
import { z } from "zod";
import { isAgentContext } from "./utils";
import type { VercelCliToolResult } from "../types";

const vercelCliInputSchema = z.object({
  args: z
    .string()
    .describe(
      "Everything that goes after `vercel` on the command line, e.g. 'deploy --prod', 'env ls', 'logs <deployment-url>', 'ls', 'inspect <url>', 'domains ls', 'link --yes', 'whoami'. Do not include the word 'vercel' itself, and never try to pass a token or --scope yourself -- authentication and project scoping are injected automatically for the connected account/project.",
    ),
});

export type VercelCliToolInput = z.infer<typeof vercelCliInputSchema>;

/**
 * Lets the agent run arbitrary Vercel CLI commands (deploy, env, logs,
 * inspect, domains, ls, link, whoami, ...) against the user's own Vercel
 * account, the same way githubCommitTool/githubPrCommentsTool reuse the
 * app's verified GitHub paths instead of the agent handling credentials
 * itself.
 *
 * Deliberately never sees the user's Vercel OAuth token -- the `run`
 * closure injected by apps/web (see app/workflows/chat.ts,
 * AgentContext.vercel) fetches a fresh token plus the Vercel project
 * already linked to this repo, then runs the command in the sandbox with
 * them set only for that one process's environment (VERCEL_TOKEN, and
 * --scope/project linkage when available). This tool can't exist without
 * that injected context (packages/agent has no DB or Vercel OAuth
 * access), so it degrades to a clear error instead of failing silently
 * when nothing is injected, or when the user hasn't connected Vercel.
 */
export function vercelCliTool() {
  return tool({
    description:
      "Run any Vercel CLI command (`vercel <args>`) authenticated as the current user's own connected Vercel account -- deploy, check environment variables, read deployment logs, inspect deployments, manage domains, link a project, check who's authenticated, etc. Use this instead of trying to construct your own auth/token setup or asking the user to run commands themselves. If the user hasn't connected their Vercel account yet, this returns a clear error -- tell them to connect it in settings, don't try to work around it.",
    inputSchema: vercelCliInputSchema,
    execute: async (
      input,
      { experimental_context },
    ): Promise<VercelCliToolResult> => {
      if (
        !isAgentContext(experimental_context) ||
        !experimental_context.vercel
      ) {
        return {
          success: false,
          error: "Vercel CLI isn't available in this environment.",
        };
      }

      const { vercel } = experimental_context;
      if (!vercel.connected) {
        return {
          success: false,
          error:
            "No Vercel account is connected for this user yet. Ask them to connect it in settings, then try again.",
        };
      }

      try {
        return await vercel.run(input);
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Vercel CLI command failed",
        };
      }
    },
  });
}
