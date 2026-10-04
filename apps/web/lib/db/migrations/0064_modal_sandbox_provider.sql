-- 0064: Modal Sandbox becomes the default sandbox provider.
--
-- Mirrors 0018_remove_hybrid_sandbox and 0058_boat_default_sandbox: the
-- provider discriminator lives inside sessions.sandbox_state (jsonb) and
-- the preference column, so switching the default is a data migration,
-- not a schema change.
--
-- WHY THERE IS NO WORKSPACE MIGRATION
--
-- Every previous provider transition had to carry the working tree
-- across: Vercel stopped destroying it, Boat snapshotted it, and both
-- paid for it with a pack/restore step (packages/sandbox/migrate.ts) and
-- a window where the session had no sandbox at all.
--
-- Modal's workspace lives on a Volume -- an attachable store that
-- outlives any container. A sandbox is capped at 24h, but the Volume is
-- not, so when the recorded sandbox is gone the next connect() provisions
-- a fresh sandbox that remounts the same volume and sees every byte.
-- "Migration" is therefore already automatic and free: there is nothing
-- to pack, nothing to restore, and no window without a sandbox beyond
-- the container boot itself.
--
-- What this migration actually does:
--   1. New preference rows default to modal, and every stored preference
--      still pointing at vercel or boat moves over. The registry throws
--      UnsupportedSandboxProviderError for unknown providers and never
--      silently substitutes one, so leaving "vercel"/"boat" preferences
--      behind would wedge those users' next session rather than migrate
--      it.
--   2. Existing sessions point at modal. Their sandbox_state is rebuilt
--      rather than jsonb_set-ing {type}: vercel/boat identity
--      (sandboxName, sandboxId, snapshotId, expiresAt, persistent) is
--      meaningless to Modal, whose durable identity is the volumeName
--      derived from the session id. `source` is dropped on purpose --
--      provisioning re-derives it from cloneUrl/branch/isNewBranch on
--      the session row, so the workspace is re-cloned onto the fresh
--      volume on the next connect.
--   3. Vercel snapshot handles are cleared; they cannot restore a Modal
--      sandbox.

ALTER TABLE "user_preferences" ALTER COLUMN "default_sandbox_type" SET DEFAULT 'modal';--> statement-breakpoint
UPDATE "user_preferences"
SET "default_sandbox_type" = 'modal'
WHERE "default_sandbox_type" IN ('vercel', 'boat');--> statement-breakpoint
UPDATE "sessions"
SET "sandbox_state" = jsonb_build_object(
      'type', 'modal',
      'volumeName', 'entry-workspace-' || "sessions"."id"
    ),
    "snapshot_url" = NULL,
    "snapshot_created_at" = NULL,
    "snapshot_size_bytes" = NULL
WHERE "sessions"."sandbox_state" IS NOT NULL
  AND "sessions"."sandbox_state"->>'type' IN ('vercel', 'boat');
