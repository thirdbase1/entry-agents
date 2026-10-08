-- 0066: Workspace is the visible default for every existing preference.
ALTER TABLE "user_preferences" ALTER COLUMN "default_sandbox_type" SET DEFAULT 'boxd';
UPDATE "user_preferences" SET "default_sandbox_type" = 'boxd' WHERE "default_sandbox_type" <> 'boxd';
