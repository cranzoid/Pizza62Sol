/**
 * The database half of gift cards: minting them, finding them, and the three
 * statements that move money on and off one.
 *
 * ## The hold, and why it is shaped like this
 *
 * An order is created before it is paid for. Between those two moments the
 * money on the card has to be reserved, or two checkouts against the same card
 * both succeed and the restaurant gives away a balance twice. So `createOrder`
 * takes a **hold** — it decrements `balance_cents` inside the very transaction
 * that writes the order row — and exactly one of two things must follow:
 *
 *   capture   the payment cleared; the hold becomes permanent (lib/payment-completion.ts)
 *   release   it did not; the balance goes back (decline, expiry, staff cancel)
 *
 * **A hold with neither is a customer who has permanently lost money**, which is
 * why every path that can end an unpaid order calls `releaseGiftCardStatements`
 * and why the pairing is asserted in tests.
 *
 * ## How a race is made impossible rather than unlikely
 *
 * `holdGiftCardStatements` decrements **unconditionally** — there is no
 * `AND balance_cents >= ?` guard on the UPDATE — and lets the
 * `gift_cards_balance_nonneg` check constraint abort the whole transaction when
 * two orders reach the same last dollar. That is deliberate and it is stronger
 * than a guarded update: a guarded update that matches no rows *succeeds*, so
 * the order would commit with a redemption recorded against money that was never
 * taken, and someone would have to notice. A constraint violation rolls back the
 * order, the payment row, the outbox rows and the hold together.
 *
 * The second statement covers the other race — the card being voided between
 * the quote and the commit — by reading the balance back through a subquery
 * that is filtered on `status = 'active'`. A voided card yields NULL, and
 * `balance_after_cents` is NOT NULL, so that transaction aborts too.
 */
import { getD1 } from "@/db/runtime";
import {
  formatGiftCardCode,
  generateGiftCardCode,
  giftCardCodeSuffix,
  hashGiftCardCode,
  normalizeGiftCardCode,
  type RedeemableGiftCard,
} from "@/lib/gift-cards";

/** The stored row, as every caller here reads it. */
export type GiftCardRow = {
  id: string;
  code_suffix: string;
  initial_cents: number;
  balance_cents: number;
  currency: string;
  status: string;
  origin: string;
  purchase_id: string | null;
  recipient_name: string;
  recipient_email: string;
  sender_name: string;
  message: string | null;
  expires_at: number | null;
  issued_at: number;
  created_at: number;
  updated_at: number;
};

const CARD_COLUMNS = `id, code_suffix, initial_cents, balance_cents, currency, status, origin,
                      purchase_id, recipient_name, recipient_email, sender_name, message,
                      expires_at, issued_at, created_at, updated_at`;

/** The shape the redemption arithmetic takes, from a stored row. */
export function toRedeemable(row: GiftCardRow): RedeemableGiftCard {
  return {
    id: row.id,
    codeSuffix: row.code_suffix,
    balanceCents: Number(row.balance_cents ?? 0),
    status: String(row.status),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
  };
}

/**
 * Finds a card from what the customer typed.
 *
 * One indexed read on the hash. There is no way to go the other way: nothing
 * stored can produce a code, so this is also the only way a card is ever
 * identified from the outside.
 */
export async function lookupGiftCard(rawCode: unknown): Promise<GiftCardRow | null> {
  const body = normalizeGiftCardCode(rawCode);
  if (!body) return null;
  return getD1()
    .prepare(`SELECT ${CARD_COLUMNS} FROM gift_cards WHERE code_hash = ?`)
    .bind(await hashGiftCardCode(body))
    .first<GiftCardRow>();
}

export async function loadGiftCard(id: string): Promise<GiftCardRow | null> {
  return getD1()
    .prepare(`SELECT ${CARD_COLUMNS} FROM gift_cards WHERE id = ?`)
    .bind(id)
    .first<GiftCardRow>();
}

/**
 * Reserves money against an order, inside the order's own transaction.
 *
 * Returns statements rather than running them: the hold has to land in the same
 * `batch()` as the order row, or there is a window in which one exists without
 * the other.
 */
