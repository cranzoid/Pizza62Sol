-- H-14: relational integrity, as constraints rather than convention.
--
-- Generated from db/schema.ts. Three things land together because they are one
-- structural change: the foreign keys and check constraints the audit found
-- missing, `orders.channel` so in-store and phone orders are countable, and the
-- two new tables (store_closures, integration_secrets) that the closure and
-- credential features are built on.
--
-- Note that `orders.payment_status` and `orders.status` are different
-- vocabularies: an online order has status `awaiting_payment` while its payment
-- status is `awaiting_checkout`. Writing the wrong one here is how this file
-- failed the first time it was generated.
--
-- Additive and safe against a populated database, but it WILL fail rather than
-- silently truncate if existing rows violate a constraint - which is the point.

CREATE TABLE "integration_secrets" (
	"key" text PRIMARY KEY NOT NULL,
	"cipher_text" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"hint" text DEFAULT '' NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_closures" (
	"id" text PRIMARY KEY NOT NULL,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint NOT NULL,
	"scope" text DEFAULT 'both' NOT NULL,
	"reason" text NOT NULL,
	"customer_message" text,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "store_closures_scope" CHECK (scope IN ('both', 'pickup', 'delivery')),
	CONSTRAINT "store_closures_window" CHECK (ends_at > starts_at)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "channel" text DEFAULT 'online' NOT NULL;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN "min_subtotal_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN "fulfilment" text DEFAULT 'any' NOT NULL;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN "usage_limit" integer;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN "per_customer_limit" integer;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN "usage_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "store_closures_window_idx" ON "store_closures" USING btree ("starts_at","ends_at");--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_event_id_time_clock_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."time_clock_events"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_reviewer_id_staff_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "product_variations" ADD CONSTRAINT "product_variations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_profiles" ADD CONSTRAINT "staff_profiles_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "time_clock_events" ADD CONSTRAINT "time_clock_events_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "time_clock_state" ADD CONSTRAINT "time_clock_state_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_requests_reviewer_id_staff_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."staff_users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "timesheet_approvals" ADD CONSTRAINT "timesheet_approvals_staff_user_id_staff_users_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "orders_created_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_channel_idx" ON "orders" USING btree ("channel","created_at");--> statement-breakpoint
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_status" CHECK (status IN ('pending', 'approved', 'declined'));--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_flags" CHECK (active IN (0, 1));--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_rating_range" CHECK (overall_rating BETWEEN 1 AND 5);--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "outbox_status" CHECK (status IN ('waiting_payment', 'waiting_completion', 'pending', 'retrying', 'pending_provider_setup', 'sending', 'sent', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "outbox_attempts_nonneg" CHECK (attempt_count >= 0);--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_next_status" CHECK (next_status IN ('awaiting_payment', 'received', 'preparing', 'ready_for_pickup', 'out_for_delivery', 'completed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity" CHECK (quantity > 0);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_money_nonneg" CHECK (unit_price_cents >= 0 AND line_total_cents >= 0);--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_flags" CHECK (taxable IN (0, 1));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_status" CHECK (status IN ('awaiting_payment', 'received', 'preparing', 'ready_for_pickup', 'out_for_delivery', 'completed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_status" CHECK (payment_status IN ('awaiting_checkout', 'pending_at_store', 'paid', 'failed', 'expired', 'cancelled', 'refunded', 'partially_refunded'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_payment_method" CHECK (payment_method IN ('online', 'pay_at_store'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_fulfilment" CHECK (fulfilment IN ('pickup', 'delivery'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_channel" CHECK (channel IN ('online', 'phone', 'walk_in'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_schedule_type" CHECK (schedule_type IN ('asap', 'scheduled'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_money_nonneg" CHECK (subtotal_cents >= 0 AND discount_cents >= 0 AND tax_cents >= 0 AND delivery_fee_cents >= 0 AND tip_cents >= 0 AND total_cents >= 0);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_schedule_consistent" CHECK ((schedule_type = 'scheduled' AND scheduled_for IS NOT NULL) OR (schedule_type = 'asap' AND scheduled_for IS NULL));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_has_address" CHECK (fulfilment <> 'delivery' OR address_json IS NOT NULL);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_status" CHECK (status IN ('pending', 'captured', 'declined', 'failed', 'expired', 'refunded', 'partially_refunded'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_method" CHECK (method IN ('online', 'pay_at_store'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_nonneg" CHECK (amount_cents >= 0);--> statement-breakpoint
ALTER TABLE "product_variations" ADD CONSTRAINT "product_variations_price_nonneg" CHECK (base_price_cents >= 0 AND extra_topping_price_cents >= 0 AND included_topping_units_bps >= 0);--> statement-breakpoint
ALTER TABLE "product_variations" ADD CONSTRAINT "product_variations_flags" CHECK (active IN (0, 1));--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_price_nonneg" CHECK (base_price_cents >= 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_flags" CHECK (taxable IN (0, 1) AND pickup_eligible IN (0, 1) AND delivery_eligible IN (0, 1)
          AND halal_capable IN (0, 1) AND promotion_eligible IN (0, 1) AND active IN (0, 1)
          AND sold_out IN (0, 1) AND setup_required IN (0, 1));--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_type" CHECK (type IN ('percentage', 'fixed', 'free_delivery'));--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_fulfilment" CHECK (fulfilment IN ('any', 'pickup', 'delivery'));--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_amount_nonneg" CHECK (amount >= 0 AND min_subtotal_cents >= 0 AND usage_count >= 0);--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_limits" CHECK ((usage_limit IS NULL OR usage_limit > 0) AND (per_customer_limit IS NULL OR per_customer_limit > 0));--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_window" CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at);--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_flags" CHECK (combinable IN (0, 1) AND exclusive IN (0, 1) AND active IN (0, 1));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK (amount_cents > 0);--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_status" CHECK (status IN ('recorded', 'voided'));--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_window" CHECK (ends_at > starts_at);--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_break_nonneg" CHECK (unpaid_break_minutes >= 0);--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_flags" CHECK (published IN (0, 1));--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_role" CHECK (role IN ('owner', 'manager', 'employee'));--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_flags" CHECK (active IN (0, 1));--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_iterations" CHECK (password_iterations > 0);--> statement-breakpoint
ALTER TABLE "time_clock_events" ADD CONSTRAINT "clock_events_action" CHECK (action IN ('clock_in', 'clock_out', 'break_start', 'break_end'));--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_status" CHECK (status IN ('pending', 'approved', 'declined'));--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_window" CHECK (ends_at >= starts_at);--> statement-breakpoint
ALTER TABLE "time_off_requests" ADD CONSTRAINT "time_off_flags" CHECK (partial_day IN (0, 1));--> statement-breakpoint
ALTER TABLE "timesheet_approvals" ADD CONSTRAINT "timesheet_period" CHECK (period_end > period_start);--> statement-breakpoint
ALTER TABLE "timesheet_approvals" ADD CONSTRAINT "timesheet_amounts_nonneg" CHECK (paid_ms >= 0 AND regular_ms >= 0 AND overtime_ms >= 0 AND gross_pay_cents >= 0);--> statement-breakpoint
ALTER TABLE "toppings" ADD CONSTRAINT "toppings_cost_nonneg" CHECK (halal_cost_cents >= 0);--> statement-breakpoint
ALTER TABLE "toppings" ADD CONSTRAINT "toppings_flags" CHECK (is_meat IN (0, 1) AND has_halal_version IN (0, 1) AND halal_available IN (0, 1) AND active IN (0, 1));