import {
  completeBenchmarkRun,
  createBenchmarkRun,
  recordBenchmarkResult,
  type BenchmarkName,
} from "@/lib/db/benchmarks";
import type { AvailableModelCost } from "@/lib/models";
import { estimateModelUsageCost } from "@/lib/models";
import { fetchAvailableLanguageModelsWithContext } from "@/lib/models-with-context";
// Node-free -- safe to import statically even though this whole file's
// top-level workflow function body runs in the Workflow SDK's restricted
// bundle. `runHumanEvalTask` (which touches fs/child_process/sandbox) is
// intentionally NOT imported here -- see runTaskStep below, which loads
// it via a dynamic import() inside its own `"use step"` function instead.
import {
  TERMINAL_BENCH_TASK_ID,
  TERMINAL_BENCH_TASK_VERSION,
} from "@/lib/benchmarks/terminal-bench-smoke-task";

/**
 * Default set of models benchmarked when no explicit list is given.
 * Deliberately excludes claude-* (all routed through FreeModel's
 * cc.freemodel.dev passthrough -- see 2026-08-20 investigation into
 * gorouter/justwoker/FreeModel) and anything hard-blocked in code
 * (isModelHardBlocked in lib/model-availability.ts) -- a public
 * benchmark page shouldn't showcase a route Entry itself won't fully
 * stand behind.
 *
 * IDs must exactly match the gateway's route id (GET /v1/debug/routes /
 * /v1/models), NOT a display name or a guessed/legacy id -- entry-gateway
 * has no fuzzy matching, an unknown id 404s instantly with "No
 * openai-chat route is configured for <id>." Found 2026-08-21: this list
 * previously had THREE dead ids -- "ling-3.0" (real id is
 * "ling-3.0-flash-free"), "deepseek-v4-pro" and "gemini-2.5-pro" (neither
 * exists in the gateway at all, real Gemini ids are all "gemini-3.x-*")
 * -- silently producing a deterministic 0/20 for those three models on
 * every default/scheduled run with zero useful signal. Verified this
 * exact list against a live GET /v1/debug/routes dump before committing.
 */
const PREFERRED_BENCHMARK_MODEL_IDS = [
  "step-5-preview",
  "qwen3.8-flash:free",
  "mimo-v2.6-flash:free",
  "qwen3.8-max-free",
  "deepseek-v4-flash",
  "gemini-3.5-flash",
] as const;

interface TaskStepResult {
  passed: boolean;
  latencyMs: number;
  costMicros?: number;
  errorMessage?: string;
}

async function createRunStep(
  modelIds: string[],
  triggeredBy: string | undefined,
): Promise<string> {
  "use step";
  return createBenchmarkRun({
    suiteVersion: TERMINAL_BENCH_TASK_VERSION,
    modelIds,
    ...(triggeredBy ? { triggeredBy } : {}),
  });
}

/** Returns a plain, JSON-serializable modelId -> cost map (crosses a step boundary). */
async function loadCostCatalogStep(): Promise<{
  costByModelId: Record<string, AvailableModelCost | undefined>;
  availableModelIds: string[];
}> {
  "use step";
  const catalog = await fetchAvailableLanguageModelsWithContext();
  const costByModelId: Record<string, AvailableModelCost | undefined> = {};
  for (const model of catalog) {
    costByModelId[model.id] = model.cost;
  }
  return { costByModelId, availableModelIds: catalog.map((model) => model.id) };
}

function selectDefaultBenchmarkModels(availableModelIds: string[]): string[] {
  const preferred = PREFERRED_BENCHMARK_MODEL_IDS.filter((id) =>
    availableModelIds.includes(id),
  );
  if (preferred.length > 0) return preferred;
  return availableModelIds.slice(0, 6);
}

/**
 * Runs a single HumanEval task through the real agent harness. This is
 * the durable unit of retry/resumption for the whole suite -- if the
 * workflow run is interrupted, only the in-flight task is redone, not
 * every task before it (already-recorded results stay in the DB).
 */
interface BenchmarkTurnStepResult {
  transcript: import("ai").ModelMessage[];
  usage?: import("ai").LanguageModelUsage;
  done: boolean;
  errorMessage?: string;
}

