ALTER TABLE "customer_contacts" ADD COLUMN "legacy_json" text;--> statement-breakpoint
ALTER TABLE "marketing_sends" ADD COLUMN "interval_minutes" integer;--> statement-breakpoint
ALTER TABLE "marketing_sends" ADD COLUMN "audience_source" text DEFAULT 'all' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_sends" ADD COLUMN "send_mode" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_sends" ADD COLUMN "request_key" text;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "provider_reference" text;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "delivery_status" text;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD COLUMN "delivery_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_sends_request_uq" ON "marketing_sends" USING btree ("request_key") WHERE "marketing_sends"."request_key" IS NOT NULL;