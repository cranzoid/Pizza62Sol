/**
 * The outbox consumer — the thing the audit found missing.
 *
 * `notification_outbox` was already a complete job queue: kind, recipient,
 * payload, status, attempt count, schedule, error. Nothing read it, so no
 * customer or staff member was ever told an order existed. This is the reader.
 *
 * **Rows are claimed, not just selected.** `FOR UPDATE SKIP LOCKED` inside a
 * transaction, flipping status to `sending` before the transaction commits, is
 * what makes it safe for the cron job and an inline dispatch to run at the same
 * moment — and they will, constantly, because inline dispatch fires on every
 * order while the sweeper runs every minute. Two workers that both merely
 * *selected* the same pending row would both send it, and the customer would get
 * two confirmations. `SKIP LOCKED` means the second worker never sees it.
 *
 * **Retries are bounded and backed off**, and distinguish failures that could
 * succeed later from ones that never will. A malformed address retried sixteen
 * times is sixteen guaranteed failures delaying every message behind it.
 *
 * **A channel with no credentials parks the row rather than failing it.** During
 * the window where Twilio is provisioned but SendGrid is not, a confirmation
 * should wait, not burn its attempts and land in `failed` where nobody looks.
 */
import { ensureDatabase, getD1, getSetting } from "@/db/runtime";
import {
  ChannelError,
  ChannelNotConfiguredError,
  placeAcknowledgementCall,
  sendEmail,
  sendSms,
} from "@/lib/notifications/channels";
import {
  anyProviderConfigured,
  customerSmsEnabled,
  publicBaseUrl,
  restaurantAlertNumber,
  voiceRetryLimit,
  voiceRetryMinutes,
} from "@/lib/notifications/config";
import {
  renderCustomerConfirmation,
  renderFeedbackRequest,
  renderLowRatingAlert,
  renderRestaurantNewOrder,
  type OrderSnapshot,
} from "@/lib/notifications/messages";

/** Statuses a dispatcher will pick up. Everything else is terminal or parked. */
const CLAIMABLE = ["pending", "retrying"] as const;

const MAX_ATTEMPTS = 6;

/**
 * How long a row may sit in `sending` before another worker may take it back.
 *
 * `sending` means "a worker claimed this and is delivering it". If that worker
 * dies — a replica restart mid-dispatch, an OOM, a deploy rolling the revision —
 * nothing else would ever look at the row again and the customer's confirmation
 * would be stranded permanently. That is the exact failure mode this release
 * exists to eliminate, so the claim query reclaims stale ones.
 *
 * Five minutes is far longer than any real send (the provider calls are seconds)
 * and short enough that a lost message is recovered within one support call. The
 * cost of reclaiming too early is a duplicate message; the cost of never
 * reclaiming is silence, which is worse.
 */
const STALE_SENDING_MS = 5 * 60_000;

/** 1m, 2m, 4m, 8m, 16m, 32m — capped so a stuck row is not retried forever. */
function backoffMs(attemptCount: number): number {
  return Math.min(2 ** Math.max(0, attemptCount - 1), 32) * 60_000;
}

export type OutboxRow = {
  id: string;
  kind: string;
  recipient: string | null;
  payload_json: string;
  attempt_count: number;
};

export type DispatchOutcome = {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  parked: number;
};

/**
 * Claims up to `limit` due rows, marking them `sending` in the same transaction.
 *
 * Runs on one pooled client because the lock only lives for the transaction that
 * took it — splitting these across clients would release each row the instant it
 * was claimed.
 */
