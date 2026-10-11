CREATE TABLE "enrichment_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"external_order_id" text NOT NULL,
	"url" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"header_signature" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"document_id" uuid,
	"file_name" text NOT NULL,
	"source" text DEFAULT 'generic' NOT NULL,
	"template_id" uuid,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"preview" jsonb,
	"mapping" jsonb,
	"row_count" integer DEFAULT 0 NOT NULL,
	"orders_created" integer DEFAULT 0 NOT NULL,
	"orders_updated" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ingress_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"secret_ciphertext" text,
	"cursor" jsonb,
	"enabled" text DEFAULT 'on' NOT NULL,
	"interval_minutes" integer DEFAULT 10 NOT NULL,
	"status" text DEFAULT 'untested' NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_error" text,
	"push_token_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "channel" text DEFAULT 'extension' NOT NULL;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "enrichment_tasks" ADD CONSTRAINT "enrichment_tasks_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_tasks" ADD CONSTRAINT "enrichment_tasks_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_templates" ADD CONSTRAINT "import_templates_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_template_id_import_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."import_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingress_sources" ADD CONSTRAINT "ingress_sources_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enrichment_order_kind_idx" ON "enrichment_tasks" USING btree ("order_id","kind");--> statement-breakpoint
CREATE INDEX "enrichment_owner_status_idx" ON "enrichment_tasks" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "import_templates_owner_idx" ON "import_templates" USING btree ("owner_id","header_signature");--> statement-breakpoint
CREATE INDEX "imports_owner_idx" ON "imports" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "ingress_sources_owner_idx" ON "ingress_sources" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingress_sources_push_token_idx" ON "ingress_sources" USING btree ("push_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "captures_owner_channel_ref_idx" ON "captures" USING btree ("owner_id","channel","source_ref");