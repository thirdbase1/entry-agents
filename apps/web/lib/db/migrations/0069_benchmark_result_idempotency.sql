DELETE FROM "benchmark_results" older
USING "benchmark_results" newer
WHERE older."run_id" = newer."run_id"
  AND older."model_id" = newer."model_id"
  AND older."benchmark" = newer."benchmark"
  AND older."task_id" = newer."task_id"
  AND older."id" > newer."id";
CREATE UNIQUE INDEX "benchmark_results_run_model_benchmark_task_idx"
  ON "benchmark_results" ("run_id", "model_id", "benchmark", "task_id");
