CREATE TABLE "capture_retention_settings" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"compaction_enabled" boolean DEFAULT true NOT NULL,
	"keep_raw_days" integer,
	"compact_min_bytes" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parser_reparse_progress" (
	"parser_id" text PRIMARY KEY NOT NULL,
	"target_version" integer NOT NULL,
	"cursor_received_at" timestamp with time zone,
	"cursor_id" uuid,
	"requeued" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capture_retention_settings" ADD CONSTRAINT "capture_retention_settings_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;