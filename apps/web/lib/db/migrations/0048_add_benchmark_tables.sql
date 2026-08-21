CREATE TABLE "benchmark_results" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"model_id" text NOT NULL,
	"benchmark" text NOT NULL,
	"task_id" text NOT NULL,
	"passed" boolean NOT NULL,
	"latency_ms" integer,
	"cost_cents" integer,
	"error_message" text,
	"transcript_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"suite_version" text NOT NULL,
	"model_ids" jsonb NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp,
	"triggered_by" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "benchmark_results" ADD CONSTRAINT "benchmark_results_run_id_benchmark_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."benchmark_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "benchmark_results_run_id_idx" ON "benchmark_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "benchmark_results_model_id_idx" ON "benchmark_results" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "benchmark_results_benchmark_idx" ON "benchmark_results" USING btree ("benchmark");--> statement-breakpoint
CREATE INDEX "benchmark_runs_status_idx" ON "benchmark_runs" USING btree ("status");