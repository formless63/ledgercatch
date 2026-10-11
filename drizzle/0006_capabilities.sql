CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"category_id" uuid,
	"period" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"threshold_pct" integer DEFAULT 80 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"alerted_period" text,
	"alerted_level" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flag" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"default_value" boolean DEFAULT false NOT NULL,
	"rollout_basis_points" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "feature_flag_revision" CHECK ("feature_flag"."revision">0),
	CONSTRAINT "feature_flag_rollout" CHECK ("feature_flag"."rollout_basis_points" IS NULL OR "feature_flag"."rollout_basis_points" BETWEEN 0 AND 10000)
);
--> statement-breakpoint
CREATE TABLE "feature_flag_override" (
	"id" uuid PRIMARY KEY NOT NULL,
	"flag_key" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"value" boolean NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "feature_flag_override_kind" CHECK ("feature_flag_override"."target_kind" IN ('user','tenant'))
);
--> statement-breakpoint
CREATE TABLE "invoice_ninja_binding" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope_kind" varchar(6) NOT NULL,
	"scope_id" varchar(128) NOT NULL,
	"local_resource_id" varchar(128) NOT NULL,
	"connection_id" varchar(64) NOT NULL,
	"resource_kind" varchar(7) NOT NULL,
	"remote_id" varchar(128) NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"retired_at" timestamp (3) with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp (3) with time zone,
	CONSTRAINT "invoice_ninja_binding_scope" CHECK ("invoice_ninja_binding"."scope_kind" in ('user','tenant')),
	CONSTRAINT "invoice_ninja_binding_kind" CHECK ("invoice_ninja_binding"."resource_kind" in ('client','invoice'))
);
--> statement-breakpoint
CREATE TABLE "invoice_ninja_claim_drafts" (
	"claim_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"paid_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_ninja_claim_settings" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"auto_draft" boolean DEFAULT false NOT NULL,
	"policy" jsonb,
	"webhook_secret_ciphertext" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_ninja_client" (
	"binding_id" uuid PRIMARY KEY NOT NULL,
	"synced_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_ninja_inbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" varchar(64) NOT NULL,
	"event_kind" varchar(24) NOT NULL,
	"body_sha256" varchar(64) NOT NULL,
	"remote_hint" varchar(128) NOT NULL,
	"binding_id" uuid,
	"state" varchar(12) NOT NULL,
	"received_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp (3) with time zone,
	"error_code" varchar(24),
	CONSTRAINT "invoice_ninja_inbox_state" CHECK ("invoice_ninja_inbox"."state" in ('received','processing','processed','ignored','failed'))
);
--> statement-breakpoint
CREATE TABLE "invoice_ninja_invoice" (
	"binding_id" uuid PRIMARY KEY NOT NULL,
	"number" varchar(128),
	"status" varchar(12) NOT NULL,
	"currency" varchar(3),
	"amount" varchar(35),
	"balance" varchar(35),
	"source_updated_at" timestamp (3) with time zone,
	"synced_at" timestamp (3) with time zone NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "invoice_ninja_invoice_status" CHECK ("invoice_ninja_invoice"."status" in ('draft','sent','partial','paid','cancelled','reversed','deleted','unknown'))
);
--> statement-breakpoint
CREATE TABLE "invoice_ninja_operation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope_kind" varchar(6) NOT NULL,
	"scope_id" varchar(128) NOT NULL,
	"actor_user_id" varchar(128) NOT NULL,
	"connection_id" varchar(64) NOT NULL,
	"kind" varchar(24) NOT NULL,
	"status" varchar(24) NOT NULL,
	"binding_id" uuid,
	"caller_key" varchar(128) NOT NULL,
	"digest" varchar(64) NOT NULL,
	"intent" jsonb,
	"remote_id" varchar(128),
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"first_dispatch_at" timestamp (3) with time zone,
	"lease_token" uuid,
	"lease_until" timestamp (3) with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(24),
	CONSTRAINT "invoice_ninja_operation_status" CHECK ("invoice_ninja_operation"."status" in ('queued','dispatching','succeeded','failed','reconciliation_required','cancelled')),
	CONSTRAINT "invoice_ninja_operation_kind" CHECK ("invoice_ninja_operation"."kind" in ('create_draft','reconcile_client','reconcile_invoice'))
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"channels" jsonb DEFAULT '{"inApp":true,"email":false,"ntfy":false}'::jsonb NOT NULL,
	"ntfy_topic" text,
	"digest_enabled" boolean DEFAULT true NOT NULL,
	"digest_hour" integer DEFAULT 8 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"alerts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_digest_date" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recipient_id" varchar(128) NOT NULL,
	"type" varchar(128) NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"read_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "paperless_pushes" (
	"source_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"task_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pushed_at" timestamp with time zone,
	CONSTRAINT "paperless_pushes_source_id_document_id_pk" PRIMARY KEY("source_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"last_outcome" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flag_override" ADD CONSTRAINT "feature_flag_override_flag_key_feature_flag_key_fk" FOREIGN KEY ("flag_key") REFERENCES "public"."feature_flag"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_ninja_claim_drafts" ADD CONSTRAINT "invoice_ninja_claim_drafts_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_ninja_claim_drafts" ADD CONSTRAINT "invoice_ninja_claim_drafts_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_ninja_claim_drafts" ADD CONSTRAINT "invoice_ninja_claim_drafts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_ninja_claim_settings" ADD CONSTRAINT "invoice_ninja_claim_settings_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_ninja_claim_settings" ADD CONSTRAINT "invoice_ninja_claim_settings_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_ninja_client" ADD CONSTRAINT "invoice_ninja_client_binding_id_invoice_ninja_binding_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."invoice_ninja_binding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_ninja_inbox" ADD CONSTRAINT "invoice_ninja_inbox_binding_id_invoice_ninja_binding_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."invoice_ninja_binding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_ninja_invoice" ADD CONSTRAINT "invoice_ninja_invoice_binding_id_invoice_ninja_binding_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."invoice_ninja_binding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_ninja_operation" ADD CONSTRAINT "invoice_ninja_operation_binding_id_invoice_ninja_binding_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."invoice_ninja_binding"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_pushes" ADD CONSTRAINT "paperless_pushes_source_id_ingress_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."ingress_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_pushes" ADD CONSTRAINT "paperless_pushes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paperless_pushes" ADD CONSTRAINT "paperless_pushes_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budgets_owner_idx" ON "budgets" USING btree ("owner_id","entity_id");--> statement-breakpoint
CREATE INDEX "feature_flag_created" ON "feature_flag" USING btree ("created_at","key");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flag_override_target" ON "feature_flag_override" USING btree ("flag_key","target_kind","target_id");--> statement-breakpoint
CREATE INDEX "feature_flag_override_created" ON "feature_flag_override" USING btree ("flag_key","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_ninja_binding_local" ON "invoice_ninja_binding" USING btree ("scope_kind","scope_id","resource_kind","local_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_ninja_binding_remote" ON "invoice_ninja_binding" USING btree ("connection_id","resource_kind","remote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_ninja_claim_drafts_operation_idx" ON "invoice_ninja_claim_drafts" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "invoice_ninja_claim_settings_owner_idx" ON "invoice_ninja_claim_settings" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_ninja_receipt_identity" ON "invoice_ninja_inbox" USING btree ("connection_id","event_kind","body_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_ninja_operation_key" ON "invoice_ninja_operation" USING btree ("scope_kind","scope_id","connection_id","kind","caller_key");--> statement-breakpoint
CREATE INDEX "invoice_ninja_operation_recovery" ON "invoice_ninja_operation" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "notification_recipient_time_idx" ON "notification" USING btree ("recipient_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_recipient_read_idx" ON "notification" USING btree ("recipient_id","read_at","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_recipient_type_idx" ON "notification" USING btree ("recipient_id","type","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_endpoints_owner_idx" ON "webhook_endpoints" USING btree ("owner_id");