export function holdGiftCardStatements(input: {
  giftCardId: string;
  orderId: string;
  amountCents: number;
  actorType: "customer" | "staff";
  actorId?: string | null;
  note?: string | null;
  now: number;
  /** The background jobs hold their own handle; routes use the ambient one. */
  db?: D1Database;
}): D1PreparedStatement[] {
  const db = input.db ?? getD1();
  return [
    // Unconditional. `gift_cards_balance_nonneg` is the guard — see the header.
    db
      .prepare(
        "UPDATE gift_cards SET balance_cents = balance_cents - ?, updated_at = ? WHERE id = ? AND status = 'active'",
      )
      .bind(input.amountCents, input.now, input.giftCardId),
    // The balance is read back rather than computed, so the ledger records what
    // the card actually holds. The `status = 'active'` filter is load-bearing: a
    // card voided since the quote yields NULL here, and NOT NULL aborts the
    // transaction rather than letting the order commit against nothing.
    db
      .prepare(
        `INSERT INTO gift_card_transactions
         (id, gift_card_id, type, amount_cents, balance_after_cents, order_id, actor_type, actor_id, note, created_at)
         VALUES (?, ?, 'hold', ?, (SELECT balance_cents FROM gift_cards WHERE id = ? AND status = 'active'), ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        input.giftCardId,
        -input.amountCents,
        input.giftCardId,
        input.orderId,
        input.actorType,
        input.actorId ?? null,
        input.note ?? null,
        input.now,
      ),
  ];
}

/**
 * Makes the hold permanent. The balance already moved, so this writes only the
 * ledger row that says the hold resolved — which is what distinguishes a spent
 * card from one with money stranded on it.
 *
 * Idempotent, and it has to be: Clover redelivers webhooks, and the inline
 * charge path and a redelivered hosted-checkout event can both arrive for the
 * same order. The `NOT EXISTS` clause is what makes a second application a
 * no-op. A no-op is also the right answer for an order that used no gift card.
 */
export function captureGiftCardStatements(
  orderId: string,
  now: number,
  db: D1Database = getD1(),
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO gift_card_transactions
         (id, gift_card_id, type, amount_cents, balance_after_cents, order_id, actor_type, actor_id, note, created_at)
         SELECT ?::text, o.gift_card_id, 'capture', 0, g.balance_cents, o.id, 'system', NULL,
                'Payment cleared; gift card hold captured', ?::bigint
           FROM orders o
           JOIN gift_cards g ON g.id = o.gift_card_id
          WHERE o.id = ?
            AND o.gift_card_applied_cents > 0
            AND NOT EXISTS (
              SELECT 1 FROM gift_card_transactions t
               WHERE t.order_id = o.id AND t.type IN ('capture', 'release')
            )`,
      )
      .bind(crypto.randomUUID(), now, orderId),
  ];
}

/**
 * Puts the money back.
 *
 * Called from every path that can end an unpaid order: a declined inline card,
 * a checkout session that could not be created, the payment reaper, and a staff
 * cancellation. Guarded on there being no capture, so calling it on an order
 * that *was* paid for — a staff cancellation of a live order, say — correctly
 * does nothing. That money is a refund, which is a decision for a person.
 */
export function releaseGiftCardStatements(input: {
  orderId: string;
  actorType: "customer" | "staff" | "system";
  actorId?: string | null;
  note: string;
  now: number;
  /** The payment reaper runs outside a request and passes its own handle. */
  db?: D1Database;
}): D1PreparedStatement[] {
  const db = input.db ?? getD1();
  const guard = `AND o.gift_card_applied_cents > 0
                 AND NOT EXISTS (
                   SELECT 1 FROM gift_card_transactions t
                    WHERE t.order_id = o.id AND t.type IN ('capture', 'release')
                 )`;
  return [
    db
      .prepare(
        `UPDATE gift_cards g
            SET balance_cents = g.balance_cents + o.gift_card_applied_cents, updated_at = ?
           FROM orders o
          WHERE g.id = o.gift_card_id
            AND o.id = ?
            ${guard}`,
      )
      .bind(input.now, input.orderId),
    // After the UPDATE, so the balance recorded is the restored one. The guard
    // still matches because the row that would cancel it is the one being
    // written here.
    db
      .prepare(
        `INSERT INTO gift_card_transactions
         (id, gift_card_id, type, amount_cents, balance_after_cents, order_id, actor_type, actor_id, note, created_at)
         SELECT ?::text, o.gift_card_id, 'release', o.gift_card_applied_cents, g.balance_cents, o.id,
                ?::text, ?::text, ?::text, ?::bigint
           FROM orders o
           JOIN gift_cards g ON g.id = o.gift_card_id
          WHERE o.id = ?
            ${guard}`,
      )
      .bind(
        crypto.randomUUID(),
        input.actorType,
        input.actorId ?? null,
        input.note,
        input.now,
        input.orderId,
      ),
  ];
}

export type MintedGiftCard = {
  id: string;
  /** The plaintext code. Handed straight to the outbox and never stored. */
  code: string;
  suffix: string;
};

/**
 * Creates a card and its opening ledger entry.
 *
 * The code is generated here, written only as a digest, and returned to the
 * caller once. Nothing can produce it again — so the caller's next act must be
 * to put it in the outbox row that emails it, which is exactly what the tracking
 * token does at order creation and for the same reason.
 *
 * The retry loop is for a `code_hash` collision. At 79 bits that will not
 * happen; the loop costs three lines and means it cannot ever be an unhandled
 * 500 on a customer who has just been charged.
 */
