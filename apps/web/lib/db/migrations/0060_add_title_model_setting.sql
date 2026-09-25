-- Make the chat-title generation model admin-configurable.
--
-- It was hardcoded in app/api/generate-title/route.ts and has been
-- through deepseek-v4-flash, qwen3.8-flash and others; each time the
-- gateway dropped that route, title generation silently 404'd and the
-- catch swallowed it. Storing the choice in platform_settings lets an
-- admin swap it from Settings > Admin > Models with no deploy.
--
-- NULL means "use the code fallback" (step-5-preview), so this is
-- backwards compatible with the existing singleton row.

ALTER TABLE "platform_settings" ADD COLUMN "title_model_id" text;
