CREATE TABLE "platform_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"free_tier_enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"updated_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;