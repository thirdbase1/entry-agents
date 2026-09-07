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
  scope: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'Workspace-relative paths or directories this task may modify. Use ["read-only"] for explorer tasks.',
    ),
  dependsOn: z
    .array(z.string().min(1))
    .default([])
    .describe("Task ids that must finish before this task can start"),
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

function validateTasks(tasks: ParallelTaskInput["tasks"]): void {
  const ids = new Set<string>();

  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Parallel task id must be unique: "${task.id}".`);
    }
    ids.add(task.id);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new Error(`Parallel task "${task.id}" cannot depend on itself.`);
      }
      if (!ids.has(dependency)) {
        throw new Error(
          `Parallel task "${task.id}" depends on unknown task "${dependency}".`,
        );
      }
    }
  }

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

  // Kahn's algorithm: reject dependency cycles before any worker starts.
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn)]));
  let resolved = 0;
  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([id]) => id);
    if (ready.length === 0) {
      throw new Error("Parallel task dependency graph contains a cycle.");
    }
    for (const id of ready) {
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
      resolved += 1;
    }
  }

  if (resolved !== tasks.length) {
    throw new Error("Parallel task dependency graph could not be resolved.");
  }
}

async function runTask(
  task: ParallelTaskInput["tasks"][number],
  sandbox: ReturnType<typeof getSandboxContext>["sandbox"],
  model: Parameters<typeof SUBAGENT_REGISTRY["executor"]["agent"]["stream"]>[0]["options"] extends infer _
    ? any
    : never,
  abortSignal: AbortSignal | undefined,
) {
  const subagent = SUBAGENT_REGISTRY[task.subagentType].agent;
  const result = await subagent.stream({
    prompt:
      "Complete this task and return a concise implementation or investigation summary.",
    options: {
      task: task.task,
      instructions: `${task.instructions}\n\n## HARD SCOPE\nYou may only modify files under these declared paths:\n${task.scope
        .map((scope) => `- ${scope}`)
        .join("\n")}\nDo not modify files outside this scope.`,
      sandbox,
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
    status: "completed" as const,
    summary,
    usage,
  };
}

export const parallelTaskTool = tool({
  needsApproval: false,
  description: `Run 2–4 independent or dependency-ordered subagents with safe parallel waves.

Every task MUST declare workspace-relative write scope. Overlapping write scopes are rejected before execution. Use dependsOn when a task requires another task's output; dependent tasks are started only after their prerequisites complete.

The runtime rejects duplicate ids, unknown dependencies, self-dependencies, and dependency cycles. Failed tasks do not discard successful work, but dependent tasks are not started after a failed prerequisite.

The caller remains responsible for integration and verification. Declared scopes are coordination constraints, not OS-level filesystem isolation.`,
  inputSchema,
  execute: async ({ tasks }, { experimental_context, abortSignal }) => {
    validateTasks(tasks);

    const sandboxContext = getSandboxContext(
      experimental_context,
      "parallel_task",
    );
    const model = getSubagentModel(experimental_context, "parallel_task");
    const pending = new Map(tasks.map((task) => [task.id, task]));
    const completed = new Set<string>();
    const failed = new Set<string>();
    const results: Array<Record<string, unknown>> = [];

    while (pending.size > 0) {
      if (abortSignal?.aborted) throw new Error("Parallel task execution aborted.");

      const blocked = [...pending.values()].filter((task) =>
        task.dependsOn.some((dependency) => failed.has(dependency)),
      );
      for (const task of blocked) {
        pending.delete(task.id);
        failed.add(task.id);
        results.push({
          id: task.id,
          subagentType: task.subagentType,
          status: "blocked" as const,
          summary: "",
          error: "A dependency failed, so this task was not started.",
        });
      }

      const ready = [...pending.values()].filter((task) =>
        task.dependsOn.every((dependency) => completed.has(dependency)),
      );
      if (ready.length === 0) {
        throw new Error("No executable parallel task remains; dependency graph is inconsistent.");
      }

      const settled = await Promise.allSettled(
        ready.map((task) => runTask(task, sandboxContext.sandbox, model, abortSignal)),
      );

      settled.forEach((outcome, index) => {
        const task = ready[index];
        pending.delete(task.id);
        if (outcome.status === "fulfilled") {
          completed.add(task.id);
          results.push(outcome.value);
        } else {
          failed.add(task.id);
          results.push({
            id: task.id,
            subagentType: task.subagentType,
            status: "failed" as const,
            summary: "",
            error:
              outcome.reason instanceof Error
                ? outcome.reason.message
                : String(outcome.reason),
          });
        }
      });
    }

    const totalUsage = results.reduce<LanguageModelUsage | undefined>(
      (total, result) =>
        "usage" in result && result.usage
          ? sumLanguageModelUsage(total, result.usage as LanguageModelUsage)
          : total,
      undefined,
    );

    return {
      completed: results.filter((result) => result.status === "completed").length,
      failed: results.filter(
        (result) => result.status === "failed" || result.status === "blocked",
      ).length,
      results,
      totalUsage,
    };
  },
});
