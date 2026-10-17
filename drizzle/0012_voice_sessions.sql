-- AI phone receptionist, Phase 2B: voice sessions and their event log.
--
-- Generated from db/schema.ts (voice_calls, voice_call_events), plus one
-- hand-written trigger at the end. Purely additive: two new tables, their
-- indexes and foreign keys. No existing table or row is touched; the foreign
-- key from voice_calls.order_id to orders is ON DELETE SET NULL, so it can
-- never block or cascade into an order.
--
-- The trigger is not something drizzle-kit models. It makes voice_call_events
-- append-only in the database rather than by convention: an UPDATE raises.
-- DELETE stays possible so a retention sweep (or a session's cascade) can
-- remove rows.

CREATE TABLE "voice_call_events" (
	"id" text PRIMARY KEY NOT NULL,
	"voice_call_id" text NOT NULL,
	"event_type" text NOT NULL,
	"tool" text,
	"request_json" text,
	"response_json" text,
	"ok" integer NOT NULL,
	"issue_codes_json" text,
	"latency_ms" integer,
	"cart_version_before" integer,
	"cart_version_after" integer,
	"created_at" bigint NOT NULL,
	CONSTRAINT "voice_call_events_type" CHECK (event_type IN ('tool', 'session')),
	CONSTRAINT "voice_call_events_flags" CHECK (ok IN (0, 1)),
	CONSTRAINT "voice_call_events_latency_nonneg" CHECK (latency_ms IS NULL OR latency_ms >= 0)
);
--> statement-breakpoint
CREATE TABLE "voice_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"mode" text NOT NULL,
	"call_sid" text,
	"provider_conversation_id" text,
	"session_secret_hash" text NOT NULL,
	"caller_phone" text,
	"caller_id_status" text DEFAULT 'unknown' NOT NULL,
	"stage" text DEFAULT 'new' NOT NULL,
	"fulfilment" text,
	"customer_name" text,
	"customer_phone" text,
	"customer_phone_source" text,
	"delivery_address_json" text,
	"delivery_check_json" text,
	"cart_json" text DEFAULT '[]' NOT NULL,
	"cart_version" integer DEFAULT 0 NOT NULL,
	"next_line_number" integer DEFAULT 1 NOT NULL,
	"reviewed_version" integer,
	"reviewed_amount_cents" integer,
	"reviewed_at" bigint,
	"confirmed_version" integer,
	"confirmed_at" bigint,
	"confirmed_amount_cents" integer,
	"confirmation_utterance" text,
	"placement_started_at" bigint,
	"order_id" text,
	"placed_at" bigint,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"validation_error_count" integer DEFAULT 0 NOT NULL,
	"consecutive_failure_count" integer DEFAULT 0 NOT NULL,
	"escalation_reason" text,
	"failure_reason" text,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "voice_calls_provider" CHECK (provider IN ('elevenlabs', 'simulator', 'test')),
	CONSTRAINT "voice_calls_mode" CHECK (mode IN ('test', 'internal', 'pilot', 'live')),
	CONSTRAINT "voice_calls_caller_id_status" CHECK (caller_id_status IN ('presented', 'forwarded_as_store', 'withheld', 'unknown')),
	CONSTRAINT "voice_calls_stage" CHECK (stage IN ('new', 'fulfilment', 'building', 'address', 'review', 'confirmed', 'placing', 'placed', 'closed')),
	CONSTRAINT "voice_calls_fulfilment" CHECK (fulfilment IS NULL OR fulfilment IN ('pickup', 'delivery')),
	CONSTRAINT "voice_calls_phone_source" CHECK (customer_phone_source IS NULL OR customer_phone_source IN ('caller_id', 'spoken')),
	CONSTRAINT "voice_calls_counts_nonneg" CHECK (cart_version >= 0 AND tool_call_count >= 0 AND validation_error_count >= 0 AND consecutive_failure_count >= 0),
	CONSTRAINT "voice_calls_line_number_positive" CHECK (next_line_number >= 1),
	CONSTRAINT "voice_calls_review_consistent" CHECK ((reviewed_version IS NULL AND reviewed_amount_cents IS NULL AND reviewed_at IS NULL)
          OR (reviewed_version IS NOT NULL AND reviewed_amount_cents IS NOT NULL AND reviewed_at IS NOT NULL
              AND reviewed_version <= cart_version AND reviewed_amount_cents >= 0)),
	CONSTRAINT "voice_calls_confirmation_consistent" CHECK ((confirmed_version IS NULL AND confirmed_at IS NULL AND confirmed_amount_cents IS NULL)
          OR (confirmed_version IS NOT NULL AND confirmed_at IS NOT NULL AND confirmed_amount_cents IS NOT NULL
              AND reviewed_version IS NOT NULL AND reviewed_amount_cents IS NOT NULL
              AND confirmed_version = reviewed_version AND confirmed_amount_cents = reviewed_amount_cents)),
	CONSTRAINT "voice_calls_placed_has_order" CHECK (stage <> 'placed' OR order_id IS NOT NULL),
	CONSTRAINT "voice_calls_expiry_after_start" CHECK (expires_at > started_at)
);
--> statement-breakpoint
ALTER TABLE "voice_call_events" ADD CONSTRAINT "voice_call_events_voice_call_id_voice_calls_id_fk" FOREIGN KEY ("voice_call_id") REFERENCES "public"."voice_calls"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "voice_call_events_call_idx" ON "voice_call_events" USING btree ("voice_call_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_calls_secret_hash_uq" ON "voice_calls" USING btree ("session_secret_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_calls_call_sid_uq" ON "voice_calls" USING btree ("call_sid") WHERE "voice_calls"."call_sid" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_calls_conversation_uq" ON "voice_calls" USING btree ("provider_conversation_id") WHERE "voice_calls"."provider_conversation_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_calls_order_uq" ON "voice_calls" USING btree ("order_id") WHERE "voice_calls"."order_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "voice_calls_created_idx" ON "voice_calls" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "voice_calls_caller_idx" ON "voice_calls" USING btree ("caller_phone","created_at");
--> statement-breakpoint
CREATE FUNCTION "voice_call_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'voice_call_events is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "voice_call_events_no_update" BEFORE UPDATE ON "voice_call_events"
  FOR EACH ROW EXECUTE FUNCTION "voice_call_events_append_only"();
