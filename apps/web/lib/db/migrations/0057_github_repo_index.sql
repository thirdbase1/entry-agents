DO $$ BEGIN
 CREATE TABLE IF NOT EXISTS "github_repo_index" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "installation_id" integer NOT NULL,
  "repos" jsonb NOT NULL,
  "fetched_at" timestamp DEFAULT now() NOT NULL
 );
EXCEPTION
 WHEN duplicate_table THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "github_repo_index_user_installation_idx" ON "github_repo_index" USING btree ("user_id", "installation_id");
