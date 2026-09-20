/**
 * Selling a gift card: from the form on `/gift-cards` to a card in an inbox.
 *
 * ## The card is minted only on confirmed capture
 *
 * Never at purchase time, and this is the single most important line in the
 * file. A gift card is merchandise that is delivered instantly, costs nothing to
 * produce and is spendable by whoever holds the code — which makes it the
 * classic cash-out for a stolen credit card. Minting before the money is
 * confirmed would let someone type a stolen card number, receive a spendable
 * balance by email a second later, and leave the restaurant holding the
 * chargeback *and* the redemption.
 *
 * So: the purchase row is written first with no card behind it, Clover is asked
 * for money, and only an `APPROVED` outcome — through the webhook, or through
 * the synchronous charge on the inline path — calls `completeGiftCardPurchase`.
 * The other controls are the amount ceiling in lib/gift-cards.ts and the rate
 * limit on the purchase route.
 *
 * ## Why this is not an order
 *
 * See the comment on `gift_card_purchases` in db/schema.ts. The short version:
 * nothing is cooked, no HST is charged, there is no address and no kitchen
 * ticket, and every one of `orders`' constraints would have to be worked around.
 */
import { getD1, getSetting } from "@/db/runtime";
import { normalizeAttribution } from "@/lib/attribution";
import {
  cloverCheckoutConfigured,
  cloverIframeEnabled,
  createCloverCharge,
  createCloverCheckout,
  CloverDeclinedError,
} from "@/lib/clover";
import { formatMoney } from "@/lib/domain";
import { GIFT_CARD_MESSAGE_MAX, giftCardAmountError, parseGiftCardAmountCents } from "@/lib/gift-cards";
import { mintGiftCard } from "@/lib/gift-card-store";
import { anyProviderConfigured } from "@/lib/notifications/config";
import { dispatchSoon } from "@/lib/notifications/dispatcher";

/** Mirrors `OrderValidationError`, so the routes map both the same way. */
export class GiftCardValidationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "GIFT_CARD_PURCHASE_INVALID") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type GiftCardPurchaseRequest = {
  idempotencyKey?: string;
  amountCents?: number | string;
  buyer?: { name?: string; email?: string };
  recipient?: { name?: string; email?: string };
  message?: string;
  paymentToken?: string;
  attribution?: unknown;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function personName(raw: unknown, field: string): string {
  const value = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (value.length < 2 || value.length > 80) {
    throw new GiftCardValidationError(`Enter ${field}.`);
  }
  return value;
}

function emailAddress(raw: unknown, field: string): string {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!EMAIL.test(value) || value.length > 200) {
    throw new GiftCardValidationError(`Enter a valid ${field}.`);
  }
  return value;
}

/**
 * The personal message, kept as typed apart from length and control characters.
 *
 * It is quoted verbatim into an email the recipient reads, so it is escaped at
 * render time (`escapeHtml`) rather than stripped here — mangling someone's
 * apostrophes to avoid an injection they are already protected from would be
 * solving the wrong problem in the wrong place.
 */
function personalMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  if (!value) return null;
  if (value.length > GIFT_CARD_MESSAGE_MAX) {
    throw new GiftCardValidationError(
      `Keep the message to ${GIFT_CARD_MESSAGE_MAX} characters or fewer.`,
    );
  }
  return value;
}

export type ValidatedGiftCardPurchase = {
  amountCents: number;
  buyerName: string;
  buyerEmail: string;
  recipientName: string;
  recipientEmail: string;
  message: string | null;
};

/** Everything the form supplied, checked. Server-side, because the form is not. */
export function validateGiftCardPurchase(body: GiftCardPurchaseRequest): ValidatedGiftCardPurchase {
  const amountCents = parseGiftCardAmountCents(body.amountCents);
  const amountError = giftCardAmountError(amountCents);
  if (amountError || amountCents === null) {
    throw new GiftCardValidationError(amountError ?? "Choose an amount.", 400, "GIFT_CARD_AMOUNT_INVALID");
  }
  return {
    amountCents,
    buyerName: personName(body.buyer?.name, "your name"),
    buyerEmail: emailAddress(body.buyer?.email, "email address for your receipt"),
    recipientName: personName(body.recipient?.name, "who the card is for"),
    recipientEmail: emailAddress(body.recipient?.email, "email address for the recipient"),
    message: personalMessage(body.message),
  };
}

