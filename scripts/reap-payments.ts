/**
 * Cancels orders stranded in `awaiting_payment`.
 *
 * Stripe told us when a checkout session expired; Clover does not. Its sessions
 * are also short — 15 minutes, against Stripe's 24 hours — so without this job
 * every abandoned checkout would sit in the queue as an order that looks live,
 * indefinitely. This is the reconciliation the audit found missing, moved from
 * "a webhook we hope arrives" to "a timer we control".
 *
 * Runs as the `payment-reaper` Container Apps job every 5 minutes. Safe to run
 * repeatedly and safe to run concurrently: each cancellation is guarded on the
 * order still being in `awaiting_payment`, so a webhook that approves a payment
 * a moment before this runs wins, and a second reaper finds nothing to do.
 *
 * Deliberately conservative in one direction: it cancels only orders whose
 * checkout window has certainly closed. Cancelling an order a customer is still
 * paying for is far worse than reaping it five minutes late.
 */
import { PostgresDatabase, closePool, getPool } from "@/db/pg-driver";

/**
 * How long after creation an unpaid order is considered dead.
 *
 * Clover sessions expire at 15 minutes. The extra 5 covers clock skew between
 * this container and Clover's, plus a webhook that is in flight as the cutoff
 * passes — the guarded UPDATE would ignore a late approval, so the margin is
 * what keeps that from happening in the first place.
 */
const STALE_AFTER_MS = 20 * 60 * 1000;

/** Never touch orders older than this; they belong to a previous incident. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

type StaleOrder = { id: string; order_number: string; created_at: number };

export async function reapStalePayments(
  database: PostgresDatabase,
  now: number = Date.now(),
): Promise<StaleOrder[]> {
  const cutoff = now - STALE_AFTER_MS;
  const stale = await database
    .prepare(
      `SELECT o.id, o.order_number, o.created_at
       FROM orders o
       WHERE o.status = 'awaiting_payment'
         AND o.payment_method = 'online'
         AND o.created_at < ?
         AND o.created_at > ?
       ORDER BY o.created_at
       LIMIT 200`,
    )
    .bind(cutoff, now - LOOKBACK_MS)
    .all<StaleOrder>();

  for (const order of stale.results) {
    await database.batch([
      // `AND status = 'awaiting_payment'` is the whole concurrency story: if the
      // webhook approved this order between the SELECT above and this UPDATE,
      // the row no longer matches and the cancellation is a no-op.
      database
        .prepare(
          "UPDATE orders SET status = 'cancelled', payment_status = 'expired', updated_at = ? WHERE id = ? AND status = 'awaiting_payment'",
        )
        .bind(now, order.id),
      // Left as 'expired', not 'failed'. 'failed' is what releases the checkout
      // idempotency key through the partial `payments_idempotency_uq` index
      // (H-17b); that is correct when a session could never be created, and
      // wrong here, where a real session was issued and simply went unpaid.
      database
        .prepare(
          "UPDATE payments SET status = 'expired', updated_at = ? WHERE order_id = ? AND provider = 'clover' AND status NOT IN ('captured', 'refunded')",
        )
        .bind(now, order.id),
      database
        .prepare(
          `INSERT INTO order_events
           (id, order_id, previous_status, next_status, actor_type, actor_id, note, created_at)
           VALUES (?, ?, 'awaiting_payment', 'cancelled', 'system', NULL, 'Clover checkout expired without payment', ?)`,
        )
        .bind(crypto.randomUUID(), order.id, now),
      // The confirmation was parked in `waiting_payment` at order creation and
      // must never be sent now: nobody paid, and there is no order to confirm.
      database
        .prepare(
          `UPDATE notification_outbox SET status = 'cancelled', updated_at = ?
           WHERE kind = 'customer_order_confirmation'
             AND status = 'waiting_payment'
             AND payload_json::jsonb->>'orderId' = ?`,
        )
        .bind(now, order.id),
    ]);
  }
  return stale.results;
}

async function main(): Promise<void> {
  try {
    const cancelled = await reapStalePayments(new PostgresDatabase(getPool()));
    console.log(
      cancelled.length
        ? `cancelled ${cancelled.length} unpaid order(s): ${cancelled.map((order) => order.order_number).join(", ")}`
        : "no stale awaiting_payment orders",
    );
  } finally {
    await closePool();
  }
}

// Guarded so the test suite can import `reapStalePayments` without the script
// connecting to a database and exiting the process.
if (process.argv[1]?.endsWith("reap-payments.ts")) {
  await main();
}
