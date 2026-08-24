CREATE TABLE "analytics_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"customer_id" text,
	"order_id" text,
	"event_name" text NOT NULL,
	"context_json" text DEFAULT '{}' NOT NULL,
	"occurred_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"previous_json" text,
	"next_json" text,
	"reason" text,
	"request_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"active" integer DEFAULT 1 NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "correction_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"staff_user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"requested_time" bigint NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"reviewer_id" text,
	"reviewer_note" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"password_hash" text,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"rating_scale" integer,
	"required" integer DEFAULT 0 NOT NULL,
	"condition_json" text DEFAULT '{}' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"overall_rating" integer NOT NULL,
	"answers_json" text NOT NULL,
	"written_feedback" text,
	"reviewed_at" bigint,
	"internal_note" text,
	"submitted_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"resource_id" text,
	"status" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"recipient" text,
	"payload_json" text NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"scheduled_for" bigint NOT NULL,
	"sent_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"previous_status" text,
	"next_status" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"note" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"variation_name" text,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"line_total_cents" integer NOT NULL,
	"taxable" integer NOT NULL,
	"snapshot_json" text NOT NULL,
	"instructions" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_sequences" (
	"key" text PRIMARY KEY NOT NULL,
	"current_number" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"tracking_token_hash" text NOT NULL,
	"feedback_token_hash" text NOT NULL,
	"customer_id" text,
	"customer_name" text NOT NULL,
	"customer_phone" text NOT NULL,
	"customer_email" text NOT NULL,
	"fulfilment" text NOT NULL,
	"status" text NOT NULL,
	"payment_status" text NOT NULL,
	"payment_method" text NOT NULL,
	"schedule_type" text NOT NULL,
	"scheduled_for" bigint,
	"estimated_for" bigint NOT NULL,
	"address_json" text,
	"instructions" text,
	"pricing_json" text NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"discount_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	"delivery_fee_cents" integer NOT NULL,
	"tip_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"acknowledged_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text,
	"method" text NOT NULL,
	"status" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"failure_reason" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_variations" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"name" text NOT NULL,
	"base_price_cents" integer NOT NULL,
	"extra_topping_price_cents" integer DEFAULT 0 NOT NULL,
	"included_topping_units_bps" integer DEFAULT 0 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"product_type" text NOT NULL,
	"image_url" text,
	"base_price_cents" integer DEFAULT 0 NOT NULL,
	"taxable" integer DEFAULT 1 NOT NULL,
	"pickup_eligible" integer DEFAULT 1 NOT NULL,
	"delivery_eligible" integer DEFAULT 1 NOT NULL,
	"halal_capable" integer DEFAULT 0 NOT NULL,
	"promotion_eligible" integer DEFAULT 1 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"sold_out" integer DEFAULT 0 NOT NULL,
	"setup_required" integer DEFAULT 0 NOT NULL,
	"kitchen_label" text,
	"configuration_json" text DEFAULT '{}' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"type" text NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"combinable" integer DEFAULT 1 NOT NULL,
	"exclusive" integer DEFAULT 0 NOT NULL,
	"stack_group" text,
	"active" integer DEFAULT 0 NOT NULL,
	"starts_at" bigint,
	"ends_at" bigint,
	"rule_json" text DEFAULT '{}' NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"window_started_at" bigint NOT NULL,
	"attempts" integer NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"internal_note" text,
	"customer_note" text,
	"provider_reference" text,
	"status" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value_json" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" text PRIMARY KEY NOT NULL,
	"staff_user_id" text,
	"role" text,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint NOT NULL,
	"unpaid_break_minutes" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"published" integer DEFAULT 0 NOT NULL,
	"published_at" bigint,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_profiles" (
	"staff_user_id" text PRIMARY KEY NOT NULL,
	"job_title" text,
	"employment_type" text DEFAULT 'hourly' NOT NULL,
	"wage_cents" integer DEFAULT 0 NOT NULL,
	"weekly_overtime_minutes" integer DEFAULT 2640 NOT NULL,
	"overtime_multiplier_bps" integer DEFAULT 15000 NOT NULL,
	"week_starts_on" integer DEFAULT 0 NOT NULL,
	"pin_hash" text,
	"pin_salt" text,
	"pin_iterations" integer,
	"availability_json" text DEFAULT '[]' NOT NULL,
	"hired_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"staff_user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"password_hash" text NOT NULL,
	"password_salt" text NOT NULL,
	"password_iterations" integer NOT NULL,
	"permissions_json" text DEFAULT '[]' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"last_login_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_clock_events" (
	"id" text PRIMARY KEY NOT NULL,
	"staff_user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"action" text NOT NULL,
	"occurred_at" bigint NOT NULL,
	"source" text NOT NULL,
	"correction_of" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_clock_state" (
	"staff_user_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"session_id" text,
	"transition_id" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_off_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"staff_user_id" text NOT NULL,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint NOT NULL,
	"partial_day" integer DEFAULT 0 NOT NULL,
	"note" text,
	"status" text NOT NULL,
	"reviewer_id" text,
	"reviewer_note" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheet_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"staff_user_id" text NOT NULL,
	"period_start" bigint NOT NULL,
	"period_end" bigint NOT NULL,
	"status" text DEFAULT 'approved' NOT NULL,
	"paid_ms" integer DEFAULT 0 NOT NULL,
	"regular_ms" integer DEFAULT 0 NOT NULL,
	"overtime_ms" integer DEFAULT 0 NOT NULL,
	"gross_pay_cents" integer DEFAULT 0 NOT NULL,
	"note" text,
	"approved_by" text NOT NULL,
	"approved_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "toppings" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kitchen_label" text NOT NULL,
	"is_meat" integer DEFAULT 0 NOT NULL,
	"has_halal_version" integer DEFAULT 0 NOT NULL,
	"halal_display_name" text,
	"halal_available" integer DEFAULT 0 NOT NULL,
	"halal_cost_cents" integer DEFAULT 0 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "analytics_event_time_idx" ON "analytics_events" USING btree ("event_name","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_uq" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "correction_status_idx" ON "correction_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_email_uq" ON "customers" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_order_uq" ON "feedback_responses" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "outbox_status_idx" ON "notification_outbox" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_number_uq" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tracking_token_hash_uq" ON "orders" USING btree ("tracking_token_hash");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_uq" ON "payments" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "payments_order_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "product_variations_product_idx" ON "product_variations" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_slug_uq" ON "products" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "products_active_idx" ON "products" USING btree ("active","sold_out");--> statement-breakpoint
CREATE UNIQUE INDEX "promotions_code_uq" ON "promotions" USING btree ("code");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "shifts_starts_at_idx" ON "shifts" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "shifts_staff_idx" ON "shifts" USING btree ("staff_user_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_sessions_token_hash_uq" ON "staff_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "staff_sessions_user_idx" ON "staff_sessions" USING btree ("staff_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_users_email_uq" ON "staff_users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "clock_user_time_idx" ON "time_clock_events" USING btree ("staff_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "time_off_status_idx" ON "time_off_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "timesheet_approvals_period_idx" ON "timesheet_approvals" USING btree ("staff_user_id","period_start");--> statement-breakpoint
CREATE INDEX "toppings_active_idx" ON "toppings" USING btree ("active");