export type StartedGiftCardPurchase =
  | { status: "paid"; reference: string; purchaseId: string; amountCents: number; recipientEmail: string }
  | {
      status: "awaiting_payment";
      reference: string;
      purchaseId: string;
      amountCents: number;
      recipientEmail: string;
      checkoutUrl: string;
      sessionId: string;
    };

/**
 * Takes the money and, if it clears, creates the card.
 *
 * Structurally the same as `createOrder`'s payment handling, and deliberately
 * so: the inline card path resolves inside this request, the hosted path hands
 * back a URL and waits for a webhook, and a failure on either releases the
 * idempotency key so the buyer can try again with another card.
 */
export async function startGiftCardPurchase(
  body: GiftCardPurchaseRequest,
): Promise<StartedGiftCardPurchase> {
  const idempotencyKey = body.idempotencyKey?.trim() ?? "";
  if (idempotencyKey.length < 20 || idempotencyKey.length > 200) {
    throw new GiftCardValidationError("A valid checkout key is required.");
  }
  if (!(await cloverCheckoutConfigured())) {
    throw new GiftCardValidationError(
      "Gift cards are waiting on the restaurant's card payment credentials. No payment was taken.",
      503,
      "PAYMENT_SETUP_REQUIRED",
    );
  }
  const purchase = validateGiftCardPurchase(body);

  // The same durable-key contract orders use. A duplicate submission — a double
  // tap, a refresh mid-charge — resolves to the purchase that already exists
  // instead of selling a second card.
  const existing = await getD1()
    .prepare(
      `SELECT id, reference, status, amount_cents, recipient_email, provider_reference
         FROM gift_card_purchases WHERE idempotency_key = ? AND status <> 'failed'`,
    )
    .bind(idempotencyKey)
    .first<{
      id: string;
      reference: string;
      status: string;
      amount_cents: number;
      recipient_email: string;
      provider_reference: string | null;
    }>();
  if (existing) {
    if (existing.status === "paid") {
      return {
        status: "paid",
        reference: existing.reference,
        purchaseId: existing.id,
        amountCents: Number(existing.amount_cents),
        recipientEmail: existing.recipient_email,
      };
    }
    throw new GiftCardValidationError(
      "This gift card purchase is already being processed. Wait a moment and try again.",
      409,
      "PURCHASE_IN_PROGRESS",
    );
  }

  const sequence = await getD1()
    .prepare(
      "UPDATE order_sequences SET current_number = current_number + 1 WHERE key = 'gift_card' RETURNING current_number",
    )
    .first<{ current_number: number }>();
  if (!sequence) throw new Error("Gift card sequence is unavailable");

  const purchaseId = crypto.randomUUID();
  const reference = `GC-${sequence.current_number}`;
  const now = Date.now();
  const paymentToken = typeof body.paymentToken === "string" ? body.paymentToken.trim() : "";
  if (paymentToken.length > 500) {
    throw new GiftCardValidationError("That payment could not be read.", 400, "INVALID_PAYMENT_TOKEN");
  }
  const attribution = normalizeAttribution(body.attribution);

  await getD1()
    .prepare(
      `INSERT INTO gift_card_purchases
       (id, reference, amount_cents, buyer_name, buyer_email, recipient_name, recipient_email,
        message, status, provider, idempotency_key, attribution_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', 'clover', ?, ?, ?, ?)`,
    )
    .bind(
      purchaseId,
      reference,
      purchase.amountCents,
      purchase.buyerName,
      purchase.buyerEmail,
      purchase.recipientName,
      purchase.recipientEmail,
      purchase.message,
      idempotencyKey,
      attribution ? JSON.stringify(attribution) : null,
      now,
      now,
    )
    .run();

  const inline = paymentToken && (await cloverIframeEnabled());
  if (inline) {
    try {
      const charge = await createCloverCharge({
        amountCents: purchase.amountCents,
        sourceToken: paymentToken,
        idempotencyKey,
        orderNumber: reference,
        customerEmail: purchase.buyerEmail,
        description: `Pizza 62 gift card ${reference}`,
      });
      await completeGiftCardPurchase(purchaseId, charge.chargeId);
      return {
        status: "paid",
        reference,
        purchaseId,
        amountCents: purchase.amountCents,
        recipientEmail: purchase.recipientEmail,
      };
    } catch (error) {
      const declined = error instanceof CloverDeclinedError;
      await failGiftCardPurchase(
        purchaseId,
        error instanceof Error ? error.message : "Clover charge failed",
      );
      throw new GiftCardValidationError(
        declined
          ? "That card was declined. No payment was taken and no gift card was created — try another card."
          : "We could not confirm that payment, so no gift card was created. Please try again.",
        declined ? 402 : 502,
        declined ? "PAYMENT_DECLINED" : "PAYMENT_PROVIDER_ERROR",
      );
    }
  }

  try {
    const checkout = await createCloverCheckout({
      orderNumber: reference,
      customerName: purchase.buyerName,
      customerEmail: purchase.buyerEmail,
      // Clover wants a phone number; a gift card buyer is never asked for one,
      // and inventing a plausible-looking number would be worse than an empty
      // string, which is honestly "we do not have this".
      customerPhone: "",
      totalCents: purchase.amountCents,
      summary: `${formatMoney(purchase.amountCents)} gift card for ${purchase.recipientName}`,
      lineItemName: `Pizza 62 gift card ${reference}`,
      returnPath: "/gift-cards/return",
    });
    // As with orders, this row is the only link from the checkout session back
    // to what was bought — Clover has no metadata passthrough — and it is
    // written before the URL reaches the buyer.
    await getD1()
      .prepare("UPDATE gift_card_purchases SET provider_reference = ?, updated_at = ? WHERE id = ?")
      .bind(checkout.checkoutSessionId, Date.now(), purchaseId)
      .run();
    return {
      status: "awaiting_payment",
      reference,
      purchaseId,
      amountCents: purchase.amountCents,
      recipientEmail: purchase.recipientEmail,
      checkoutUrl: checkout.href,
      sessionId: checkout.checkoutSessionId,
    };
  } catch (error) {
    await failGiftCardPurchase(
      purchaseId,
      error instanceof Error ? error.message : "Clover checkout failed",
    );
    throw new GiftCardValidationError(
      "Card payment could not start, so no gift card was created. Please try again.",
      502,
      "PAYMENT_PROVIDER_ERROR",
    );
  }
}

