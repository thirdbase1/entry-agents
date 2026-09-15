import {
  type LanguageModelUsage,
  type ModelMessage,
  tool,
  type UIToolInvocation,
} from "ai";
import { z } from "zod";
import {
  buildSubagentSummaryLines,
  SUBAGENT_REGISTRY,
  SUBAGENT_TYPES,
} from "../subagents/registry";
import { SUBAGENT_STEP_LIMIT } from "../subagents/constants";
import { sumLanguageModelUsage } from "../usage";
import { getSandboxContext, getSubagentModel } from "./utils";
import type { AgentContext, SubagentBudgetGuard } from "../types";

const subagentTypeSchema = z.enum(SUBAGENT_TYPES);

const subagentSummaryLines = buildSubagentSummaryLines();

const taskInputSchema = z.object({
  subagentType: subagentTypeSchema.describe(
    `Subagent to launch. Available options:\n${subagentSummaryLines}`,
  ),
  task: z
    .string()
    .describe("Short description of the task (displayed to user)"),
  instructions: z.string().describe(
    `Detailed instructions for the subagent. Include:
- Goal and deliverables
- Step-by-step procedure
- Constraints and patterns to follow
- How to verify the work`,
  ),
});

const taskPendingToolCallSchema = z.object({
  name: z.string(),
  input: z.unknown(),
});

export type TaskPendingToolCall = z.infer<typeof taskPendingToolCallSchema>;

export const taskOutputSchema = z.object({
  pending: taskPendingToolCallSchema.optional(),
  toolCallCount: z.number().int().nonnegative().optional(),
  startedAt: z.number().int().nonnegative().optional(),
  modelId: z.string().optional(),
  final: z.custom<ModelMessage[]>().optional(),
  usage: z.custom<LanguageModelUsage>().optional(),
});

export type TaskToolOutput = z.infer<typeof taskOutputSchema>;

