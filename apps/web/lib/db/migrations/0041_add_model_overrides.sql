CREATE TABLE "model_overrides" (
	"model_id" text PRIMARY KEY NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_overrides" ADD CONSTRAINT "model_overrides_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;