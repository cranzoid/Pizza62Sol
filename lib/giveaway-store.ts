/**
 * The Thanksgiving Giveaway, against the database.
 *
 * The rules live in `lib/giveaway.ts`; this file applies them to real orders.
 *
 * ## When an order earns its entry
 *
 * At the moment it becomes real, and at no other: an order that is never paid
 * for must never hold a number. There are exactly two such moments and one
 * safety net:
 *
 * 1. **At creation**, for an order that is settled the instant it commits —
 *    pay at the store, or a bill a gift card covered outright (`createOrder`).
 * 2. **When the card payment clears**, for everything else
 *    (`applyPaymentApproved`, which both the webhook and the inline charge use).
 * 3. **The cron sweep**, every minute, which finds any qualifying order in the
 *    window that has no entry and gives it one. It exists for the orders placed
 *    in the minutes between the staging slot migrating and the swap — the old
 *    code was still taking them — and for anything a crash dropped between a
 *    commit and the entry that should have followed it.
 *
 * All three call `recordGiveawayEntry`, which is idempotent: an order has at
 * most one entry, enforced by a unique index and checked before a number is
 * spent.
 *
 * ## Why an entry never shares a transaction with the order
 *
 * It would be neater, and it would mean a mistake in the giveaway could fail a
 * payment. The giveaway is a promotion; taking the order and recording the
 * payment is the business. So the entry is written straight after the order or
 * payment commits, in its own transaction, and a failure there is logged and
 * swallowed — the sweep will give that order its entry a minute later.
 */
import { getD1, safeJson } from "@/db/runtime";
import {
  formatEntryNumber,
  GIVEAWAY_ID,
  giveawayStatus,
  normalizeGiveaway,
  type GiveawaySetting,
  type GiveawayStatus,
} from "@/lib/giveaway";
import { logFailure } from "@/lib/log";
import { anyProviderConfigured } from "@/lib/notifications/config";

/**
 * An order whose entry counts: not cancelled, and actually bought — paid, or
 * being paid for at the store. A fully refunded order drops out; a partial
 * refund is still a purchase. Written against the alias `o`.
 *
 * Used both when an entry is created and when a winner is picked, so the two
 * can never disagree about which orders are in.
 */
export const ELIGIBLE_ORDER_SQL = `o.status <> 'cancelled'
  AND o.payment_status IN ('paid', 'pending_at_store', 'partially_refunded')`;

/** How long after the receipt the "you're in" email follows it. */
const ENTRY_EMAIL_DELAY_MS = 30_000;

export async function loadGiveaway(): Promise<GiveawaySetting | null> {
  const row = await getD1()
    .prepare("SELECT value_json FROM settings WHERE key = 'giveaway'")
    .first<{ value_json: string }>();
  return row ? normalizeGiveaway(safeJson(row.value_json, null)) : null;
}

/** The setting and where it stands right now — for pages that render it. */
export async function loadGiveawayNow(): Promise<{ giveaway: GiveawaySetting | null; status: GiveawayStatus; now: number }> {
  const giveaway = await loadGiveaway();
  const now = Date.now();
  return { giveaway, status: giveawayStatus(giveaway, now), now };
}

export function giveawaySequenceKey(giveawayId: string): string {
  return `giveaway:${giveawayId}`;
}

/**
 * Gives an order its entry if it has earned one, and returns its number.
 *
 * Returns the existing number for an order that already has one, and null for
 * an order that does not qualify — too small, outside the window, unpaid,
 * cancelled, or the giveaway is off.
 *
 * **Every condition is re-checked in SQL**, not just in JavaScript beforehand.
 * The order row is read inside the statements that write the entry, so an
 * order cancelled a moment ago, or a second caller that got here first, is
 * seen by the statement rather than by a read that has already gone stale.
 *
 * The three writes share one transaction:
 *
 * 1. the sequence advances — only if the order qualifies and has no entry, so
 *    a number is not spent on an order that will not use it;
 * 2. the entry is inserted, taking the number the sequence now holds. The
 *    sequence row's lock is what serialises two orders arriving together;
 * 3. the "you're in" email is queued, if there is an address to send it to.
 */