export async function mintGiftCard(input: {
  amountCents: number;
  origin: "purchase" | "staff_issue";
  purchaseId?: string | null;
  recipientName: string;
  recipientEmail: string;
  senderName: string;
  message?: string | null;
  /** Only ever set on a staff-issued promotional card; see the schema. */
  expiresAt?: number | null;
  actorType: "customer" | "staff" | "system";
  actorId?: string | null;
  note?: string | null;
  now?: number;
}): Promise<MintedGiftCard> {
  const now = input.now ?? Date.now();
  const expiresAt = input.origin === "purchase" ? null : input.expiresAt ?? null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = generateGiftCardCode();
    const body = code.replaceAll("-", "").slice(3);
    const suffix = giftCardCodeSuffix(body);
    const id = crypto.randomUUID();
    const inserted = await getD1()
      .prepare(
        `INSERT INTO gift_cards
         (id, code_hash, code_suffix, initial_cents, balance_cents, currency, status, origin,
          purchase_id, recipient_name, recipient_email, sender_name, message, expires_at,
          issued_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'CAD', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (code_hash) DO NOTHING`,
      )
      .bind(
        id,
        await hashGiftCardCode(body),
        suffix,
        input.amountCents,
        input.amountCents,
        input.origin,
        input.purchaseId ?? null,
        input.recipientName,
        input.recipientEmail,
        input.senderName,
        input.message ?? null,
        expiresAt,
        now,
        now,
        now,
      )
      .run();
    if (!inserted.meta.changes) continue;

    await getD1()
      .prepare(
        `INSERT INTO gift_card_transactions
         (id, gift_card_id, type, amount_cents, balance_after_cents, order_id, actor_type, actor_id, note, created_at)
         VALUES (?, ?, 'issue', ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        id,
        input.amountCents,
        input.amountCents,
        input.actorType,
        input.actorId ?? null,
        input.note ?? null,
        now,
      )
      .run();

    return { id, code: formatGiftCardCode(body), suffix };
  }
  throw new Error("Could not allocate a unique gift card code");
}

export type GiftCardLedgerRow = {
  id: string;
  type: string;
  amount_cents: number;
  balance_after_cents: number;
  order_id: string | null;
  order_number: string | null;
  actor_type: string;
  actor_id: string | null;
  note: string | null;
  created_at: number;
};

/** Every movement on one card, oldest first — the answer to "where did it go?". */
export async function loadGiftCardLedger(giftCardId: string): Promise<GiftCardLedgerRow[]> {
  const rows = await getD1()
    .prepare(
      `SELECT t.id, t.type, t.amount_cents, t.balance_after_cents, t.order_id,
              o.order_number, t.actor_type, t.actor_id, t.note, t.created_at
         FROM gift_card_transactions t
         LEFT JOIN orders o ON o.id = t.order_id
        WHERE t.gift_card_id = ?
        ORDER BY t.created_at, t.id
        LIMIT 500`,
    )
    .bind(giftCardId)
    .all<GiftCardLedgerRow>();
  return rows.results;
}

/**
 * What the restaurant still owes its customers in unspent gift cards.
 *
 * A gift card sale is a **liability, not revenue** — the money is taken before
 * anything is supplied, and it becomes revenue when the card is spent. This is
 * the number the owner's bookkeeper asks for, and it is the one figure here
 * that is not derivable from the orders table.
 *
 * Holds are already deducted from `balance_cents`, so an order sitting in
 * checkout understates this by its own value for the fifteen minutes Clover's
 * session lasts. That is the right way round to be wrong.
 */
export async function giftCardLiability(): Promise<{
  outstandingCents: number;
  activeCards: number;
  issuedCents: number;
  redeemedCents: number;
}> {
  const [cards, redeemed] = await Promise.all([
    getD1()
      .prepare(
        `SELECT COALESCE(SUM(balance_cents), 0) AS outstanding_cents,
                COALESCE(SUM(initial_cents), 0) AS issued_cents,
                COUNT(*) AS active_cards
           FROM gift_cards WHERE status = 'active'`,
      )
      .first<{ outstanding_cents: number; issued_cents: number; active_cards: number }>(),
    // From the committed orders, not the ledger: `gift_card_applied_cents` is
    // the fact the receipt, the export and the HST return all agree on.
    getD1()
      .prepare(
        `SELECT COALESCE(SUM(gift_card_applied_cents), 0) AS redeemed_cents
           FROM orders WHERE gift_card_applied_cents > 0 AND status <> 'cancelled'`,
      )
      .first<{ redeemed_cents: number }>(),
  ]);
  return {
    outstandingCents: Number(cards?.outstanding_cents ?? 0),
    activeCards: Number(cards?.active_cards ?? 0),
    issuedCents: Number(cards?.issued_cents ?? 0),
    redeemedCents: Number(redeemed?.redeemed_cents ?? 0),
  };
}