export const taskTool = tool({
  needsApproval: false,
  description: `Launch a specialized subagent to handle complex tasks autonomously.

AVAILABLE SUBAGENTS:
${subagentSummaryLines}

WHEN TO USE:
- Clearly-scoped work that can be delegated with explicit instructions
- Work where focused execution would clutter the main conversation
- Tasks that match one of the available subagent descriptions above

WHEN NOT TO USE (do it yourself):
- Simple, single-file or single-change edits
- Tasks where you already have all the context you need
- Ambiguous work that requires back-and-forth clarification

BEHAVIOR:
- Subagents work AUTONOMOUSLY without asking follow-up questions
- They run up to ${SUBAGENT_STEP_LIMIT} tool steps and then return
- They return ONLY a concise summary - their internal steps are isolated from the parent

HOW TO USE:
- Choose the appropriate subagentType based on the subagent descriptions above
- Provide a short task string (for display) summarizing the goal
- Provide detailed instructions including goals, steps, constraints, and verification criteria

IMPORTANT:
- Be explicit and concrete - subagents cannot ask clarifying questions
- Include critical context (APIs, function names, file paths) in the instructions
- The parent agent will not see the subagent's internal tool calls, only its final summary`,
  inputSchema: taskInputSchema,
  outputSchema: taskOutputSchema,
  execute: async function* (
    { subagentType, task, instructions },
    { experimental_context, abortSignal },
  ) {
    const sandboxContext = getSandboxContext(experimental_context, "task");
    const model = getSubagentModel(experimental_context, "task");
    const subagentModelId = typeof model === "string" ? model : model.modelId;

    const subagent = SUBAGENT_REGISTRY[subagentType].agent;

    // Real-time subagent budget enforcement (host-injected billing
    // guard, 2026-09-15): subagent usage previously landed in the
    // ledger only at the END of the whole turn, so a subagent could
    // spend past an Entry window mid-turn. The guard shares the parent
    // turn's in-memory window/balance counters.
    const billingGuard: SubagentBudgetGuard | undefined = (
      experimental_context as AgentContext | undefined
    )?.billingGuard;

    const startedAt = Date.now();
    let toolCallCount = 0;

    if (billingGuard) {
      const plan = billingGuard.planSubagent(subagentModelId);
      if (plan.stop) {
        // Even a first subagent step doesn't fit the remaining budget --
        // refuse the launch with zero spend. Wording mirrors the main
        // model's window/credit exhaustion notices.
        const reasonText =
          plan.reason === "window"
            ? "usage window exhausted"
            : "credit balance exhausted";
        const refused: ModelMessage[] = [
          {
            role: "assistant",
            content: `Task not started: the user's ${reasonText}. Ask them to wait for the window to refill or top up, then re-invoke this task.`,
          },
        ];
        yield {
          final: refused,
          toolCallCount,
          startedAt,
          modelId: subagentModelId,
        };
        return;
      }
    }

    // The subagent gets its own abort controller so the BUDGET guard
    // can stop just the subagent without killing the parent turn --
    // the parent's signal is forwarded so user-initiated stops still
    // abort everything.
    const localAbort = new AbortController();
    const forwardParentAbort = () => localAbort.abort();
    if (abortSignal?.aborted) {
      localAbort.abort();
    } else {
      abortSignal?.addEventListener("abort", forwardParentAbort);
    }

    let budgetStopped = false;
    let budgetStopReason: "window" | "credit" | undefined;

    const result = await subagent.stream({
      prompt:
        "Complete this task and provide a summary of what you accomplished.",
      options: {
        task,
        instructions,
        sandbox: sandboxContext.sandbox,
        model,
        ...(billingGuard
          ? (() => {
              const plan = billingGuard.planSubagent(subagentModelId);
              return plan.maxOutputTokens
                ? { maxOutputTokens: plan.maxOutputTokens }
                : {};
            })()
          : {}),
      },
      abortSignal: localAbort.signal,
    });

    let pending: TaskPendingToolCall | undefined;
    let usage: LanguageModelUsage | undefined;

    // Emit an initial state so UIs can show elapsed time from a stable timestamp.
    yield { toolCallCount, startedAt, modelId: subagentModelId };

    for await (const part of result.fullStream) {
      if (part.type === "tool-call") {
        toolCallCount += 1;
        pending = { name: part.toolName, input: part.input };
        yield {
          pending,
          toolCallCount,
          usage,
          startedAt,
          modelId: subagentModelId,
        };
      }

      if (part.type === "finish-step") {
        usage = sumLanguageModelUsage(usage, part.usage);
        // Real-time budget accounting: the host decrements its shared
        // window/balance counters with this step's real usage and tells
        // us whether any budget just tripped. Stopping here bounds the
        // subagent's overshoot to one step instead of the whole task.
        if (billingGuard) {
          const plan = billingGuard.noteSubagentStepUsage(
            subagentModelId,
            part.usage,
          );
          if (plan.stop) {
            budgetStopped = true;
            budgetStopReason = plan.reason;
            localAbort.abort();
          }
        }
        // Keep the last observed tool call in interim updates so task UIs don't
        // flicker back to an initializing state between subagent steps.
        yield {
          pending,
          toolCallCount,
          usage,
          startedAt,
          modelId: subagentModelId,
        };
      }
    }

    abortSignal?.removeEventListener("abort", forwardParentAbort);

    const response = await result.response;
    const finalUsage = usage ?? (await result.usage);

    if (budgetStopped) {
      // The subagent was cut short by the user's window/balance
      // budget. Its partial work still flows back to the parent (the
      // parent loop itself will hit the same budget gate on its next
      // step), but say so instead of pretending the task completed.
      const reasonText =
        budgetStopReason === "window"
          ? "usage window"
          : budgetStopReason === "credit"
            ? "credit balance"
            : "usage limit";
      const truncated: ModelMessage[] = [
        ...response.messages,
        {
          role: "assistant",
          content: `[Budget limit reached: this subagent was stopped by the user's ${reasonText}. The work above is partial -- the remaining steps were not run.]`,
        },
      ];
      yield {
        final: truncated,
        toolCallCount,
        usage: finalUsage,
        startedAt,
        modelId: subagentModelId,
      };
      return;
    }

    yield {
      final: response.messages,
      toolCallCount,
      usage: finalUsage,
      startedAt,
      modelId: subagentModelId,
    };
  },
  toModelOutput: ({ output: { final: messages } }) => {
    if (!messages) {
      return { type: "text", value: "Task completed." };
    }

    const lastAssistantMessage = messages.findLast(
      (p) => p.role === "assistant",
    );
    const content = lastAssistantMessage?.content;

    if (!content) {
      return { type: "text", value: "Task completed." };
    }

    if (typeof content === "string") {
      return { type: "text", value: content };
    }

    const lastTextPart = content.findLast((p) => p.type === "text");
    if (!lastTextPart) {
      return { type: "text", value: "Task completed." };
    }

    return { type: "text", value: lastTextPart.text };
  },
});

export type TaskToolUIPart = UIToolInvocation<typeof taskTool>;