export async function recordGiveawayEntry(orderId: string, now: number = Date.now()): Promise<number | null> {
  const giveaway = await loadGiveaway();
  if (giveaway?.enabled) {
    const sequenceKey = giveawaySequenceKey(giveaway.id);
    const qualifies = `o.id = ? AND ${ELIGIBLE_ORDER_SQL}
      AND o.created_at >= ? AND o.created_at < ?
      AND (o.subtotal_cents - o.discount_cents) >= ?
      AND NOT EXISTS (SELECT 1 FROM giveaway_entries existing WHERE existing.order_id = o.id)`;
    const qualifyingBinds = [orderId, giveaway.startsAt, giveaway.endsAt, giveaway.minimumCents];
    const outboxStatus = (await anyProviderConfigured()) ? "pending" : "pending_provider_setup";
    await getD1().batch([
      getD1()
        .prepare("INSERT INTO order_sequences (key, current_number) VALUES (?, 0) ON CONFLICT (key) DO NOTHING")
        .bind(sequenceKey),
      getD1()
        .prepare(
          `UPDATE order_sequences SET current_number = current_number + 1
           WHERE key = ? AND EXISTS (SELECT 1 FROM orders o WHERE ${qualifies})`,
        )
        .bind(sequenceKey, ...qualifyingBinds),
      getD1()
        .prepare(
          `INSERT INTO giveaway_entries
           (id, giveaway_id, entry_number, order_id, customer_name, customer_email, customer_phone,
            qualifying_cents, created_at)
           SELECT ?, ?, s.current_number, o.id, o.customer_name, lower(o.customer_email), o.customer_phone,
                  o.subtotal_cents - o.discount_cents, ?
           FROM orders o JOIN order_sequences s ON s.key = ?
           WHERE ${qualifies}`,
        )
        .bind(crypto.randomUUID(), giveaway.id, now, sequenceKey, ...qualifyingBinds),
      // Tied to *this* insert by its timestamp, and to no earlier email by the
      // NOT EXISTS — so a retry never sends a second "you're in".
      getD1()
        .prepare(
          `INSERT INTO notification_outbox
           (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
           SELECT ?, 'giveaway_entry', e.customer_email, ?, ?, 0, ?, ?, ?
           FROM giveaway_entries e
           WHERE e.order_id = ? AND e.created_at = ? AND e.customer_email <> ''
             AND NOT EXISTS (
               SELECT 1 FROM notification_outbox n
               WHERE n.kind = 'giveaway_entry' AND n.payload_json::jsonb->>'orderId' = e.order_id
             )`,
        )
        .bind(
          crypto.randomUUID(),
          JSON.stringify({ orderId, giveawayId: giveaway.id }),
          outboxStatus,
          // A beat after the receipt, so the order confirmation lands first and
          // the giveaway email reads as the second, separate piece of news.
          now + ENTRY_EMAIL_DELAY_MS,
          now,
          now,
          orderId,
          now,
        ),
    ]);
  }
  const entry = await getD1()
    .prepare("SELECT entry_number FROM giveaway_entries WHERE order_id = ?")
    .bind(orderId)
    .first<{ entry_number: number }>();
  return entry ? Number(entry.entry_number) : null;
}

/**
 * The same, for callers whose own work must not fail because of it — order
 * creation and payment completion. A failure is logged and the sweep retries.
 */
export async function recordGiveawayEntrySafely(orderId: string, now?: number): Promise<number | null> {
  try {
    return await recordGiveawayEntry(orderId, now);
  } catch (error) {
    logFailure("giveaway.entry", error);
    return null;
  }
}

/**
 * The safety net: any qualifying order in the window without an entry gets one.
 *
 * Cheap when there is nothing to do — one indexed scan of the window's orders —
 * and bounded per tick so a backlog cannot turn a cron run into a long one.
 */
export async function sweepGiveawayEntries(
  options: { now?: number; limit?: number } = {},
): Promise<{ checked: number; recorded: number }> {
  const giveaway = await loadGiveaway();
  if (!giveaway?.enabled) return { checked: 0, recorded: 0 };
  const now = options.now ?? Date.now();
  const missing = await getD1()
    .prepare(
      `SELECT o.id FROM orders o
       WHERE o.created_at >= ? AND o.created_at < ?
         AND ${ELIGIBLE_ORDER_SQL}
         AND (o.subtotal_cents - o.discount_cents) >= ?
         AND NOT EXISTS (SELECT 1 FROM giveaway_entries e WHERE e.order_id = o.id)
       ORDER BY o.created_at
       LIMIT ?`,
    )
    .bind(giveaway.startsAt, giveaway.endsAt, giveaway.minimumCents, options.limit ?? 50)
    .all<{ id: string }>();
  let recorded = 0;
  for (const row of missing.results) {
    if ((await recordGiveawayEntrySafely(row.id, now)) !== null) recorded += 1;
  }
  return { checked: missing.results.length, recorded };
}

export type OrderGiveaway = {
  giveaway: GiveawaySetting | null;
  entryNumber: number | null;
};