async function claimDue(limit: number, now: number): Promise<OutboxRow[]> {
  const { getPool } = await import("@/db/pg-driver");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query<OutboxRow>(
      `WITH due AS (
         SELECT id FROM notification_outbox
         WHERE (status = ANY($1) AND scheduled_for <= $2)
            -- Reclaim rows abandoned mid-delivery by a worker that died. See
            -- STALE_SENDING_MS: without this they are stranded forever.
            OR (status = 'sending' AND updated_at < $4)
         ORDER BY scheduled_for
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       UPDATE notification_outbox o
       SET status = 'sending', updated_at = $2
       FROM due
       WHERE o.id = due.id
       RETURNING o.id, o.kind, o.recipient, o.payload_json, o.attempt_count`,
      [CLAIMABLE, now, limit, now - STALE_SENDING_MS],
    );
    await client.query("COMMIT");
    return claimed.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function loadOrder(orderId: string): Promise<OrderSnapshot | null> {
  return getD1()
    .prepare(
      `SELECT id, order_number, customer_name, customer_email, customer_phone, fulfilment,
              status, payment_status, payment_method, schedule_type, scheduled_for,
              estimated_for, total_cents, address_json, acknowledged_at
       FROM orders WHERE id = ?`,
    )
    .bind(orderId)
    .first<OrderSnapshot>();
}

async function loadItemLines(orderId: string): Promise<string[]> {
  const items = await getD1()
    .prepare(
      "SELECT product_name, variation_name, quantity FROM order_items WHERE order_id = ? ORDER BY created_at",
    )
    .bind(orderId)
    .all<{ product_name: string; variation_name: string | null; quantity: number }>();
  return items.results.map(
    (item) => `${item.quantity} x ${item.product_name}${item.variation_name ? ` (${item.variation_name})` : ""}`,
  );
}

/** Thrown when a row can never succeed — bad kind, missing order, no recipient. */
class PermanentFailure extends Error {}

/** Thrown when the row should wait for credentials rather than spend an attempt. */
class ParkForSetup extends Error {}

async function deliver(row: OutboxRow): Promise<void> {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const orderId = typeof payload.orderId === "string" ? payload.orderId : null;

  switch (row.kind) {
    case "customer_order_confirmation": {
      if (!orderId) throw new PermanentFailure("confirmation payload has no orderId");
      const order = await loadOrder(orderId);
      if (!order) throw new PermanentFailure(`order ${orderId} no longer exists`);
      // An order that was cancelled while queued must not be confirmed. The
      // reaper already sets these to 'cancelled', but an inline dispatch racing
      // a cancellation could still arrive here.
      if (order.status === "cancelled") throw new PermanentFailure("order was cancelled");
      const message = renderCustomerConfirmation(order, payload, await loadItemLines(orderId));
      const to = row.recipient ?? order.customer_email;
      if (!to) throw new PermanentFailure("no recipient address");
      await sendEmail({ to, subject: message.emailSubject, text: message.emailText });
      // Additive only, and off by default — see config.ts on why an unregistered
      // local long code cannot be trusted to deliver. A failure here must not
      // undo the email that already went.
      if (customerSmsEnabled() && order.customer_phone) {
        await sendSms({ to: order.customer_phone, body: message.smsBody }).catch(() => undefined);
      }
      return;
    }

    case "restaurant_new_order": {
      if (!orderId) throw new PermanentFailure("restaurant alert payload has no orderId");
      const order = await loadOrder(orderId);
      if (!order) throw new PermanentFailure(`order ${orderId} no longer exists`);
      if (order.status === "cancelled") throw new PermanentFailure("order was cancelled");
      const message = renderRestaurantNewOrder(order, await loadItemLines(orderId));
      const alertNumber = restaurantAlertNumber();

      // Email and voice are the reliable pair (see §9's SMS caveat); SMS is a
      // best-effort extra and is never allowed to fail the row on its own.
      let delivered = false;
      const business = await getSetting<{ email?: string }>("business").catch(() => ({ email: undefined }));
      const to = row.recipient ?? business.email;
      if (to) {
        await sendEmail({ to, subject: message.emailSubject, text: message.emailText });
        delivered = true;
      }
      if (alertNumber) {
        await sendSms({ to: alertNumber, body: message.smsBody }).catch(() => undefined);
        const base = publicBaseUrl();
        // The call is what actually gets someone's attention, so it is the one
        // whose failure is allowed to retry the row.
        if (base && message.voiceSay && !order.acknowledged_at) {
          await placeAcknowledgementCall({
            to: alertNumber,
            say: message.voiceSay,
            ackCallbackUrl: `${base}/api/notifications/voice/ack?order=${encodeURIComponent(order.id)}`,
          });
          delivered = true;
        }
      }
      if (!delivered) throw new ParkForSetup("no configured channel can reach the restaurant");
      return;
    }

    case "low_rating_alert": {
      const message = renderLowRatingAlert(payload as Parameters<typeof renderLowRatingAlert>[0]);
      const business = await getSetting<{ email?: string }>("business").catch(() => ({ email: undefined }));
      const to = row.recipient ?? business.email;
      if (!to) throw new ParkForSetup("no restaurant email configured for alerts");
      await sendEmail({ to, subject: message.emailSubject, text: message.emailText });
      return;
    }

    case "feedback_request": {
      if (!orderId) throw new PermanentFailure("feedback payload has no orderId");
      const order = await loadOrder(orderId);
      if (!order) throw new PermanentFailure(`order ${orderId} no longer exists`);
      // Asking someone how their cancelled order was is worse than saying nothing.
      if (order.status !== "completed") throw new PermanentFailure("order did not complete");
      const message = renderFeedbackRequest(order, payload);
      const to = row.recipient ?? order.customer_email;
      if (!to) throw new PermanentFailure("no recipient address");
      await sendEmail({ to, subject: message.emailSubject, text: message.emailText });
      return;
    }

    default:
      throw new PermanentFailure(`unknown notification kind "${row.kind}"`);
  }
}

async function markSent(row: OutboxRow, now: number): Promise<void> {
  // The payload is replaced rather than kept. It carries plaintext tracking and
  // feedback tokens (messages.ts explains why it has to), and once the message
  // is gone there is no reason for them to persist in the queue. What remains is
  // enough to reconcile "did this order get its confirmation?" without holding a
  // credential that grants access to the order.
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  const redacted = JSON.stringify({
    orderId: payload.orderId ?? null,
    orderNumber: payload.orderNumber ?? null,
    redacted: true,
  });
  await getD1()
    .prepare(
      "UPDATE notification_outbox SET status = 'sent', sent_at = ?, last_error = NULL, payload_json = ?, attempt_count = attempt_count + 1, updated_at = ? WHERE id = ?",
    )
    .bind(now, redacted, now, row.id)
    .run();
}

async function markRetry(row: OutboxRow, error: string, now: number): Promise<boolean> {
  const attempts = row.attempt_count + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await getD1()
      .prepare(
        "UPDATE notification_outbox SET status = 'failed', last_error = ?, attempt_count = ?, updated_at = ? WHERE id = ?",
      )
      .bind(error.slice(0, 500), attempts, now, row.id)
      .run();
    return false;
  }
  await getD1()
    .prepare(
      "UPDATE notification_outbox SET status = 'retrying', last_error = ?, attempt_count = ?, scheduled_for = ?, updated_at = ? WHERE id = ?",
    )
    .bind(error.slice(0, 500), attempts, now + backoffMs(attempts), now, row.id)
    .run();
  return true;
}

