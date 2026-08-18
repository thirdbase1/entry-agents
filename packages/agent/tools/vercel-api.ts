import { tool } from "ai";
import { z } from "zod";
import { isAgentContext } from "./utils";
import type { VercelApiResult } from "../types";

const vercelApiInputSchema = z.object({
  method: z
    .enum(["GET", "POST", "PATCH", "PUT", "DELETE"])
    .optional()
    .describe("HTTP method for the Vercel REST call. Defaults to GET."),
  path: z
    .string()
    .describe(
      "Vercel REST API path, e.g. 'v13/deployments', 'v9/projects/{idOrName}/env', 'v6/deployments/{id}'. Leading '/' optional. See https://vercel.com/docs/rest-api for available endpoints.",
    ),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Keys matching {templates} in the path fill the URL, everything else becomes query params (GET/DELETE) or JSON body fields (POST/PATCH/PUT).",
    ),
});

export type VercelApiToolInput = z.infer<typeof vercelApiInputSchema>;

/**
 * Generic Vercel REST API passthrough, mirroring githubCliTool's 'api'
 * action -- for the handful of things vercel_cli's CLI passthrough
 * doesn't cover cleanly (structured JSON reads like full deployment
 * metadata/builds, edge config, webhooks, some project-settings
 * endpoints). Routes through AgentContext.vercel.request, which apps/web
 * backs with a direct authenticated fetch to api.vercel.com using the
 * same per-user OAuth token as vercel_cli (see
 * apps/web/app/workflows/chat.ts performAgentVercelApiRequest) -- no
 * sandbox/CLI involved, so it works even when the sandbox is idle.
 */
export function vercelApiTool() {
  return tool({
    description:
      "Call any Vercel REST API endpoint directly (not via the CLI) for the current user's connected Vercel account -- use this for structured JSON reads/writes vercel_cli's CLI output doesn't expose cleanly (full deployment metadata, edge config, webhooks, some project settings). Prefer vercel_cli for anything the CLI already does well (deploy, logs, env, domains). If the user hasn't connected Vercel yet, this returns a clear error -- tell them to connect it in settings.",
    inputSchema: vercelApiInputSchema,
    execute: async (
      input,
      { experimental_context },
    ): Promise<VercelApiResult> => {
      if (
        !isAgentContext(experimental_context) ||
        !experimental_context.vercel
      ) {
        return {
          success: false,
          error: "Vercel API isn't available in this environment.",
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
        return await vercel.request({
          method: input.method ?? "GET",
          path: input.path,
          params: input.params,
        });
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error
              ? error.message
              : "Vercel API request failed",
        };
      }
    },
  });
}
