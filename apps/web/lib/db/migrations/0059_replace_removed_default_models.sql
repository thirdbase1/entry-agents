-- Replace default model ids that no longer exist on the gateway.
--
-- Verified 2026-09-25 against GET /api/models on the live deployment: the
-- gateway serves exactly three ids -- step-5-preview, qwen3.8-flash:free,
-- mimo-v2.6-flash:free. gpt-5.6-sol and gpt-5.6-luna were removed more
-- than a month ago, so any stored selection of either one made the next
-- turn fail with "No openai-chat route is configured for <id>" (observed
-- for both the chat turn and generate-title), and the assistant message
-- badge kept rendering a model that was never called.
--
-- Free-plan users are unaffected by the stored value: the billing gate in
-- app/workflows/chat.ts pins them to FREE_PLAN_MODEL_ID
-- (qwen3.8-flash:free) regardless of what is stored here.
--
-- Historical usage rows (usage_by_day.model_id, ledger rows) are
-- deliberately NOT rewritten -- they record what actually ran and must
-- stay accurate for cost reporting.

ALTER TABLE "chats" ALTER COLUMN "model_id" SET DEFAULT 'step-5-preview';--> statement-breakpoint
ALTER TABLE "user_preferences" ALTER COLUMN "default_model_id" SET DEFAULT 'step-5-preview';--> statement-breakpoint
UPDATE "chats"
SET "model_id" = 'step-5-preview'
WHERE "model_id" IN ('gpt-5.6-sol', 'gpt-5.6-luna');--> statement-breakpoint
UPDATE "user_preferences"
SET "default_model_id" = 'step-5-preview'
WHERE "default_model_id" IN ('gpt-5.6-sol', 'gpt-5.6-luna');