/** The giveaway as it applies to one order: the setting, and its entry if any. */
export async function giveawayForOrder(orderId: string): Promise<OrderGiveaway> {
  const [giveaway, entry] = await Promise.all([
    loadGiveaway(),
    getD1()
      .prepare("SELECT entry_number FROM giveaway_entries WHERE order_id = ?")
      .bind(orderId)
      .first<{ entry_number: number }>(),
  ]);
  return { giveaway, entryNumber: entry ? Number(entry.entry_number) : null };
}

/**
 * How many entries this email address holds, counting only orders still in.
 *
 * Shown in the emails ("you now have 3 entries") because an entry per order is
 * the rule most worth knowing — it is the reason to order again this week.
 */
export async function entriesForEmail(email: string, giveawayId: string = GIVEAWAY_ID): Promise<number> {
  const clean = email.trim().toLowerCase();
  if (!clean) return 0;
  const row = await getD1()
    .prepare(
      `SELECT COUNT(*) AS count FROM giveaway_entries e JOIN orders o ON o.id = e.order_id
       WHERE e.giveaway_id = ? AND e.customer_email = ? AND ${ELIGIBLE_ORDER_SQL}`,
    )
    .bind(giveawayId, clean)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

// --- the admin view -----------------------------------------------------------

export type GiveawayEntryRow = {
  id: string;
  entry_number: number;
  entry_label: string;
  order_id: string;
  order_number: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  qualifying_cents: number;
  channel: string;
  fulfilment: string;
  created_at: number;
  picked_at: number | null;
  picked_by_name: string | null;
  /** False once the order is cancelled or refunded. */
  eligible: boolean;
};

const ENTRY_SELECT = `SELECT e.id, e.entry_number, e.order_id, o.order_number, e.customer_name, e.customer_email,
         e.customer_phone, e.qualifying_cents, o.channel, o.fulfilment, e.created_at, e.picked_at,
         u.name AS picked_by_name,
         CASE WHEN ${ELIGIBLE_ORDER_SQL} THEN 1 ELSE 0 END AS eligible
  FROM giveaway_entries e
  JOIN orders o ON o.id = e.order_id
  LEFT JOIN staff_users u ON u.id = e.picked_by`;

function toEntryRow(row: Record<string, unknown>): GiveawayEntryRow {
  return {
    ...(row as unknown as GiveawayEntryRow),
    entry_number: Number(row.entry_number),
    entry_label: formatEntryNumber(Number(row.entry_number)),
    qualifying_cents: Number(row.qualifying_cents),
    created_at: Number(row.created_at),
    picked_at: row.picked_at === null || row.picked_at === undefined ? null : Number(row.picked_at),
    eligible: Number(row.eligible) === 1,
  };
}

/**
 * Entries, newest first, optionally filtered.
 *
 * A search that is all digits is also tried as an entry number, because the
 * question asked of this screen on the day is "whose is number 0042?".
 */
export async function listGiveawayEntries(
  giveawayId: string,
  options: { query?: string; limit?: number; offset?: number; searchContact?: boolean } = {},
): Promise<{ entries: GiveawayEntryRow[]; total: number }> {
  const query = (options.query ?? "").trim().slice(0, 80);
  const like = `%${query}%`;
  const asNumber = /^#?\d{1,7}$/.test(query) ? Number(query.replace("#", "")) : -1;
  // Someone who is shown masked contact details must not be able to search by
  // them either, or "does this email have an entry?" is answerable anyway.
  const contactFilter = options.searchContact === false ? "" : " OR e.customer_email ILIKE ? OR e.customer_phone ILIKE ?";
  const filter = query
    ? `AND (e.entry_number = ? OR e.customer_name ILIKE ? OR o.order_number ILIKE ?${contactFilter})`
    : "";
  const binds = query
    ? [giveawayId, asNumber, like, like, ...(options.searchContact === false ? [] : [like, like])]
    : [giveawayId];
  const [rows, count] = await Promise.all([
    getD1()
      .prepare(`${ENTRY_SELECT} WHERE e.giveaway_id = ? ${filter} ORDER BY e.entry_number DESC LIMIT ? OFFSET ?`)
      .bind(...binds, options.limit ?? 50, options.offset ?? 0)
      .all<Record<string, unknown>>(),
    getD1()
      .prepare(`SELECT COUNT(*) AS count FROM giveaway_entries e JOIN orders o ON o.id = e.order_id WHERE e.giveaway_id = ? ${filter}`)
      .bind(...binds)
      .first<{ count: number }>(),
  ]);
  return { entries: rows.results.map(toEntryRow), total: Number(count?.count ?? 0) };
}

/** Every entry, oldest first, for the CSV export. */
export async function allGiveawayEntries(giveawayId: string): Promise<GiveawayEntryRow[]> {
  const rows = await getD1()
    .prepare(`${ENTRY_SELECT} WHERE e.giveaway_id = ? ORDER BY e.entry_number ASC`)
    .bind(giveawayId)
    .all<Record<string, unknown>>();
  return rows.results.map(toEntryRow);
}

export async function giveawayStats(giveawayId: string, dayStart: number) {
  const row = await getD1()
    .prepare(
      `SELECT COUNT(*) AS entries,
              COALESCE(SUM(CASE WHEN ${ELIGIBLE_ORDER_SQL} THEN 1 ELSE 0 END), 0) AS eligible,
              COUNT(DISTINCT CASE WHEN ${ELIGIBLE_ORDER_SQL} THEN
                COALESCE(NULLIF(e.customer_email, ''), NULLIF(regexp_replace(e.customer_phone, '\\D', '', 'g'), ''), e.id)
              END) AS people,
              COALESCE(SUM(CASE WHEN e.created_at >= ? THEN 1 ELSE 0 END), 0) AS today
       FROM giveaway_entries e JOIN orders o ON o.id = e.order_id
       WHERE e.giveaway_id = ?`,
    )
    .bind(dayStart, giveawayId)
    .first<{ entries: number; eligible: number; people: number; today: number }>();
  return {
    entries: Number(row?.entries ?? 0),
    eligible: Number(row?.eligible ?? 0),
    people: Number(row?.people ?? 0),
    today: Number(row?.today ?? 0),
  };
}

export async function pickedEntries(giveawayId: string): Promise<GiveawayEntryRow[]> {
  const rows = await getD1()
    .prepare(`${ENTRY_SELECT} WHERE e.giveaway_id = ? AND e.picked_at IS NOT NULL ORDER BY e.picked_at ASC`)
    .bind(giveawayId)
    .all<Record<string, unknown>>();
  return rows.results.map(toEntryRow);
}

/**
 * A uniform random integer in [0, size), with no modulo bias.
 *
 * Web Crypto rather than `Math.random`, because this decides who wins a TV and
 * "the random number generator was predictable" is not an answer anyone should
 * ever have to give.
 */
export function secureRandomIndex(size: number): number {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Nothing to pick from.");
  const limit = Math.floor(0x1_0000_0000 / size) * size;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0] < limit) return buffer[0] % size;
  }
}

