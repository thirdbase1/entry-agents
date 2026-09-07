import { tool, type LanguageModelUsage, type ModelMessage } from "ai";
import { z } from "zod";
import { SUBAGENT_REGISTRY, SUBAGENT_TYPES } from "../subagents/registry";
import { sumLanguageModelUsage } from "../usage";
import { getSandboxContext, getSubagentModel } from "./utils";

const taskSchema = z.object({
  id: z.string().min(1).describe("Stable identifier for this parallel task"),
  subagentType: z.enum(SUBAGENT_TYPES),
  task: z.string().min(1),
  instructions: z.string().min(1),
  scope: z.array(z.string().min(1)).min(1).describe(
    "Workspace-relative paths or directories this task may modify. Use [\"read-only\"] for explorer tasks."
  ),
});

const inputSchema = z.object({
  tasks: z.array(taskSchema).min(2).max(4),
});

export type ParallelTaskInput = z.infer<typeof inputSchema>;

function normalizeScope(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized.replace(/\/$/, "") || ".";
}

function scopesOverlap(a: string, b: string): boolean {
  if (a === "read-only" || b === "read-only") return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function validateScopes(tasks: ParallelTaskInput["tasks"]): void {
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const left = tasks[i];
      const right = tasks[j];
      for (const leftScope of left.scope.map(normalizeScope)) {
        for (const rightScope of right.scope.map(normalizeScope)) {
          if (scopesOverlap(leftScope, rightScope)) {
            throw new Error(
              `Parallel tasks "${left.id}" and "${right.id}" have overlapping write scope: ${leftScope} ↔ ${rightScope}. Split the scopes or run the dependent work sequentially.`,
            );
          }
        }
      }
    }
  }
}

export const parallelTaskTool = tool({
  needsApproval: false,
  description: `Run 2–4 independent subagents concurrently in the same sandbox.

Use this only when work is genuinely independent. Every task MUST declare the workspace-relative paths/directories it may modify. Overlapping write scopes are rejected before any subagent starts.

Good uses:
- frontend, backend, and test work in separate directories
- independent investigations
- parallel read-only reconnaissance

Do NOT parallelize tasks that edit the same file, depend on another task's output, perform migrations against the same mutable state, or share generated artifacts.

The caller remains responsible for integrating and verifying all results after the parallel phase.`,
  inputSchema,
  execute: async ({ tasks }, { experimental_context, abortSignal }) => {
    validateScopes(tasks);

    const sandboxContext = getSandboxContext(experimental_context, "parallel_task");
    const model = getSubagentModel(experimental_context, "parallel_task");

    const results = await Promise.all(
      tasks.map(async (task) => {
        const subagent = SUBAGENT_REGISTRY[task.subagentType].agent;
        const result = await subagent.stream({
          prompt: "Complete this task and return a concise implementation or investigation summary.",
          options: {
            task: task.task,
            instructions: `${task.instructions}\n\n## HARD SCOPE\nYou may only modify files under these declared paths:\n${task.scope.map((scope) => `- ${scope}`).join("\n")}\nDo not modify files outside this scope.`,
            sandbox: sandboxContext.sandbox,
            model,
          },
          abortSignal,
        });

        const response = await result.response;
        const usage = await result.usage;
        const lastAssistant = response.messages.findLast(
          (message: ModelMessage) => message.role === "assistant",
        );
        const content = lastAssistant?.content;
        const summary =
          typeof content === "string"
            ? content
            : content
              ? content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n")
              : "Task completed without a text summary.";

        return {
          id: task.id,
          subagentType: task.subagentType,
          summary,
          usage,
        };
      }),
    );

    return {
      completed: results.length,
      results,
      totalUsage: results.reduce<LanguageModelUsage | undefined>(
        (total, result) => sumLanguageModelUsage(total, result.usage),
        undefined,
      ),
    };
  },
});
