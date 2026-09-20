-- Gift cards.
--
-- Generated from db/schema.ts. Three new tables and two new columns on
-- `orders`, and every one of them follows from a single decision: **a gift card
-- is a tender, not a discount.** It pays a bill; it does not reduce one.
--
-- That is a tax fact before it is a design one. In Canada the sale of a gift
-- card is not a taxable supply — no HST is charged when the card is bought — and
-- HST is charged in full when the card is *spent*, on the food. So a redemption
-- can never touch `subtotal_cents`, `tax_cents` or `total_cents`; it is recorded
-- alongside them in `gift_card_applied_cents`, and what the customer's card is
-- actually charged is the difference. Folding it into `discount_cents` instead
-- would have quietly under-collected HST on every order a gift card touched.
--
-- Additive and safe to apply under load. The two new `orders` columns default,
-- so a revision running the previous code keeps inserting valid rows throughout
-- the slot swap. `orders_money_nonneg` is dropped and re-added only to bring the
-- new column inside it — the predicate is otherwise unchanged, and the table is
-- small enough that the validation scan is imperceptible.
--
-- `gift_cards.code_hash` is a SHA-256 digest and there is no column anywhere
-- holding a spendable code: a dump of this database contains no money.
-- `gift_cards_purchase_never_expires` is Ontario's Consumer Protection Act
-- written as a constraint rather than left to application code — a purchased
-- single-merchant gift card cannot carry an expiry date, and only a free
-- promotional card may.

CREATE TABLE "gift_card_purchases" (
	"id" text PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"buyer_name" text NOT NULL,
	"buyer_email" text NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_email" text NOT NULL,
	"message" text,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text,
	"idempotency_key" text NOT NULL,
	"failure_reason" text,
	"attribution_json" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "gift_card_purchases_status" CHECK (status IN ('awaiting_payment', 'paid', 'cancelled', 'failed')),
	CONSTRAINT "gift_card_purchases_amount_positive" CHECK (amount_cents > 0)
);
--> statement-breakpoint
CREATE TABLE "gift_card_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"gift_card_id" text NOT NULL,
	"type" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"balance_after_cents" integer NOT NULL,
	"order_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"note" text,
	"created_at" bigint NOT NULL,
	CONSTRAINT "gift_card_tx_type" CHECK (type IN ('issue', 'hold', 'capture', 'release', 'adjust', 'void')),
	CONSTRAINT "gift_card_tx_actor" CHECK (actor_type IN ('customer', 'staff', 'system')),
	CONSTRAINT "gift_card_tx_balance_nonneg" CHECK (balance_after_cents >= 0)
);
--> statement-breakpoint
CREATE TABLE "gift_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"code_suffix" text NOT NULL,
	"initial_cents" integer NOT NULL,
	"balance_cents" integer NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"origin" text NOT NULL,
	"purchase_id" text,
	"recipient_name" text NOT NULL,
	"recipient_email" text NOT NULL,
	"sender_name" text NOT NULL,
	"message" text,
	"expires_at" bigint,
	"issued_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "gift_cards_status" CHECK (status IN ('active', 'voided')),
	CONSTRAINT "gift_cards_origin" CHECK (origin IN ('purchase', 'staff_issue')),
	CONSTRAINT "gift_cards_initial_positive" CHECK (initial_cents > 0),
	CONSTRAINT "gift_cards_balance_nonneg" CHECK (balance_cents >= 0),
	CONSTRAINT "gift_cards_purchase_never_expires" CHECK (origin <> 'purchase' OR expires_at IS NULL)
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_money_nonneg";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gift_card_applied_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "gift_card_id" text;--> statement-breakpoint
ALTER TABLE "gift_card_transactions" ADD CONSTRAINT "gift_card_transactions_gift_card_id_gift_cards_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "gift_card_transactions" ADD CONSTRAINT "gift_card_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_purchase_id_gift_card_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."gift_card_purchases"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "gift_card_purchases_reference_uq" ON "gift_card_purchases" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_card_purchases_idempotency_uq" ON "gift_card_purchases" USING btree ("idempotency_key") WHERE "gift_card_purchases"."status" <> 'failed';--> statement-breakpoint
CREATE INDEX "gift_card_purchases_provider_ref_idx" ON "gift_card_purchases" USING btree ("provider_reference");--> statement-breakpoint
CREATE INDEX "gift_card_purchases_created_idx" ON "gift_card_purchases" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "gift_card_tx_card_idx" ON "gift_card_transactions" USING btree ("gift_card_id","created_at");--> statement-breakpoint
CREATE INDEX "gift_card_tx_order_idx" ON "gift_card_transactions" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_cards_code_hash_uq" ON "gift_cards" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "gift_cards_suffix_idx" ON "gift_cards" USING btree ("code_suffix");--> statement-breakpoint
CREATE INDEX "gift_cards_recipient_idx" ON "gift_cards" USING btree ("recipient_email");--> statement-breakpoint
CREATE INDEX "gift_cards_status_idx" ON "gift_cards" USING btree ("status");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_gift_card_id_gift_cards_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_gift_card_consistent" CHECK (gift_card_applied_cents <= total_cents
          AND (gift_card_applied_cents = 0 OR gift_card_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_money_nonneg" CHECK (subtotal_cents >= 0 AND discount_cents >= 0 AND tax_cents >= 0 AND delivery_fee_cents >= 0 AND tip_cents >= 0 AND total_cents >= 0 AND gift_card_applied_cents >= 0);