async function markFailed(row: OutboxRow, error: string, now: number): Promise<void> {
  await getD1()
    .prepare(
      "UPDATE notification_outbox SET status = 'failed', last_error = ?, attempt_count = ?, updated_at = ? WHERE id = ?",
    )
    .bind(error.slice(0, 500), row.attempt_count + 1, now, row.id)
    .run();
}

async function park(row: OutboxRow, reason: string, now: number): Promise<void> {
  // Note the attempt count is NOT incremented: waiting for credentials is not an
  // attempt, and a row that parked five times should still get its full six
  // tries once a provider exists.
  await getD1()
    .prepare(
      "UPDATE notification_outbox SET status = 'pending_provider_setup', last_error = ?, updated_at = ? WHERE id = ?",
    )
    .bind(reason.slice(0, 500), now, row.id)
    .run();
}

/**
 * Drains due outbox rows. Safe to run concurrently with itself and with inline
 * dispatch; safe to run when nothing is configured (it claims nothing).
 */
export async function dispatchOutbox(options: { limit?: number; now?: number } = {}): Promise<DispatchOutcome> {
  await ensureDatabase();
  const outcome: DispatchOutcome = { claimed: 0, sent: 0, retried: 0, failed: 0, parked: 0 };
  if (!anyProviderConfigured()) return outcome;

  const now = options.now ?? Date.now();
  const rows = await claimDue(options.limit ?? 25, now);
  outcome.claimed = rows.length;

  for (const row of rows) {
    try {
      await deliver(row);
      await markSent(row, Date.now());
      outcome.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ParkForSetup || error instanceof ChannelNotConfiguredError) {
        await park(row, message, Date.now());
        outcome.parked += 1;
      } else if (error instanceof PermanentFailure || (error instanceof ChannelError && !error.retryable)) {
        await markFailed(row, message, Date.now());
        outcome.failed += 1;
      } else if (await markRetry(row, message, Date.now())) {
        outcome.retried += 1;
      } else {
        outcome.failed += 1;
      }
    }
  }
  return outcome;
}

/**
 * Fires a dispatch without making the caller wait for it.
 *
 * Node can do the work in-process, unlike Workers, so an order does not have to
 * wait up to a minute for the cron floor before anyone is told about it. The
 * cron job stays as the retry sweeper and the safety net for anything this
 * misses — a crash between commit and dispatch loses nothing, because the row is
 * already durable in the outbox. Errors are swallowed for exactly that reason:
 * a failed inline dispatch must never turn a successfully placed order into an
 * error response.
 */
export function dispatchSoon(): void {
  void dispatchOutbox({ limit: 10 }).catch(() => undefined);
}

/**
 * Re-queues the restaurant call for orders nobody has acknowledged yet.
 *
 * The roadmap's requirement is "re-call every 2 minutes while unacknowledged",
 * which is a *sweep*, not something a single delivery can schedule for itself:
 * the condition that matters — still no acknowledgement — is only knowable later,
 * and the call that would have scheduled the retry may itself have failed.
 *
 * `orders.acknowledged_at` is the same field the Acknowledge button on the staff
 * dashboard writes, so a member of staff tapping it on the kitchen screen stops
 * the phone ringing, with no separate state to keep in sync.
 */
export async function requeueUnacknowledgedOrders(now: number = Date.now()): Promise<number> {
  await ensureDatabase();
  if (!restaurantAlertNumber() || !publicBaseUrl()) return 0;

  const stale = now - voiceRetryMinutes() * 60_000;
  // Bounded to the last few hours: an order left unacknowledged overnight is an
  // operational problem, not something to keep phoning about forever.
  const horizon = now - 6 * 60 * 60 * 1000;
  const result = await getD1()
    .prepare(
      `UPDATE notification_outbox SET status = 'retrying', scheduled_for = ?, updated_at = ?
       WHERE kind = 'restaurant_new_order'
         AND status = 'sent'
         AND attempt_count < ?
         AND updated_at < ?
         AND payload_json::jsonb->>'orderId' IN (
           SELECT id FROM orders
           WHERE acknowledged_at IS NULL
             AND status NOT IN ('cancelled', 'completed')
             AND created_at > ?
         )`,
    )
    .bind(now, now, voiceRetryLimit(), stale, horizon)
    .run();
  return result.meta.changes ?? 0;
}
