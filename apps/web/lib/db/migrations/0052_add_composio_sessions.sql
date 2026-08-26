CREATE TABLE "composio_sessions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "composio_sessions" ADD CONSTRAINT "composio_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;