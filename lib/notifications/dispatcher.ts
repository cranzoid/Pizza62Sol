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
  isCustomerNotifiableStatus,
  renderCustomerConfirmation,
  renderCustomerStatusUpdate,
  renderFeedbackReply,
  renderFeedbackRequest,
  renderFeedbackReward,
  renderGiftCardDelivery,
  renderGiftCardReceipt,
  renderGiveawayEntry,
  renderGiveawayNudge,
  renderLowRatingAlert,
  renderRestaurantNewOrder,
  type OrderSnapshot,
} from "@/lib/notifications/messages";
import { activeFeedbackReward } from "@/lib/rewards";
import { giveawayStatus, isNudgeKind } from "@/lib/giveaway";
import { entriesForEmail, loadGiveaway } from "@/lib/giveaway-store";
import { isOptedOut, unsubscribeQuery } from "@/lib/marketing-consent";

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
  /** Rows un-parked because credentials appeared since they were queued. */
  released: number;
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
         -- Everything else before a giveaway nudge. A nudge is marketing that
         -- can go out a minute later; a receipt or a kitchen alert cannot, and
         -- must never wait behind a backlog of them.
         ORDER BY (kind = 'giveaway_nudge'), scheduled_for
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

/**
 * The whole order, because the messages describe the whole order.
 *
 * The money columns and `instructions` were added when the emails stopped being
 * one line of text: a confirmation that shows a total with no subtotal, HST or
 * delivery fee is one the customer cannot check against their card statement.
 */
async function loadOrder(orderId: string): Promise<OrderSnapshot | null> {
  return getD1()
    .prepare(
      `SELECT id, order_number, customer_name, customer_email, customer_phone, fulfilment,
              channel, status, payment_status, payment_method, schedule_type, scheduled_for,
              estimated_for, subtotal_cents, discount_cents, tax_cents, delivery_fee_cents,
              tip_cents, total_cents, gift_card_applied_cents, address_json, instructions,
              acknowledged_at, created_at
       FROM orders WHERE id = ?`,
    )
    .bind(orderId)
    .first<OrderSnapshot>();
}

type GiftCardPurchaseSnapshot = {
  id: string;
  reference: string;
  amount_cents: number;
  buyer_name: string;
  buyer_email: string;
  recipient_name: string;
  recipient_email: string;
  message: string | null;
  status: string;
  created_at: number;
};

/**
 * The gift card sale behind a delivery or a receipt.
 *
 * The sibling of `loadOrder`, against the other table. Everything except the
 * code itself is read here at send time rather than carried in the payload, for
 * the reason given at the top of messages.ts: a message assembled from the
 * database describes itself correctly even if something changed while it queued.
 * The code is the one exception, because nothing can reconstruct it.
 */
async function loadGiftCardPurchase(purchaseId: string): Promise<GiftCardPurchaseSnapshot | null> {
  return getD1()
    .prepare(
      `SELECT id, reference, amount_cents, buyer_name, buyer_email, recipient_name,
              recipient_email, message, status, created_at
       FROM gift_card_purchases WHERE id = ?`,
    )
    .bind(purchaseId)
    .first<GiftCardPurchaseSnapshot>();
}

type GiftCardDeliverySnapshot = {
  initial_cents: number;
  recipient_name: string;
  recipient_email: string;
  sender_name: string;
  message: string | null;
  status: string;
};

/** The card itself, for a staff-issued one that has no sale behind it. */
async function loadGiftCardForDelivery(giftCardId: string): Promise<GiftCardDeliverySnapshot | null> {
  return getD1()
    .prepare(
      `SELECT initial_cents, recipient_name, recipient_email, sender_name, message, status
       FROM gift_cards WHERE id = ?`,
    )
    .bind(giftCardId)
    .first<GiftCardDeliverySnapshot>();
}

/** Thrown when a row can never succeed — bad kind, missing order, no recipient. */
class PermanentFailure extends Error {}