/**
 * Picks one winning entry at random from every entry still in.
 *
 * Every eligible entry has the same chance — so a customer with three orders
 * has three chances, exactly as the receipts promised. An entry already
 * picked is out, and so is every other entry held by the same email or phone:
 * "pick another" is for when a winner cannot be reached, and landing on the
 * same unreachable person's second entry would help nobody.
 *
 * The pick is recorded on the entry (and in the audit log by the caller), so
 * the result is on the record the moment it is made rather than living only on
 * the screen it appeared on.
 */
export async function pickGiveawayWinner(
  giveawayId: string,
  actorId: string,
  now: number = Date.now(),
): Promise<GiveawayEntryRow | null> {
  const pool = await getD1()
    .prepare(
      `SELECT e.id FROM giveaway_entries e JOIN orders o ON o.id = e.order_id
       WHERE e.giveaway_id = ? AND e.picked_at IS NULL AND ${ELIGIBLE_ORDER_SQL}
         AND NOT EXISTS (
           SELECT 1 FROM giveaway_entries picked
           WHERE picked.giveaway_id = e.giveaway_id AND picked.picked_at IS NOT NULL
             AND ((picked.customer_email <> '' AND picked.customer_email = e.customer_email)
               OR (regexp_replace(picked.customer_phone, '\\D', '', 'g') <> ''
                   AND regexp_replace(picked.customer_phone, '\\D', '', 'g') = regexp_replace(e.customer_phone, '\\D', '', 'g')))
         )
       ORDER BY e.entry_number`,
    )
    .bind(giveawayId)
    .all<{ id: string }>();
  if (!pool.results.length) return null;
  const chosen = pool.results[secureRandomIndex(pool.results.length)];
  const updated = await getD1()
    .prepare("UPDATE giveaway_entries SET picked_at = ?, picked_by = ? WHERE id = ? AND picked_at IS NULL")
    .bind(now, actorId, chosen.id)
    .run();
  if (!updated.meta.changes) return null;
  const row = await getD1()
    .prepare(`${ENTRY_SELECT} WHERE e.id = ?`)
    .bind(chosen.id)
    .first<Record<string, unknown>>();
  return row ? toEntryRow(row) : null;
}
