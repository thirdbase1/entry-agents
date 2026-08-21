import {
  completeBenchmarkRun,
  createBenchmarkRun,
  recordBenchmarkResult,
  type BenchmarkName,
} from "@/lib/db/benchmarks";
import type { AvailableModelCost } from "@/lib/models";
import { estimateModelUsageCost } from "@/lib/models";
import { fetchModelCostCatalog } from "@/lib/models-with-context";
import {
  HUMANEVAL_SUITE_VERSION,
  loadHumanEvalSubset,
  runHumanEvalTask,
} from "@/lib/benchmarks/humaneval-runner";

/**
 * Default set of models benchmarked when no explicit list is given.
 * Deliberately excludes claude-* (all routed through FreeModel's
 * cc.freemodel.dev passthrough -- see 2026-08-20 investigation into
 * gorouter/justwoker/FreeModel) and anything hard-blocked in code
 * (isModelHardBlocked in lib/model-availability.ts) -- a public
 * benchmark page shouldn't showcase a route Entry itself won't fully
 * stand behind.
 */
const DEFAULT_BENCHMARK_MODEL_IDS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "gemini-2.5-pro",
  "ling-3.0",
  "qwen3.8-max-free",
];

interface TaskStepResult {
  passed: boolean;
  latencyMs: number;
  costCents?: number;
  errorMessage?: string;
}

async function createRunStep(
  modelIds: string[],
  triggeredBy: string | undefined,
): Promise<string> {
  "use step";
  return createBenchmarkRun({
    suiteVersion: HUMANEVAL_SUITE_VERSION,
    modelIds,
    ...(triggeredBy ? { triggeredBy } : {}),
  });
}

/** Returns a plain, JSON-serializable modelId -> cost map (crosses a step boundary). */
async function loadCostCatalogStep(): Promise<
  Record<string, AvailableModelCost | undefined>
> {
  "use step";
  const catalog = await fetchModelCostCatalog();
  const byId: Record<string, AvailableModelCost | undefined> = {};
  for (const model of catalog) {
    byId[model.id] = model.cost;
  }
  return byId;
}

/**
 * Runs a single HumanEval task through the real agent harness. This is
 * the durable unit of retry/resumption for the whole suite -- if the
 * workflow run is interrupted, only the in-flight task is redone, not
 * every task before it (already-recorded results stay in the DB).
 */
async function runTaskStep(
  modelId: string,
  taskId: string,
  cost: AvailableModelCost | undefined,
): Promise<TaskStepResult> {
  "use step";
  const task = loadHumanEvalSubset().find((t) => t.task_id === taskId);
  if (!task) {
    return {
      passed: false,
      latencyMs: 0,
      errorMessage: `Unknown task ${taskId}`,
    };
  }

  const result = await runHumanEvalTask(modelId, task);

  let costCents: number | undefined;
  if (result.usage?.inputTokens != null && result.usage.outputTokens != null) {
    const dollarCost = estimateModelUsageCost(
      {
        inputTokens: result.usage.inputTokens,
        cachedInputTokens: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        cacheWriteInputTokens:
          result.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
        outputTokens: result.usage.outputTokens,
      },
      cost,
    );
    costCents = dollarCost != null ? Math.round(dollarCost * 100) : undefined;
  }

  return {
    passed: result.passed,
    latencyMs: result.latencyMs,
    ...(costCents != null ? { costCents } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
  };
}

async function recordResultStep(
  runId: string,
  modelId: string,
  benchmark: BenchmarkName,
  taskId: string,
  result: TaskStepResult,
): Promise<void> {
  "use step";
  await recordBenchmarkResult({
    runId,
    modelId,
    benchmark,
    taskId,
    passed: result.passed,
    latencyMs: result.latencyMs,
    ...(result.costCents != null ? { costCents: result.costCents } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
  });
}

async function completeRunStep(
  runId: string,
  status: "completed" | "failed",
  errorMessage: string | undefined,
): Promise<void> {
  "use step";
  await completeBenchmarkRun(runId, status, errorMessage);
}

export interface RunBenchmarkSuiteResult {
  runId: string;
  status: "completed" | "failed";
  modelIds: string[];
  taskCount: number;
}

/**
 * Durable Vercel Workflow that runs the full HumanEval benchmark suite
 * across a set of models. Routed through the Workflow SDK (same
 * durable-step pattern as the real chat turn pipeline and
 * archive-sandbox-stop) because a full run -- real, multi-step agent
 * turns against real metered model APIs, one task at a time on purpose
 * to avoid spiking cost/looking like abuse -- runs far longer than a
 * single serverless request's timeout allows. Each task is its own
 * durable step, so an interruption partway through only loses the
 * in-flight task, not the whole run.
 */
export async function runBenchmarkSuiteWorkflow(
  modelIds: string[] = DEFAULT_BENCHMARK_MODEL_IDS,
  triggeredBy?: string,
): Promise<RunBenchmarkSuiteResult> {
  "use workflow";

  const runId = await createRunStep(modelIds, triggeredBy);
  const costByModelId = await loadCostCatalogStep();
  const taskIds = loadHumanEvalSubset().map((t) => t.task_id);

  let hadFailure = false;

  for (const modelId of modelIds) {
    for (const taskId of taskIds) {
      try {
        const result = await runTaskStep(
          modelId,
          taskId,
          costByModelId[modelId],
        );
        await recordResultStep(runId, modelId, "humaneval", taskId, result);
      } catch (error) {
        hadFailure = true;
        await recordResultStep(runId, modelId, "humaneval", taskId, {
          passed: false,
          latencyMs: 0,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const status = hadFailure ? "failed" : "completed";
  await completeRunStep(
    runId,
    status,
    hadFailure
      ? "One or more tasks errored before grading -- see per-result error_message rows."
      : undefined,
  );

  return { runId, status, modelIds, taskCount: taskIds.length };
}