/** Thrown when the row should wait for credentials rather than spend an attempt. */
class ParkForSetup extends Error {}

/**
 * Thrown when a row should quietly not be sent — a nudge to someone who has
 * since unsubscribed, or one still queued when the giveaway closed. Marked
 * `cancelled` rather than `failed`: nothing went wrong, and a failed row is
 * something a person is expected to look into.
 */
class SkipDelivery extends Error {}

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
      const message = await renderCustomerConfirmation(order, payload);
      const to = row.recipient ?? order.customer_email;
      if (!to) throw new PermanentFailure("no recipient address");
      await sendEmail({ to, subject: message.emailSubject, text: message.emailText, html: message.emailHtml });
      // Additive only, and off by default — see config.ts on why an unregistered
      // local long code cannot be trusted to deliver. A failure here must not
      // undo the email that already went.
      if (order.customer_phone && (await customerSmsEnabled())) {
        await sendSms({ to: order.customer_phone, body: message.smsBody }).catch(() => undefined);
      }
      return;
    }

    case "restaurant_new_order": {
      if (!orderId) throw new PermanentFailure("restaurant alert payload has no orderId");
      const order = await loadOrder(orderId);
      if (!order) throw new PermanentFailure(`order ${orderId} no longer exists`);
      if (order.status === "cancelled") throw new PermanentFailure("order was cancelled");
      const message = await renderRestaurantNewOrder(order);
      const alertNumber = await restaurantAlertNumber();

      // Email and voice are the reliable pair (see §9's SMS caveat); SMS is a
      // best-effort extra and is never allowed to fail the row on its own.
      let delivered = false;
      const business = await getSetting<{ email?: string }>("business").catch(() => ({ email: undefined }));
      const to = row.recipient ?? business.email;
      if (to) {
        await sendEmail({ to, subject: message.emailSubject, text: message.emailText, html: message.emailHtml });
        delivered = true;
      }
      if (alertNumber) {
        await sendSms({ to: alertNumber, body: message.smsBody }).catch(() => undefined);
        const base = await publicBaseUrl();
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
      const message = await renderLowRatingAlert(payload as Parameters<typeof renderLowRatingAlert>[0]);
      const business = await getSetting<{ email?: string }>("business").catch(() => ({ email: undefined }));
      const to = row.recipient ?? business.email;
      if (!to) throw new ParkForSetup("no restaurant email configured for alerts");
      await sendEmail({ to, subject: message.emailSubject, text: message.emailText, html: message.emailHtml });
      return;
    }

    /**
     * The kitchen moved the order and the customer is told.
     *
     * Queued by the staff dashboard when a status button is pressed, which is
     * why the status travels in the payload rather than being read off the order:
     * by the time a retry runs, the order may have moved on again, and the
     * customer would be sent "ready for pickup" after they had collected it.
     *
     * A cancelled order is dropped rather than delivered — the cancellation is
     * handled on its own path and a stale "on its way" behind it is worse than
     * silence.
     */
    case "customer_status_update": {
      if (!orderId) throw new PermanentFailure("status update payload has no orderId");
      const order = await loadOrder(orderId);
      if (!order) throw new PermanentFailure(`order ${orderId} no longer exists`);
      if (order.status === "cancelled") throw new PermanentFailure("order was cancelled");
      const to = row.recipient ?? order.customer_email;
      if (!to) throw new PermanentFailure("no recipient address");
      // Checked before rendering so a payload naming a status we have no copy for
      // fails once instead of being retried six times against a renderer that
      // will throw identically every time.
      const status = String(payload.status ?? order.status);
      if (!isCustomerNotifiableStatus(status)) {
        throw new PermanentFailure(`no customer copy for status "${status}"`);
      }
      const message = await renderCustomerStatusUpdate(order, payload as { status?: string });
      await sendEmail({ to, subject: message.emailSubject, text: message.emailText, html: message.emailHtml });
      // Same rule as the confirmation: SMS is additive, off by default, and may
      // never fail the row on its own.
      if (order.customer_phone && (await customerSmsEnabled())) {
        await sendSms({ to: order.customer_phone, body: message.smsBody }).catch(() => undefined);
      }
      return;
    }

    case "feedback_request": {
      if (!orderId) throw new PermanentFailure("feedback payload has no orderId");
      const order = await loadOrder(orderId);
      if (!order) throw new PermanentFailure(`order ${orderId} no longer exists`);
      // Asking someone how their cancelled order was is worse than saying nothing.
      if (order.status !== "completed") throw new PermanentFailure("order did not complete");
      const message = await renderFeedbackRequest(order, payload);
      const to = row.recipient ?? order.customer_email;
      if (!to) throw new PermanentFailure("no recipient address");
      await sendEmail({ to, subject: message.emailSubject, text: message.emailText, html: message.emailHtml });
      return;
    }

    /**
     * The thank-you coupon, sent to everyone who filled in the form.
     *
     * The offer is looked up here, at send time, rather than carried in the
     * payload — so a code the owner has since renamed, revalued or switched off
     * cannot go out quoting yesterday's terms. If it no longer resolves to a
     * live promotion the row parks instead of failing: the owner has almost
     * certainly just turned it off for a week, and a `failed` row is one nobody
     * comes back to.
     */
    case "feedback_reward": {
      if (!orderId) throw new PermanentFailure("reward payload has no orderId");
      const order = await loadOrder(orderId);
      if (!order) throw new PermanentFailure(`order ${orderId} no longer exists`);
      const to = row.recipient ?? order.customer_email;
      if (!to) throw new PermanentFailure("no recipient address");
      const reward = await activeFeedbackReward();
      if (!reward) throw new ParkForSetup("no live promotion behind the feedback reward code");
      const message = await renderFeedbackReward(order, reward);
      await sendEmail({ to, subject: message.emailSubject, text: message.emailText, html: message.emailHtml });
      return;
    }

    /**
     * What the restaurant wrote back, sent to the customer who wrote in.
     *
     * Email only, on purpose. A reply worth sending is a paragraph or three,
     * and a paragraph delivered as four concatenated text messages is not a
     * reply, it is an imposition — so the customer's phone number is left
     * alone here even where SMS is switched on for the operational messages.
     *
     * The Reply-To is the restaurant's own address rather than the sending
     * domain, so an answer to this lands in a mailbox someone opens. Without
     * one the message would invite a conversation it cannot receive.
     */
    case "feedback_reply": {
      if (!orderId) throw new PermanentFailure("reply payload has no orderId");
      const order = await loadOrder(orderId);
      if (!order) throw new PermanentFailure(`order ${orderId} no longer exists`);
      const to = row.recipient ?? order.customer_email;
      if (!to) throw new PermanentFailure("no recipient address");
      const reply = typeof payload.reply === "string" ? payload.reply.trim() : "";
      // An empty reply is a mail that says nothing over the restaurant's name.
      // It can never become non-empty on a retry, so it fails rather than loops.
      if (!reply) throw new PermanentFailure("reply payload has no message");
      const message = await renderFeedbackReply(order, payload as Parameters<typeof renderFeedbackReply>[1]);
      const business = await getSetting<{ email?: string }>("business").catch(() => ({ email: undefined }));
      await sendEmail({
        to,
        subject: message.emailSubject,
        text: message.emailText,
        html: message.emailHtml,
        replyTo: business.email ?? null,
      });
      return;
    }

    /**
     * The gift card itself, to whoever it was bought for.
     *
     * The only kind here whose payload carries something irreplaceable. The
     * plaintext code is in the outbox row because nothing can regenerate it —
     * `gift_cards` holds a digest and nothing else — exactly as the tracking
     * token is, and with the same trade: it sits in the queue for the life of
     * the row and `markSent` scrubs it the moment the message is gone.
     *
     * Note what is *not* here: no `loadOrder`. A gift card sale is not an order
     * and has no row in `orders`, so this kind carries a purchase id instead and
     * the switch reads it straight out of the payload.
     */
    case "gift_card_delivery": {
      const code = typeof payload.code === "string" ? payload.code : "";
      // A scrubbed or malformed payload can never become a card on a retry, so
      // it fails once instead of looping six times against an empty code.
      if (!code) throw new PermanentFailure("gift card payload has no code");

      /**
       * Two kinds of card arrive here, and the difference is where the facts
       * live. A purchased card has a sale behind it, so the amount and the two
       * names come from `gift_card_purchases`. A staff-issued promotional card
       * has no sale at all, so they come from the card row itself.
       *
       * The status guard matters more than it looks in both cases: emailing a
       * spendable code for a sale that has since been refunded, or for a card
       * staff have already voided, is the one mistake on this path that gives
       * money away.
       */
      const purchaseId = typeof payload.giftCardPurchaseId === "string" ? payload.giftCardPurchaseId : null;
      const giftCardId = typeof payload.giftCardId === "string" ? payload.giftCardId : null;
      let details: { amountCents: number; recipientName: string; recipientEmail: string; senderName: string; message: string | null };

      if (purchaseId) {
        const purchase = await loadGiftCardPurchase(purchaseId);
        if (!purchase) throw new PermanentFailure(`gift card purchase ${purchaseId} no longer exists`);
        if (purchase.status !== "paid") throw new PermanentFailure("gift card purchase is not paid");
        details = {
          amountCents: Number(purchase.amount_cents),
          recipientName: purchase.recipient_name,
          recipientEmail: purchase.recipient_email,
          senderName: purchase.buyer_name,
          message: purchase.message,
        };
      } else if (giftCardId) {
        const card = await loadGiftCardForDelivery(giftCardId);
        if (!card) throw new PermanentFailure(`gift card ${giftCardId} no longer exists`);
        if (card.status !== "active") throw new PermanentFailure("gift card is not active");
        details = {
          // `initial_cents`, not the balance: this is the card as issued, and a
          // retry after a first spend must not quote a smaller card than the one
          // the recipient was given.
          amountCents: Number(card.initial_cents),
          recipientName: card.recipient_name,
          recipientEmail: card.recipient_email,
          senderName: card.sender_name,
          message: card.message,
        };
      } else {
        throw new PermanentFailure("gift card payload identifies no card");
      }

      const to = row.recipient ?? details.recipientEmail;
      if (!to) throw new PermanentFailure("no recipient address");
      const message = await renderGiftCardDelivery({
        amountCents: details.amountCents,
        code,
        recipientName: details.recipientName,
        senderName: details.senderName,
        message: details.message,
      });
      await sendEmail({ to, subject: message.emailSubject, text: message.emailText, html: message.emailHtml });
      return;
    }

    /** The buyer's receipt. Carries no code — see `renderGiftCardReceipt`. */
    case "gift_card_receipt": {
      const purchaseId = typeof payload.giftCardPurchaseId === "string" ? payload.giftCardPurchaseId : null;
      if (!purchaseId) throw new PermanentFailure("gift card receipt payload has no purchase id");
      const purchase = await loadGiftCardPurchase(purchaseId);
      if (!purchase) throw new PermanentFailure(`gift card purchase ${purchaseId} no longer exists`);
      if (purchase.status !== "paid") throw new PermanentFailure("gift card purchase is not paid");
      const to = row.recipient ?? purchase.buyer_email;
      if (!to) throw new PermanentFailure("no recipient address");
      const message = await renderGiftCardReceipt({
        reference: purchase.reference,
        amountCents: Number(purchase.amount_cents),
        recipientName: purchase.recipient_name,
        recipientEmail: purchase.recipient_email,
        buyerName: purchase.buyer_name,
        sentAt: Number(purchase.created_at),
      });
      await sendEmail({ to, subject: message.emailSubject, text: message.emailText, html: message.emailHtml });
      return;
    }

    /**
     * "You're in the Thanksgiving Giveaway", to a customer whose order earned
     * an entry. Queued by `recordGiveawayEntry` in the same transaction as the
     * entry itself, so there is always an entry to describe.
     */
    case "giveaway_entry": {
      if (!orderId) throw new PermanentFailure("giveaway entry payload has no orderId");
      const order = await loadOrder(orderId);
      if (!order) throw new PermanentFailure(`order ${orderId} no longer exists`);
      if (order.status === "cancelled") throw new SkipDelivery("order was cancelled");
      const [giveaway, entry] = await Promise.all([
        loadGiveaway(),
        getD1()
          .prepare("SELECT entry_number, giveaway_id FROM giveaway_entries WHERE order_id = ?")
          .bind(orderId)
          .first<{ entry_number: number; giveaway_id: string }>(),
      ]);
      if (!giveaway || !entry) throw new PermanentFailure("no giveaway entry for this order");
      const to = row.recipient ?? order.customer_email;
      if (!to) throw new PermanentFailure("no recipient address");
      const message = await renderGiveawayEntry(order, {
        entryNumber: Number(entry.entry_number),
        giveaway,
        totalEntries: await entriesForEmail(to, entry.giveaway_id),
      });
      await sendEmail({ to, subject: message.emailSubject, text: message.emailText, html: message.emailHtml });
      return;
    }

    /**
     * A giveaway nudge to a past customer — marketing, so it is the one kind
     * that checks consent at the moment of sending, not just when it was
     * queued. Someone who unsubscribed from the first nudge on Monday must not
     * receive the second on Friday because it was queued on Sunday.
     */
    case "giveaway_nudge": {
      const to = row.recipient ?? "";
      if (!to) throw new PermanentFailure("nudge has no recipient");
      const variant = payload.variant ?? payload.nudge;
      if (!isNudgeKind(variant)) throw new PermanentFailure(`unknown nudge "${String(variant)}"`);
      const giveaway = await loadGiveaway();
      // A nudge still queued once entries have closed would invite someone to
      // order for a chance that no longer exists.
      if (giveawayStatus(giveaway, Date.now()) !== "open" || !giveaway) throw new SkipDelivery("the giveaway is not open");
      if (!payload.test && (await isOptedOut(to))) throw new SkipDelivery("recipient unsubscribed");
      const base = await publicBaseUrl();
      if (!base) throw new ParkForSetup("a nudge needs PUBLIC_BASE_URL for its unsubscribe link");
      const query = await unsubscribeQuery(to);
      const message = await renderGiveawayNudge({
        name: typeof payload.name === "string" ? payload.name : "",
        variant,
        giveaway,
        entries: await entriesForEmail(to, giveaway.id),
        unsubscribeHref: `${base}/unsubscribe?${query}`,
        test: Boolean(payload.test),
      });
      await sendEmail({
        to,
        subject: message.emailSubject,
        text: message.emailText,
        html: message.emailHtml,
        // RFC 8058: the mail client's own "Unsubscribe" button, which posts
        // to this URL without the customer ever opening the email.
        headers: {
          "List-Unsubscribe": `<${base}/api/marketing/unsubscribe?${query}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
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
  // Note what survives: identifiers only. The tracking token, the feedback
  // token and — the one that is literally money — the gift card code are all
  // dropped by being absent from this object rather than deleted from the old
  // one, so a payload field added later is scrubbed by default instead of
  // having to be remembered here.
  const redacted = JSON.stringify({
    orderId: payload.orderId ?? null,
    orderNumber: payload.orderNumber ?? null,
    giftCardPurchaseId: payload.giftCardPurchaseId ?? null,
    giftCardId: payload.giftCardId ?? null,
    reference: payload.reference ?? null,
    // Which giveaway email this was. Kept because the nudge screen counts
    // progress by `sendId` and "already nudged" by `campaign` + `nudge`; the
    // customer's name, which the payload also carried, is dropped.
    giveawayId: payload.giveawayId ?? null,
    sendId: payload.sendId ?? null,
    campaign: payload.campaign ?? null,
    nudge: payload.nudge ?? null,
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

async function markSkipped(row: OutboxRow, reason: string, now: number): Promise<void> {
  await getD1()
    .prepare("UPDATE notification_outbox SET status = 'cancelled', last_error = ?, updated_at = ? WHERE id = ?")
    .bind(reason.slice(0, 500), now, row.id)
    .run();
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
 * Releases everything parked waiting for credentials that now exist.
 *
 * `pending_provider_setup` is not in `CLAIMABLE`, which is the whole point while
 * there is nothing to deliver with — but it also meant a parked row was parked
 * *forever*. Nothing anywhere moved it back. So the intended sequence — take
 * sample orders now, add the Twilio and email credentials afterwards, watch the
 * queue flush — did not work: every notification queued before the credentials
 * arrived stayed invisible, which is precisely the silence this release exists
 * to eliminate, reintroduced at the one moment it is most likely to happen.
 *
 * Cheap, idempotent, and matches nothing once the backlog is drained. Attempt
 * counts are untouched: waiting for credentials was never an attempt.
 */
async function releaseParkedRows(now: number): Promise<number> {
  const result = await getD1()
    .prepare(
      // GREATEST, not a plain overwrite: a row parked with a time still ahead
      // of it — a paced giveaway nudge — keeps its place rather than being
      // released early alongside everything else.
      `UPDATE notification_outbox
         SET status = 'pending', scheduled_for = GREATEST(scheduled_for, ?), last_error = NULL, updated_at = ?
       WHERE status = 'pending_provider_setup'`,
    )
    .bind(now, now)
    .run();
  return result.meta.changes ?? 0;
}

/**
 * Drains due outbox rows. Safe to run concurrently with itself and with inline
 * dispatch; safe to run when nothing is configured (it claims nothing).
 */
export async function dispatchOutbox(options: { limit?: number; now?: number } = {}): Promise<DispatchOutcome> {
  await ensureDatabase();
  const outcome: DispatchOutcome = { claimed: 0, sent: 0, retried: 0, failed: 0, parked: 0, released: 0 };
  // Note the `await`. Without it this negates a Promise, which is always falsy,
  // so the guard silently stops guarding and every row is claimed and burned
  // against providers that cannot deliver. TypeScript flags a bare `if (promise)`
  // but not `if (!promise)`, so only the test caught this.
  if (!(await anyProviderConfigured())) return outcome;

  const now = options.now ?? Date.now();
  // A provider exists, so anything parked for the lack of one is now deliverable.
  outcome.released = await releaseParkedRows(now);
  const rows = await claimDue(options.limit ?? 25, now);
  outcome.claimed = rows.length;

  for (const row of rows) {
    try {
      await deliver(row);
      await markSent(row, Date.now());
      outcome.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof SkipDelivery) {
        await markSkipped(row, message, Date.now());
      } else if (error instanceof ParkForSetup || error instanceof ChannelNotConfiguredError) {
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
  const [alertNumber, base, retryMinutes, retryLimit] = await Promise.all([
    restaurantAlertNumber(),
    publicBaseUrl(),
    voiceRetryMinutes(),
    voiceRetryLimit(),
  ]);
  if (!alertNumber || !base) return 0;

  const stale = now - retryMinutes * 60_000;
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
    .bind(now, now, retryLimit, stale, horizon)
    .run();
  return result.meta.changes ?? 0;
}
