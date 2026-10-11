CREATE TABLE "entity_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"grantee_email" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"token_hash" text,
	"token_expires_at" timestamp with time zone,
	"accepted_user_id" text,
	"accepted_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "export_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"storage_key" text,
	"size_bytes" bigint,
	"document_count" integer DEFAULT 0 NOT NULL,
	"summary" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "entity_shares" ADD CONSTRAINT "entity_shares_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_shares" ADD CONSTRAINT "entity_shares_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_shares" ADD CONSTRAINT "entity_shares_accepted_user_id_user_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_archives" ADD CONSTRAINT "export_archives_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_shares_owner_idx" ON "entity_shares" USING btree ("owner_id","entity_id");--> statement-breakpoint
CREATE INDEX "entity_shares_grantee_idx" ON "entity_shares" USING btree ("accepted_user_id");--> statement-breakpoint
CREATE INDEX "entity_shares_email_idx" ON "entity_shares" USING btree ("grantee_email");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_shares_token_idx" ON "entity_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_shares_active_idx" ON "entity_shares" USING btree ("entity_id","grantee_email") WHERE "entity_shares"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "export_archives_owner_idx" ON "export_archives" USING btree ("owner_id","created_at");