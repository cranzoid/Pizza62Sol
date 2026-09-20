/**
 * Clover payment webhook.
 *
 * Clover reports the outcome of a hosted checkout here. The event is small —
 * `{ id, merchantId, data, status, type }` — and `data` is the checkout session
 * UUID, which is the only link back to our order: Clover has no metadata
 * passthrough, so the session id was written to `payments.provider_reference`
 * when the session was created and is looked up through that here.
 *
 * Two differences from the Stripe route this replaces, both consequences of the
 * contract rather than choices:
 *
 * - **No amount cross-check.** The Stripe event carried `amount_total`, so the
 *   route could refuse a payment that disagreed with the server-priced order.
 *   The Clover event carries no amount, so that guard cannot be reproduced from
 *   the payload. What protects the amount instead is that it is never sent from
 *   the browser: `createCloverCheckout()` builds the session from the stored
 *   `total_cents`, so the figure the customer is shown is the figure we priced.
 * - **No expiry event.** Stripe sent `checkout.session.expired`; Clover does
 *   not, and its sessions die after 15 minutes. Orders stranded in
 *   `awaiting_payment` are cleaned up by `scripts/reap-payments.ts` instead.
 *
 * A session id resolves to a food order *or* to a gift card sale, which lives in
 * its own table for the reasons set out in db/schema.ts. Both are looked up
 * here; an id matching neither is acknowledged rather than refused, because a
 * non-2xx makes Clover retry a delivery we are never going to act on.
 */
import { ensureDatabase, getD1 } from "@/db/runtime";
import { cloverMerchantId, cloverWebhookSecret, verifyCloverSignature, type CloverWebhookEvent } from "@/lib/clover";
import { completeGiftCardPurchase } from "@/lib/gift-card-purchase";
import { applyPaymentApproved } from "@/lib/payment-completion";

