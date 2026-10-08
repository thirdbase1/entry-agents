-- 0065: boxd becomes the default sandbox provider.
ALTER TABLE "user_preferences" ALTER COLUMN "default_sandbox_type" SET DEFAULT 'boxd';
UPDATE "user_preferences" SET "default_sandbox_type" = 'boxd' WHERE "default_sandbox_type" IN ('modal', 'vercel', 'boat');