/**
 * Marks a purchase failed, which is also what releases its idempotency key.
 *
 * `gift_card_purchases_idempotency_uq` excludes failed rows for exactly this
 * reason — the row stays for reconciliation while the buyer is free to retry
 * with the same key. The same trick, and the same trap, as `payments`.
 */
export async function failGiftCardPurchase(purchaseId: string, reason: string): Promise<void> {
  await getD1()
    .prepare(
      `UPDATE gift_card_purchases
          SET status = 'failed', failure_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'awaiting_payment'`,
    )
    .bind(reason.slice(0, 500), Date.now(), purchaseId)
    .run();
}

/**
 * The money cleared: create the card and send it.
 *
 * Idempotent, because it is reached from two places that can both fire for the
 * same purchase — the synchronous charge and a redelivered Clover webhook. The
 * guarded UPDATE is the whole mechanism: whoever moves the purchase to `paid`
 * owns the minting, and a second caller changes no rows and returns. Without it,
 * a redelivery would issue a second card for one payment.
 *
 * The guard is `status <> 'paid'` rather than `status = 'awaiting_payment'`,
 * which matters in one narrow case: the reaper marks a purchase failed twenty
 * minutes in, and an approval arrives after that. Clover saying APPROVED means
 * the money is real, whatever our own timer assumed, and a customer who has been
 * charged must get their card. Excluding only `paid` keeps the double-issue
 * protection while letting a late approval through.
 */