async function runBenchmarkTurnStep(
  modelId: string,
  runId: string,
  messages: import("ai").ModelMessage[],
  firstTurn: boolean,
  previousUsage?: import("ai").LanguageModelUsage,
): Promise<BenchmarkTurnStepResult> {
  "use step";
  const { runTerminalBenchTurn } =
    await import("@/lib/benchmarks/terminal-bench-runner");
  return runTerminalBenchTurn(
    modelId,
    runId,
    messages,
    firstTurn,
    previousUsage,
  );
}

async function verifyBenchmarkTaskStep(
  modelId: string,
  runId: string,
  usage: import("ai").LanguageModelUsage | undefined,
  transcript: import("ai").ModelMessage[],
  startedAt: number,
  cost: AvailableModelCost | undefined,
): Promise<TaskStepResult> {
  "use step";
  const { verifyTerminalBenchTask } =
    await import("@/lib/benchmarks/terminal-bench-runner");
  const result = await verifyTerminalBenchTask(
    modelId,
    runId,
    usage,
    transcript,
    startedAt,
  );
  let costMicros: number | undefined;
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
    costMicros =
      dollarCost != null ? Math.round(dollarCost * 1_000_000) : undefined;
  }
  return {
    passed: result.passed,
    latencyMs: result.latencyMs,
    ...(costMicros != null ? { costMicros } : {}),
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
    ...(result.costMicros != null ? { costMicros: result.costMicros } : {}),
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
 * Durable Vercel Workflow that runs the modern Terminal-Bench smoke track
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
  modelIds?: string[],
  triggeredBy?: string,
): Promise<RunBenchmarkSuiteResult> {
  "use workflow";

  const catalog = await loadCostCatalogStep();
  const selectedModelIds = modelIds?.length
    ? Array.from(new Set(modelIds))
    : selectDefaultBenchmarkModels(catalog.availableModelIds);
  const runId = await createRunStep(selectedModelIds, triggeredBy);
  const costByModelId = catalog.costByModelId;
  const taskIds = [TERMINAL_BENCH_TASK_ID];

  let hadFailure = false;

  for (const modelId of selectedModelIds) {
    // costByModelId's keys ARE the live gateway catalog (populated 1:1
    // from fetchModelCostCatalog() in loadCostCatalogStep) -- checking
    // membership here, not just a truthy cost value (a real model can
    // legitimately have no cost data), catches a typo'd/stale/nonexistent
    // model id in one place instead of burning 20 identical per-task
    // "No openai-chat route is configured for <id>" failures. Added
    // 2026-08-21 after DEFAULT_BENCHMARK_MODEL_IDS itself shipped with
    // three dead ids that silently 0/20'd on every run -- see that
    // constant's comment for the full story.
    const isKnownModel = Object.hasOwn(costByModelId, modelId);
    for (const taskId of taskIds) {
      if (!isKnownModel) {
        hadFailure = true;
        await recordResultStep(runId, modelId, "terminal_bench", taskId, {
          passed: false,
          latencyMs: 0,
          errorMessage: `Unknown model id "${modelId}" -- not present in the live gateway catalog (GET /v1/models). Check for a typo or a stale/legacy id.`,
        });
        continue;
      }
      try {
        const startedAt = Date.now();
        let transcript: import("ai").ModelMessage[] = [];
        let usage: import("ai").LanguageModelUsage | undefined;
        let done = false;
        let turnError: string | undefined;
        for (let turn = 0; turn < 10 && !done; turn++) {
          const next = await runBenchmarkTurnStep(
            modelId,
            runId,
            transcript,
            turn === 0,
            usage,
          );
          transcript = next.transcript;
          usage = next.usage;
          done = next.done;
          turnError = next.errorMessage;
          if (turnError) break;
        }
        const result = turnError
          ? {
              passed: false,
              latencyMs: Date.now() - startedAt,
              errorMessage: turnError,
            }
          : await verifyBenchmarkTaskStep(
              modelId,
              runId,
              usage,
              transcript,
              startedAt,
              costByModelId[modelId],
            );
        if (!result.passed) hadFailure = true;
        await recordResultStep(
          runId,
          modelId,
          "terminal_bench",
          taskId,
          result,
        );
      } catch (error) {
        hadFailure = true;
        await recordResultStep(runId, modelId, "terminal_bench", taskId, {
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

  return {
    runId,
    status,
    modelIds: selectedModelIds,
    taskCount: taskIds.length,
  };
}
