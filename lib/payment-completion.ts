/**
 * The single definition of "this order has been paid for".
 *
 * There are now two ways a Clover payment can land: the webhook, when the
 * customer went to Clover's hosted page, and the charge call, when they typed
 * their card into our own checkout. Both have to make exactly the same state
 * change — mark the payment captured, move the order out of `awaiting_payment`,
 * record the transition, and release the notifications that were parked pending
 * payment — and the two must never drift apart, because a difference between
 * them is a difference in whether the kitchen hears about an order.
 *
 * So it lives here once and both call it, rather than the inline copy the
 * webhook used to own.
 */
import { getD1 } from "@/db/runtime";
import { anyProviderConfigured } from "@/lib/notifications/config";
import { dispatchSoon } from "@/lib/notifications/dispatcher";

export async function applyPaymentApproved(input: {
  orderId: string;
  /** Free text for the order event — how the payment was confirmed, and by what id. */
  note: string;
  /**
   * Clover's own id for the payment. Set for an inline charge, where it is the
   * charge id and the only handle a refund can be reconciled against. Left alone
   * for the hosted path, where `provider_reference` already holds the checkout
   * session id the webhook was matched on.
   */
  providerReference?: string;
  now?: number;
}): Promise<void> {
  const now = input.now ?? Date.now();
  const releasedStatus = (await anyProviderConfigured()) ? "pending" : "pending_provider_setup";

  await getD1().batch([
    input.providerReference
      ? getD1()
          .prepare(
            "UPDATE payments SET status = 'captured', provider_reference = ?, failure_reason = NULL, updated_at = ? WHERE order_id = ? AND provider = 'clover'",
          )
          .bind(input.providerReference, now, input.orderId)
      : getD1()
          .prepare(
            "UPDATE payments SET status = 'captured', failure_reason = NULL, updated_at = ? WHERE order_id = ? AND provider = 'clover'",
          )
          .bind(now, input.orderId),
    // `AND status = 'awaiting_payment'` is the concurrency guard: a redelivered
    // webhook, or a charge racing the reaper, cannot re-open an order the kitchen
    // has moved on from or resurrect one that was cancelled.
    getD1()
      .prepare(
        "UPDATE orders SET status = 'received', payment_status = 'paid', updated_at = ? WHERE id = ? AND status = 'awaiting_payment'",
      )
      .bind(now, input.orderId),
    getD1()
      .prepare(
        `INSERT INTO order_events
         (id, order_id, previous_status, next_status, actor_type, actor_id, note, created_at)
         VALUES (?, ?, 'awaiting_payment', 'received', 'clover', NULL, ?, ?)`,
      )
      .bind(crypto.randomUUID(), input.orderId, input.note, now),
    // Releases everything parked on this payment — the customer's confirmation
    // and the restaurant's new-order alert both. They were parked in
    // `waiting_payment` at order creation precisely so an unpaid order never
    // confirms itself or rings the kitchen.
    //
    // Scoped by status rather than by kind, so a kind added later is released by
    // this too instead of silently staying parked forever.
    getD1()
      .prepare(
        `UPDATE notification_outbox SET status = ?, updated_at = ?
         WHERE status = 'waiting_payment'
           AND payload_json::jsonb->>'orderId' = ?`,
      )
      .bind(releasedStatus, now, input.orderId),
  ]);

  // The order is live now, so tell the customer and the kitchen immediately
  // rather than waiting for the cron sweeper. Deliberately not awaited: the
  // outbox row is already durable, and on the webhook path Clover is waiting on
  // the response — a slow provider must not cause a timeout and a redelivery of
  // an event already applied.
  dispatchSoon();
}