export async function completeGiftCardPurchase(
  purchaseId: string,
  providerReference: string | null,
  now: number = Date.now(),
): Promise<void> {
  const claimed = await getD1()
    .prepare(
      `UPDATE gift_card_purchases
          SET status = 'paid', provider_reference = COALESCE(?, provider_reference),
              failure_reason = NULL, updated_at = ?
        WHERE id = ? AND status <> 'paid'`,
    )
    .bind(providerReference, now, purchaseId)
    .run();
  if (!claimed.meta.changes) return;

  const purchase = await getD1()
    .prepare(
      `SELECT id, reference, amount_cents, buyer_name, buyer_email, recipient_name,
              recipient_email, message
         FROM gift_card_purchases WHERE id = ?`,
    )
    .bind(purchaseId)
    .first<{
      id: string;
      reference: string;
      amount_cents: number;
      buyer_name: string;
      buyer_email: string;
      recipient_name: string;
      recipient_email: string;
      message: string | null;
    }>();
  if (!purchase) return;

  const card = await mintGiftCard({
    amountCents: Number(purchase.amount_cents),
    origin: "purchase",
    purchaseId: purchase.id,
    recipientName: purchase.recipient_name,
    recipientEmail: purchase.recipient_email,
    senderName: purchase.buyer_name,
    message: purchase.message,
    actorType: "customer",
    note: `Purchased as ${purchase.reference}`,
    now,
  });

  const outboxStatus = (await anyProviderConfigured()) ? "pending" : "pending_provider_setup";
  const statements = [
    // The plaintext code travels in the payload because it cannot be recovered
    // from anywhere else — identical to the tracking token at order creation,
    // and for the identical reason. The dispatcher scrubs the payload once the
    // message is sent, so the exposure is the queue window rather than forever.
    getD1()
      .prepare(
        `INSERT INTO notification_outbox
         (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
         VALUES (?, 'gift_card_delivery', ?, ?, ?, 0, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        purchase.recipient_email,
        JSON.stringify({
          giftCardPurchaseId: purchase.id,
          giftCardId: card.id,
          reference: purchase.reference,
          code: card.code,
        }),
        outboxStatus,
        now,
        now,
        now,
      ),
  ];

  // The buyer's receipt, which deliberately does **not** carry the code: a
  // receipt is the thing people forward to whoever is splitting the cost, and a
  // forwarded receipt must not be a spendable card. It is skipped entirely when
  // someone has bought a card for themselves, because then it is the same
  // message twice and one of them is worse.
  if (purchase.buyer_email !== purchase.recipient_email) {
    statements.push(
      getD1()
        .prepare(
          `INSERT INTO notification_outbox
           (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
           VALUES (?, 'gift_card_receipt', ?, ?, ?, 0, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          purchase.buyer_email,
          JSON.stringify({ giftCardPurchaseId: purchase.id, reference: purchase.reference }),
          outboxStatus,
          now,
          now,
          now,
        ),
    );
  }
  await getD1().batch(statements);

  // The card exists and somebody is waiting for it in their inbox, so it goes
  // now rather than on the next cron tick. Not awaited: the outbox rows are
  // durable and the sweeper is the safety net — and on the webhook path Clover
  // is holding the response open.
  dispatchSoon();
}

export type GiftCardPurchaseStatus = {
  reference: string;
  status: string;
  amountCents: number;
  recipientEmail: string;
  recipientName: string;
};

/**
 * What the return page polls while it waits for Clover's webhook.
 *
 * Addressed by the checkout session id — an unguessable UUID Clover minted —
 * rather than by `reference`, which is sequential and would let anyone read off
 * every gift card sale the restaurant has made by counting upwards.
 */
export async function giftCardPurchaseBySession(
  sessionId: string,
): Promise<GiftCardPurchaseStatus | null> {
  if (!sessionId || sessionId.length > 200) return null;
  const row = await getD1()
    .prepare(
      `SELECT reference, status, amount_cents, recipient_email, recipient_name
         FROM gift_card_purchases WHERE provider_reference = ?`,
    )
    .bind(sessionId)
    .first<{
      reference: string;
      status: string;
      amount_cents: number;
      recipient_email: string;
      recipient_name: string;
    }>();
  if (!row) return null;
  return {
    reference: row.reference,
    status: row.status,
    amountCents: Number(row.amount_cents),
    recipientEmail: row.recipient_email,
    recipientName: row.recipient_name,
  };
}

/** Whether the storefront should offer gift cards at all. */
export async function giftCardsAvailable(): Promise<boolean> {
  const [configured, ordering] = await Promise.all([
    cloverCheckoutConfigured(),
    getSetting<{ giftCardsEnabled?: boolean }>("ordering").catch(() => ({ giftCardsEnabled: true })),
  ]);
  // Opt-out rather than opt-in: the owner asked for this feature, and a setting
  // that defaults to off is a feature that ships switched off by accident.
  return configured && ordering.giftCardsEnabled !== false;
}
