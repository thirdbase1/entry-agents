-- Make Boat the default sandbox provider for new AND existing sessions.
--
-- Mirrors 0018_remove_hybrid_sandbox: the provider discriminator lives
-- inside sessions.sandbox_state (jsonb) and the preference column, so
-- switching the default is a data migration, not a schema change.
--
-- 1. New preference rows default to boat, and every stored preference that
--    still says vercel is moved over (nobody could previously pick a
--    non-vercel provider, so this cannot overwrite a deliberate choice).
ALTER TABLE "user_preferences" ALTER COLUMN "default_sandbox_type" SET DEFAULT 'boat';--> statement-breakpoint
UPDATE "user_preferences"
SET "default_sandbox_type" = 'boat'
WHERE "default_sandbox_type" = 'vercel';--> statement-breakpoint
-- 2. Existing sessions move to boat. The object is rebuilt rather than
--    jsonb_set-ing {type}, because vercel-only identity (sandboxName,
--    expiresAt, persistent, snapshotId) is meaningless to Boat and would
--    otherwise be carried into the new provider's state. `source` is
--    intentionally dropped too -- provisioning re-derives it from
--    cloneUrl/branch/isNewBranch on the session row.
--    Vercel snapshot handles are cleared because they cannot restore a
--    Boat sandbox.
UPDATE "sessions"
SET "sandbox_state" = jsonb_build_object('type', 'boat'),
    "snapshot_url" = NULL,
    "snapshot_created_at" = NULL,
    "snapshot_size_bytes" = NULL
WHERE "sessions"."sandbox_state" IS NOT NULL
  AND "sessions"."sandbox_state"->>'type' = 'vercel';
