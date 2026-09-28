ALTER TABLE "customer_contacts" ADD COLUMN "sms_opt_out_at" bigint;--> statement-breakpoint
ALTER TABLE "marketing_sends" ADD COLUMN "channel" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "marketing_sends" ADD CONSTRAINT "marketing_sends_channel" CHECK (channel IN ('email', 'sms'));