export async function POST(request: Request) {
  // Through `cloverWebhookSecret()`, not `env` directly: the owner sets this on
  // the Integrations tab, so it normally lives encrypted in the database and the
  // environment holds nothing. Reading `process.env` here meant every delivery
  // 503'd while `cloverWebhookConfigured()` — which does read the store — told
  // the admin screen the webhook was configured. Orders stayed in
  // `awaiting_payment` until the reaper cancelled them, with Clover holding the
  // customer's money. The two reads must come from the same place.
  const webhookSecret = await cloverWebhookSecret();
  if (!webhookSecret) return Response.json({ error: "Clover webhook is not configured." }, { status: 503 });

  // The raw bytes, not the parsed body: the MAC covers exactly what was sent.
  const payload = await request.text();
  if (!(await verifyCloverSignature(payload, request.headers.get("clover-signature"), webhookSecret))) {
    return Response.json({ error: "Invalid Clover signature." }, { status: 400 });
  }

  let event: CloverWebhookEvent;
  try {
    event = JSON.parse(payload) as CloverWebhookEvent;
  } catch {
    return Response.json({ error: "Malformed Clover payload." }, { status: 400 });
  }

  // A validly-signed event for a different merchant is not ours to act on.
  // Signature verification alone does not establish this, because one signing
  // secret can cover several merchants under the same account.
  const expectedMerchant = await cloverMerchantId();
  if (expectedMerchant && event.merchantId && event.merchantId !== expectedMerchant) {
    return Response.json({ error: "Event is for a different merchant." }, { status: 409 });
  }

  const sessionId = typeof event.data === "string" ? event.data : "";
  // Anything that is not a payment outcome we can place is acknowledged rather
  // than rejected, so Clover stops retrying a delivery we will never act on.
  if (event.type !== "PAYMENT" || !sessionId) return Response.json({ received: true });

  await ensureDatabase();

  /**
   * A session id now resolves to one of two things, so both are looked up.
   *
   * Gift card sales do not live in `orders` (see db/schema.ts), so their
   * sessions are in `gift_card_purchases.provider_reference` instead. Checked
   * first because it is the smaller table and because an order lookup that
   * quietly returns nothing for a gift card session would fall through to the
   * "unknown session" acknowledgement below — and a customer who had paid for a
   * card would never receive one.
   */
  const purchase = await getD1()
    .prepare("SELECT id, status FROM gift_card_purchases WHERE provider_reference = ?")
    .bind(sessionId)
    .first<{ id: string; status: string }>();
  if (purchase) {
    if (event.status === "APPROVED") {
      // The card is minted here and nowhere earlier: this is the first moment
      // anyone knows the money is real. `completeGiftCardPurchase` is guarded on
      // the purchase still being unpaid, so a redelivered event cannot issue a
      // second card for one payment.
      await completeGiftCardPurchase(purchase.id, event.id ?? null);
      return Response.json({ received: true });
    }
    if (event.status === "DECLINED") {
      // Recorded, but the purchase is deliberately **not** marked failed — the
      // same rule as an order, and for the same reason. Clover's checkout
      // session stays valid for the rest of its fifteen minutes and the buyer
      // may well retry with another card on that very session. Failing it here
      // would mean the retry is approved, the money is taken, and
      // `completeGiftCardPurchase` finds a purchase it is no longer allowed to
      // claim — a customer charged for a gift card that was never issued.
      //
      // If no approval follows, the reaper fails it on the same timer as an
      // abandoned checkout, which is what frees the key for the next attempt.
      await getD1()
        .prepare(
          "UPDATE gift_card_purchases SET failure_reason = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_payment'",
        )
        .bind(`Clover declined the payment (${event.id ?? "no payment id"})`, Date.now(), purchase.id)
        .run();
      return Response.json({ received: true });
    }
    return Response.json({ received: true });
  }

  const record = await getD1()
    .prepare(
      `SELECT o.id, o.status, o.payment_status, p.amount_cents, p.status AS payment_row_status
       FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.provider_reference = ? AND p.provider = 'clover'`,
    )
    .bind(sessionId)
    .first<{
      id: string;
      status: string;
      payment_status: string;
      amount_cents: number;
      payment_row_status: string;
    }>();
  // An unknown session is acknowledged, not 404'd: replays and events for orders
  // this deployment never created are normal, and a non-2xx makes Clover retry.
  if (!record) return Response.json({ received: true });

  const orderId = record.id;
  const now = Date.now();

  if (event.status === "APPROVED") {
    // Guarded on the current status rather than blindly applied, so a redelivered
    // event cannot re-open an order the kitchen has since moved on, or resurrect
    // one the reaper cancelled.
    if (record.status !== "awaiting_payment") return Response.json({ received: true });
    // The state change itself lives in lib/payment-completion.ts, shared with the
    // inline-card path. Two copies of "this order is paid" would eventually
    // disagree about whether the kitchen gets told.
    await applyPaymentApproved({
      orderId,
      note: `Clover payment approved (${event.id ?? "no payment id"})`,
      now,
    });
    return Response.json({ received: true });
  }

  if (event.status === "DECLINED") {
    // A decline is recorded but the order is deliberately *not* cancelled. The
    // checkout session stays valid for the remainder of its 15 minutes and the
    // customer may well retry with another card on the very same session;
    // cancelling here would destroy an order that is about to be paid for. If no
    // approval arrives, the reaper cancels it on the same timer as an abandoned
    // checkout.
    //
    // The status written is 'declined', not 'failed'. 'failed' is the value that
    // drops a row out of the partial `payments_idempotency_uq` index (H-17b) and
    // so releases the checkout idempotency key — correct when the session could
    // not be created at all, wrong here, where the order exists and holds it.
    if (record.status !== "awaiting_payment") return Response.json({ received: true });
    await getD1().batch([
      getD1()
        .prepare(
          "UPDATE payments SET status = 'declined', failure_reason = ?, updated_at = ? WHERE order_id = ? AND provider = 'clover'",
        )
        .bind(`Clover declined the payment (${event.id ?? "no payment id"})`, now, orderId),
      getD1()
        .prepare(
          `INSERT INTO order_events
           (id, order_id, previous_status, next_status, actor_type, actor_id, note, created_at)
           VALUES (?, ?, 'awaiting_payment', 'awaiting_payment', 'clover', NULL, 'Clover declined the payment', ?)`,
        )
        .bind(crypto.randomUUID(), orderId, now),
    ]);
    return Response.json({ received: true });
  }

  return Response.json({ received: true });
}
