-- H-17b: scope the payments idempotency index to live payments.
--
-- When a checkout session cannot be created, createOrder cancels the order and
-- deletes the idempotency_keys row so the customer can retry. The payments row
-- is deliberately left behind for reconciliation - and it still holds the same
-- idempotency key. Under an unconditional unique index that leftover row makes
-- the retry's INSERT collide, so every subsequent attempt fails with a 500 and
-- the customer can never order again with that key.
--
-- Excluding failed payments releases the key while keeping the audit trail.
-- Successful and pending payments still hold theirs, so genuine duplicate
-- submissions are still rejected.
--
-- Not CONCURRENTLY: scripts/migrate.ts runs each file in a transaction, which
-- forbids it, and the table is empty on every environment this has reached.
DROP INDEX "payments_idempotency_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_uq" ON "payments" USING btree ("idempotency_key") WHERE "payments"."status" <> 'failed';
