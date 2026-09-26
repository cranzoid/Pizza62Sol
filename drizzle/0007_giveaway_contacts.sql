CREATE TABLE "customer_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"phone" text,
	"name" text DEFAULT '' NOT NULL,
	"birth_month" integer,
	"birth_day" integer,
	"source" text NOT NULL,
	"notes" text,
	"last_visit_at" bigint,
	"marketing_opt_out_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "customer_contacts_source" CHECK (source IN ('import', 'till', 'unsubscribe')),
	CONSTRAINT "customer_contacts_identity" CHECK (email IS NOT NULL OR phone IS NOT NULL),
	CONSTRAINT "customer_contacts_birthday" CHECK ((birth_month IS NULL AND birth_day IS NULL)
          OR (birth_month BETWEEN 1 AND 12 AND birth_day BETWEEN 1 AND 31))
);
--> statement-breakpoint
CREATE TABLE "giveaway_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"giveaway_id" text NOT NULL,
	"entry_number" integer NOT NULL,
	"order_id" text NOT NULL,
	"customer_name" text NOT NULL,
	"customer_email" text DEFAULT '' NOT NULL,
	"customer_phone" text DEFAULT '' NOT NULL,
	"qualifying_cents" integer NOT NULL,
	"picked_at" bigint,
	"picked_by" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "giveaway_entries_number_positive" CHECK (entry_number > 0),
	CONSTRAINT "giveaway_entries_cents_nonneg" CHECK (qualifying_cents >= 0)
);
--> statement-breakpoint
CREATE TABLE "marketing_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign" text NOT NULL,
	"nudge" text NOT NULL,
	"recipient_count" integer NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"per_day" integer NOT NULL,
	"first_send_at" bigint,
	"last_send_at" bigint,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "marketing_sends_counts_nonneg" CHECK (recipient_count >= 0 AND skipped_count >= 0),
	CONSTRAINT "marketing_sends_per_day_positive" CHECK (per_day > 0)
);
--> statement-breakpoint
ALTER TABLE "giveaway_entries" ADD CONSTRAINT "giveaway_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_contacts_email_uq" ON "customer_contacts" USING btree ("email") WHERE "customer_contacts"."email" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customer_contacts_phone_idx" ON "customer_contacts" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "giveaway_entries_number_uq" ON "giveaway_entries" USING btree ("giveaway_id","entry_number");--> statement-breakpoint
CREATE UNIQUE INDEX "giveaway_entries_order_uq" ON "giveaway_entries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "giveaway_entries_email_idx" ON "giveaway_entries" USING btree ("customer_email");--> statement-breakpoint
CREATE INDEX "marketing_sends_campaign_idx" ON "marketing_sends" USING btree ("campaign","created_at");