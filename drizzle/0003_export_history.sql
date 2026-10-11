ALTER TABLE "exports" DROP CONSTRAINT "exports_allocation_id_allocations_id_fk";
--> statement-breakpoint
ALTER TABLE "exports" ALTER COLUMN "allocation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "exports" ADD COLUMN "amount_minor" bigint;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exports" ADD CONSTRAINT "exports_allocation_id_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."allocations"("id") ON DELETE set null ON UPDATE no action;