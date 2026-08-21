import { openAgent } from "@open-agents/agent";
import { connectLocal } from "@open-agents/sandbox";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { addLanguageModelUsage } from "@/app/workflows/usage-utils";
import humanEvalSubset from "./data/humaneval-subset.json";

export interface HumanEvalTask {
  task_id: string;
  prompt: string;
  entry_point: string;
  canonical_solution: string;
  test: string;
}

export function loadHumanEvalSubset(): HumanEvalTask[] {
  return humanEvalSubset as HumanEvalTask[];
}

export const HUMANEVAL_SUITE_VERSION = "humaneval-subset-20-v1";

// Hard cap on outer-loop steps per task. openAgent.generate() executes
// exactly one model turn per call (see packages/agent/open-agent.ts's
// `stopWhen: stepCountIs(1)`) -- callers own the multi-turn loop, same
// as apps/web/app/workflows/chat.ts does for real chat sessions. Capped
// here to bound real-money API spend per task if a model gets stuck in
// a tool-call loop without ever producing a final answer.
const MAX_STEPS_PER_TASK = 10;
const PYTHON_GRADE_TIMEOUT_MS = 15_000;

export interface HumanEvalTaskResult {
  taskId: string;
  passed: boolean;
  latencyMs: number;
  usage: LanguageModelUsage | undefined;
  errorMessage?: string;
  transcript: ModelMessage[];
}

function buildTaskPrompt(task: HumanEvalTask): string {
  return [
    "Implement the following Python function so that it satisfies its docstring exactly.",
    "Write your solution to a file named `solution.py` in the current directory.",
    "The file must contain the complete function definition (including its signature, imports it needs, and the docstring) -- not just the body.",
    "Do not write any test code or call the function yourself; just implement it.",
    "",
    "```python",
    task.prompt,
    "```",
  ].join("\n");
}

/**
 * Grades a candidate solution.py against the task's real HumanEval test
 * suite, using the standard HumanEval evaluation methodology: exec the
 * candidate's module, then exec the task's `check(candidate)` test
 * function against the candidate's entry_point function. Runs as a
 * fresh `python3` subprocess -- deliberately NOT executed through the
 * agent's own bash tool, so a model can't ever grade its own work.
 */
export async function gradeSolution(
  solutionPath: string,
  task: HumanEvalTask,
): Promise<{ passed: boolean; errorMessage?: string }> {
  let candidateCode: string;
  try {
    candidateCode = await fs.readFile(solutionPath, "utf-8");
  } catch {
    return { passed: false, errorMessage: "solution.py was never created" };
  }

  const graderScript = [
    "import sys, traceback",
    "candidate_ns = {}",
    "try:",
    "    exec(compile(sys.argv[1], 'solution.py', 'exec'), candidate_ns)",
    "except Exception:",
    "    print('CANDIDATE_IMPORT_ERROR')",
    "    traceback.print_exc()",
    "    sys.exit(1)",
    `entry_point = candidate_ns.get(${JSON.stringify(task.entry_point)})`,
    "if entry_point is None:",
    "    print('ENTRY_POINT_MISSING')",
    "    sys.exit(1)",
    "test_ns = dict(candidate_ns)",
    "try:",
    "    exec(compile(sys.argv[2], 'test.py', 'exec'), test_ns)",
    "    test_ns['check'](entry_point)",
    "except Exception:",
    "    print('TEST_FAILED')",
    "    traceback.print_exc()",
    "    sys.exit(1)",
    "print('PASSED')",
  ].join("\n");

  return new Promise((resolve) => {
    const child = spawn(
      "python3",
      ["-c", graderScript, candidateCode, task.test],
      { timeout: PYTHON_GRADE_TIMEOUT_MS },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code === 0 && stdout.includes("PASSED")) {
        resolve({ passed: true });
      } else {
        resolve({
          passed: false,
          errorMessage: `${stdout}\n${stderr}`.slice(0, 2000),
        });
      }
    });
    child.on("error", (err) => {
      resolve({ passed: false, errorMessage: err.message });
    });
  });
}

/**
 * Runs one HumanEval task through the real production agent harness
 * (packages/agent's openAgent -- same system prompt, same tool set, same
 * gateway-routed model call as a real chat session) against a fresh
 * local sandbox, then grades the result with a real, independent
 * `python3` subprocess.
 */
export async function runHumanEvalTask(
  modelId: string,
  task: HumanEvalTask,
): Promise<HumanEvalTaskResult> {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `benchmark-${task.task_id.replace("/", "-")}-`),
  );

  const startedAt = Date.now();
  const messages: ModelMessage[] = [
    { role: "user", content: buildTaskPrompt(task) },
  ];
  let totalUsage: LanguageModelUsage | undefined;
  let errorMessage: string | undefined;

  try {
    await connectLocal({ rootDir });

    for (let step = 0; step < MAX_STEPS_PER_TASK; step++) {
      const result = await openAgent.generate({
        messages,
        options: {
          sandbox: {
            state: { type: "local", rootDir },
            workingDirectory: rootDir,
          },
          model: modelId,
        },
      });

      messages.push(...result.response.messages);
      totalUsage = totalUsage
        ? addLanguageModelUsage(totalUsage, result.usage)
        : result.usage;

      if (result.finishReason !== "tool-calls") {
        break;
      }
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const latencyMs = Date.now() - startedAt;

  let passed = false;
  if (!errorMessage) {
    const grade = await gradeSolution(path.join(rootDir, "solution.py"), task);
    passed = grade.passed;
    errorMessage = grade.errorMessage;
  }

  await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});

  return {
    taskId: task.task_id,
    passed,
    latencyMs,
    usage: totalUsage,
    errorMessage,
    transcript: messages,
  };
}
