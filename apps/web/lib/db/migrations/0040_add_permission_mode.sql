ALTER TABLE "sessions" ADD COLUMN "permission_mode_override" text;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "default_permission_mode" text DEFAULT 'ask' NOT NULL;
-- Backfill from the deprecated booleans so existing sessions/users keep
-- their current effective behavior after the switch to the 3-way enum.
UPDATE "sessions" SET "permission_mode_override" = 'fullAccess' WHERE "auto_approve_tools_override" = true;
UPDATE "sessions" SET "permission_mode_override" = 'ask' WHERE "auto_approve_tools_override" = false;
UPDATE "user_preferences" SET "default_permission_mode" = 'fullAccess' WHERE "auto_approve_tools" = true;
