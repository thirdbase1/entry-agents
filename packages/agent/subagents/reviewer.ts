import type { LanguageModel } from "ai";
import { addCacheControl } from "../context-management/cache-control";
import { stepCountIs, ToolLoopAgent } from "ai";
import { createInertPlaceholderModel, sharedProvider } from "../models";
import { defaultModelLabel } from "../default-model";
import { z } from "zod";
import { bashTool } from "../tools/bash";
import { globTool } from "../tools/glob";
import { grepTool } from "../tools/grep";
import { readFileTool } from "../tools/read";
import type { SandboxExecutionContext } from "../types";
import {
  SUBAGENT_NO_QUESTIONS_RULES,
  SUBAGENT_RESPONSE_FORMAT,
  SUBAGENT_STEP_LIMIT,
  SUBAGENT_WORKING_DIR,
} from "./constants";

const REVIEWER_REMINDER = `## REMINDER
- You CANNOT ask questions - no one will respond
- This is READ-ONLY review - do NOT create, modify, or delete any files
- Your final message MUST include both a **Summary** of what you reviewed AND the **Answer** with your findings`;

const REVIEWER_SYSTEM_PROMPT = `You are a reviewer agent - a meticulous, read-only subagent specialized for reviewing code before it ships.

## CRITICAL RULES

### READ-ONLY OPERATIONS ONLY
This is a READ-ONLY review task. You are STRICTLY PROHIBITED from:
- Creating, modifying, or deleting any files
- Running commands that change system state (no installs, no commits, no builds that write artifacts)

Your role is EXCLUSIVELY to read, analyze, and report.

${SUBAGENT_NO_QUESTIONS_RULES}

${SUBAGENT_RESPONSE_FORMAT}

Example final response:
---
**Summary**: I reviewed the staged changes to the billing module (git diff) plus the two files they touch. I traced the window-budget math through the call sites and checked the error paths.

**Answer**: One real bug and two nits.
1. **Bug** (\`lib/billing/window.ts:42\`): the 5-hour window subtracts cached tokens twice, so heavy users get cut off ~10% early.
2. **Nit**: \`resolveBudget()\` has no test for the empty-transactions case.
3. **Nit**: the error message says "top up" but this path is window exhaustion -- it should say "refills".
---

## REVIEW METHODOLOGY

1. **Establish scope first**: if the task names a diff/branch/PR, read it (\`git diff\`, \`git log\`, \`git show\`); if it names files, read them directly.
2. **Read the code AROUND the change**, not just the change - call sites, type contracts, and callers are where bugs actually live.
3. **Check in this order** (highest value first):
   - Correctness: does the logic actually do what the task says it should? Edge cases? Off-by-ones? Race conditions? Silent failures?
   - Security: injection, secrets in code/logs, missing auth on new endpoints, unsafe shell interpolation
   - Data integrity: migrations vs schema, null/undefined handling, destructive operations
   - Tests: does the change have coverage? Would existing tests catch a regression here?
   - Consistency: does it follow the file's existing patterns/conventions?
4. **Verify, don't speculate**: run read-only checks (\`git diff\`, grep for other call sites, read tests) before claiming something is broken.

## TOOLS & GUIDELINES

You have access to: read, grep, glob, bash (read-only commands only)

- Use \`git diff\` / \`git show\` to see exactly what changed
- Use grep to find every call site of anything the change touches
- Use read to inspect surrounding context and tests
- Use bash ONLY for read-only operations (ls, git status, git log, git diff, git show, find)
- NEVER use bash for: mkdir, touch, rm, cp, mv, git add, git commit, git checkout, npm install, or any file creation/modification
- Return workspace-relative file paths and line numbers in findings (e.g., "src/billing/window.ts:42")

## FINDINGS FORMAT

- Rank findings by severity: real bugs first, then risks, then nits
- For each finding: file:line, what's wrong, why it matters, and the concrete fix
- If you find nothing wrong, say so explicitly - never invent findings to seem useful`;

const callOptionsSchema = z.object({
  task: z.string().describe("Short description of the review task"),
  instructions: z
    .string()
    .describe("Detailed review instructions (what to review and why)"),
  sandbox: z
    .custom<SandboxExecutionContext["sandbox"]>()
    .describe("Sandbox for file system and shell operations"),
  model: z.custom<LanguageModel>().describe("Language model for this subagent"),
  // Per-step output clamp threaded from the host's billing guard
  // (packages/agent SubagentBudgetGuard, 2026-09-15): ToolLoopAgent
  // applies call settings to every internal step, so one value caps
  // each step's output. Undefined = no cap.
  maxOutputTokens: z.number().int().positive().optional(),
});

export type ReviewerCallOptions = z.infer<typeof callOptionsSchema>;

export const reviewerSubagent = new ToolLoopAgent({
  // Inert placeholder -- see createInertPlaceholderModel for why this
  // can't be a real sharedProvider() call at module scope. prepareCall
  // below lazily constructs the real default model if the caller
  // doesn't pass one explicitly.
  model: createInertPlaceholderModel(defaultModelLabel),
  instructions: REVIEWER_SYSTEM_PROMPT,
  tools: {
    read: readFileTool(),
    grep: grepTool(),
    glob: globTool(),
    bash: bashTool(),
  },
  stopWhen: stepCountIs(SUBAGENT_STEP_LIMIT),
  callOptionsSchema,
  prepareCall: ({ options, ...settings }) => {
    if (!options) {
      throw new Error("Reviewer subagent requires task call options.");
    }

    const sandbox = options.sandbox;
    const model = options.model ?? sharedProvider(defaultModelLabel);
    return {
      ...settings,
      model,
      ...(options.maxOutputTokens
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
      // addCacheControl (2026-08-18 pattern): the static system-prompt
      // block gets a cache breakpoint so Anthropic doesn't reprocess
      // it on every step of this task's own loop.
      instructions: addCacheControl({
        instructions: `${REVIEWER_SYSTEM_PROMPT}

${SUBAGENT_WORKING_DIR}

## Your Task
${options.task}

## Detailed Instructions
${options.instructions}

${REVIEWER_REMINDER}`,
        model,
      }),
      experimental_context: {
        sandbox,
        model,
      },
    };
  },
});
