ALTER TABLE "users" ADD COLUMN "billing_accrued_micros" integer NOT NULL DEFAULT 0;
CREATE TABLE "billing_usage_events" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "reference" text NOT NULL,
  "cost_micros" integer NOT NULL,
  "model_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "billing_usage_events_user_reference_idx" ON "billing_usage_events" ("user_id", "reference");
CREATE INDEX "billing_usage_events_user_id_idx" ON "billing_usage_events" ("user_id");
