ALTER TABLE "chats" ALTER COLUMN "model_id" SET DEFAULT 'deepseek-v4-flash';--> statement-breakpoint
ALTER TABLE "user_preferences" ALTER COLUMN "default_model_id" SET DEFAULT 'deepseek-v4-flash';--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "auto_approve_tools_override" boolean;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "auto_approve_tools" boolean DEFAULT false NOT NULL;
