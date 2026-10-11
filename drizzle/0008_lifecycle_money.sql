CREATE TABLE "asset_documents" (
	"asset_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_documents_asset_id_document_id_pk" PRIMARY KEY("asset_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"order_id" uuid,
	"order_item_id" uuid,
	"entity_id" uuid,
	"name" text NOT NULL,
	"serial" text,
	"purchase_date" date,
	"warranty_months" integer,
	"warranty_expires_at" date,
	"location" text,
	"notes" text,
	"status" text DEFAULT 'in_service' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_links" (
	"document_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_links_document_id_order_id_pk" PRIMARY KEY("document_id","order_id")
);
--> statement-breakpoint
CREATE TABLE "order_duplicate_dismissals" (
	"owner_id" text NOT NULL,
	"order_a_id" uuid NOT NULL,
	"order_b_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_duplicate_dismissals_order_a_id_order_b_id_pk" PRIMARY KEY("order_a_id","order_b_id")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"reason" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"refunded_at" date,
	"origin" text DEFAULT 'manual' NOT NULL,
	"external_refund_id" text,
	"capture_id" uuid,
	"document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_tracking" (
	"shipment_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"registered_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_status" text,
	"last_event_at" text,
	"last_event_text" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allocation_tax" (
	"allocation_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"treatment" text NOT NULL,
	"origin" text NOT NULL,
	"note" text,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_settings" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"reporting_currency" text,
	"tax_jurisdiction" text,
	"tax_business_type" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"date" date NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"rate" numeric(20, 10) NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_date_base_quote_pk" PRIMARY KEY("date","base","quote")
);
--> statement-breakpoint
CREATE TABLE "money_settings" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"reporting_currency" text DEFAULT 'USD' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statement_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"file_name" text NOT NULL,
	"format" text NOT NULL,
	"preset_id" text,
	"payment_method_id" uuid,
	"account_hint" text,
	"sha256" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"inserted_count" integer DEFAULT 0 NOT NULL,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"min_date" date,
	"max_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statement_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"import_id" uuid,
	"payment_method_id" uuid,
	"posted_date" date NOT NULL,
	"description" text NOT NULL,
	"merchant_key" text DEFAULT '' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"kind" text DEFAULT 'charge' NOT NULL,
	"status" text DEFAULT 'unmatched' NOT NULL,
	"external_id" text,
	"raw" jsonb NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"transaction_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" text DEFAULT 'single' NOT NULL,
	"group_key" text,
	"score" real NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"reasons" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("title", '')), 'A') || setweight(to_tsvector('simple', coalesce(coalesce("sku", '') || ' ' || coalesce("variant", ''), '')), 'B')) STORED;--> statement-breakpoint
ALTER TABLE "asset_documents" ADD CONSTRAINT "asset_documents_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_documents" ADD CONSTRAINT "asset_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_links" ADD CONSTRAINT "document_links_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_duplicate_dismissals" ADD CONSTRAINT "order_duplicate_dismissals_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_duplicate_dismissals" ADD CONSTRAINT "order_duplicate_dismissals_order_a_id_orders_id_fk" FOREIGN KEY ("order_a_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_duplicate_dismissals" ADD CONSTRAINT "order_duplicate_dismissals_order_b_id_orders_id_fk" FOREIGN KEY ("order_b_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_capture_id_captures_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."captures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_tracking" ADD CONSTRAINT "shipment_tracking_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_tax" ADD CONSTRAINT "allocation_tax_allocation_id_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."allocations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_tax" ADD CONSTRAINT "allocation_tax_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_settings" ADD CONSTRAINT "entity_settings_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_settings" ADD CONSTRAINT "entity_settings_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_settings" ADD CONSTRAINT "money_settings_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_transactions" ADD CONSTRAINT "statement_transactions_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_transactions" ADD CONSTRAINT "statement_transactions_import_id_statement_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."statement_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_transactions" ADD CONSTRAINT "statement_transactions_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_matches" ADD CONSTRAINT "transaction_matches_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_matches" ADD CONSTRAINT "transaction_matches_transaction_id_statement_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."statement_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_matches" ADD CONSTRAINT "transaction_matches_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_documents_document_idx" ON "asset_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "assets_owner_idx" ON "assets" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "assets_owner_warranty_idx" ON "assets" USING btree ("owner_id","warranty_expires_at");--> statement-breakpoint
CREATE INDEX "assets_order_item_idx" ON "assets" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "document_links_order_idx" ON "document_links" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_duplicate_dismissals_b_idx" ON "order_duplicate_dismissals" USING btree ("order_b_id");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "refunds_owner_idx" ON "refunds" USING btree ("owner_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_order_external_idx" ON "refunds" USING btree ("order_id","external_refund_id");--> statement-breakpoint
CREATE INDEX "shipment_tracking_checked_idx" ON "shipment_tracking" USING btree ("last_checked_at");--> statement-breakpoint
CREATE INDEX "allocation_tax_owner_idx" ON "allocation_tax" USING btree ("owner_id","treatment");--> statement-breakpoint
CREATE INDEX "entity_settings_owner_idx" ON "entity_settings" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "fx_rates_pair_date_idx" ON "fx_rates" USING btree ("base","quote","date");--> statement-breakpoint
CREATE INDEX "statement_imports_owner_idx" ON "statement_imports" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_transactions_owner_hash_idx" ON "statement_transactions" USING btree ("owner_id","hash");--> statement-breakpoint
CREATE INDEX "statement_transactions_owner_date_idx" ON "statement_transactions" USING btree ("owner_id","posted_date");--> statement-breakpoint
CREATE INDEX "statement_transactions_owner_status_idx" ON "statement_transactions" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "statement_transactions_import_idx" ON "statement_transactions" USING btree ("import_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_matches_pair_idx" ON "transaction_matches" USING btree ("transaction_id","order_id");--> statement-breakpoint
CREATE INDEX "transaction_matches_owner_status_idx" ON "transaction_matches" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "transaction_matches_order_idx" ON "transaction_matches" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_search_vector_idx" ON "order_items" USING gin ("search_vector");