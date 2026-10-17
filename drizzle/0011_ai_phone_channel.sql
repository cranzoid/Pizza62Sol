-- AI phone receptionist, Phase 1D: an `ai_phone` order channel.
--
-- Generated from db/schema.ts (ORDER_CHANNELS). Widens the `orders_channel`
-- check constraint to accept one more value. Nothing is rewritten: every
-- existing row is 'online', 'phone' or 'walk_in', which the new constraint
-- still accepts, so this cannot fail on a populated table and cannot change an
-- existing order. Both statements run in the migration's single transaction,
-- so there is no moment without the constraint.

ALTER TABLE "orders" DROP CONSTRAINT "orders_channel";--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_channel" CHECK (channel IN ('online', 'phone', 'walk_in', 'ai_phone'));