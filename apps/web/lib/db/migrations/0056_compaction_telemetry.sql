DO $$ BEGIN
 CREATE TABLE IF NOT EXISTS "compaction_events" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "chat_id" text,
  "session_id" text,
  "model_id" text,
  "pre_compact_tokens" integer NOT NULL,
  "post_compact_tokens" integer NOT NULL,
  "context_window_tokens" integer NOT NULL,
  "threshold" real NOT NULL,
  "compacted_tool_calls" integer DEFAULT 0 NOT NULL,
  "compacted_anonymous_tool_results" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
 );
EXCEPTION
 WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "compaction_events_created_at_idx" ON "compaction_events" USING btree ("created_at");
CREATE INDEX IF NOT EXISTS "compaction_events_chat_id_idx" ON "compaction_events" USING btree ("chat_id");
