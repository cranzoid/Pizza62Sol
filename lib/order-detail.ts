/**
 * Reading back one order in full — everything staff can look back at once it
 * has left the live board.
 *
 * The till's print ticket already loaded order + items right after creation
 * (`loadPrintOrder`, formerly inline in `app/api/admin/orders/route.ts`).
 * `loadOrderCore` is that same read, pulled out so a second caller — the order
 * detail view — can share it instead of drifting from it. `loadOrderDetail`
 * builds on top with the parts a fresh ticket does not need: the status
 * timeline, any refunds, the feedback the customer left, and who rang it in
 * when it came from the counter or the phone.
 *
 * Item choices are resolved to display text here, server-side, with the same
 * `snapshotDetails`/`snapshotFlags` the printed ticket and the confirmation
 * email use — so a caller never has to carry the topping table around just to
 * show what was ordered, and every surface still describes an order in
 * exactly the same words.
 */
import { getD1, safeJson } from "@/db/runtime";
import { snapshotDetails, snapshotFlags, type ItemSnapshot } from "@/lib/order-presentation";

const ORDER_COLUMNS = `id, order_number, customer_id, customer_name, customer_phone, customer_email,
   fulfilment, channel, status, payment_status, payment_method, schedule_type, scheduled_for,
   estimated_for, address_json, instructions, subtotal_cents, discount_cents, tax_cents,
   delivery_fee_cents, tip_cents, total_cents, created_at, updated_at, acknowledged_at`;

async function toppingNameMap(): Promise<Map<string, string>> {
  const rows = await getD1().prepare("SELECT id, name FROM toppings").all<{ id: string; name: string }>();
  return new Map(rows.results.map((row) => [row.id, row.name]));
}

async function loadOrderItems(orderId: string, toppingNames: Map<string, string>) {
  const items = await getD1()
    .prepare(
      `SELECT id, product_name, variation_name, quantity, unit_price_cents,
              line_total_cents, snapshot_json, instructions
       FROM order_items WHERE order_id = ? ORDER BY created_at`,
    )
    .bind(orderId)
    .all<Record<string, unknown>>();
  return items.results.map((item) => {
    const snapshot = safeJson(String(item.snapshot_json ?? "{}"), {}) as ItemSnapshot;
    return {
      id: item.id,
      productName: item.product_name,
      variationName: item.variation_name,
      quantity: item.quantity,
      unitPriceCents: item.unit_price_cents,
      lineTotalCents: item.line_total_cents,
      snapshot,
      flags: snapshotFlags(snapshot),
      details: snapshotDetails(snapshot, toppingNames),
      instructions: item.instructions,
    };
  });
}

/**
 * The exact committed order shape the till's print ticket consumes: order
 * fields, the parsed delivery address, and items with their snapshot resolved
 * to display text. Loaded fresh rather than trusted from the till's cart,
 * because the server has applied the real price, tax, promotions and
 * immutable item snapshots by the time this is called.
 */
export async function loadOrderCore(orderId: string): Promise<Record<string, unknown> | null> {
  const order = await getD1()
    .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`)
    .bind(orderId)
    .first<Record<string, unknown>>();
  if (!order) return null;
  const toppingNames = await toppingNameMap();
  return {
    ...order,
    address: safeJson(String(order.address_json ?? "null"), null),
    address_json: undefined,
    items: await loadOrderItems(orderId, toppingNames),
  };
}

/**
 * The full record of one order: the core order above, plus its status
 * timeline, any refunds recorded against it, the feedback response it
 * received (if any), and — for a phone or walk-in order — who took it.
 */
export async function loadOrderDetail(orderId: string): Promise<Record<string, unknown> | null> {
  const core = await loadOrderCore(orderId);
  if (!core) return null;

  const [events, refunds, feedback, staffEntry] = await Promise.all([
    // Actor name only resolves for 'staff' events — 'system', 'clover' and
    // 'restaurant' events carry no staff_users row, and a cancellation by the
    // customer's own tracking token isn't a staff id either.
    getD1()
      .prepare(
        `SELECT e.id, e.previous_status, e.next_status, e.actor_type, e.actor_id, e.note, e.created_at,
                u.name AS actor_name
         FROM order_events e LEFT JOIN staff_users u ON u.id = e.actor_id AND e.actor_type = 'staff'
         WHERE e.order_id = ? ORDER BY e.created_at ASC`,
      )
      .bind(orderId)
      .all<Record<string, unknown>>(),
    getD1()
      .prepare(
        `SELECT r.id, r.amount_cents, r.reason, r.customer_note, r.internal_note, r.provider_reference,
                r.status, r.actor_id, r.created_at, u.name AS actor_name
         FROM refunds r LEFT JOIN staff_users u ON u.id = r.actor_id
         WHERE r.order_id = ? ORDER BY r.created_at DESC`,
      )
      .bind(orderId)
      .all<Record<string, unknown>>(),
    getD1()
      .prepare(
        `SELECT overall_rating, written_feedback, answers_json, submitted_at, reviewed_at, internal_note
         FROM feedback_responses WHERE order_id = ?`,
      )
      .bind(orderId)
      .first<Record<string, unknown>>(),
    // The only link back to who rang in a counter or phone order — see the
    // audit write in app/api/admin/orders/route.ts.
    getD1()
      .prepare(
        `SELECT a.actor_id, a.created_at, u.name AS actor_name
         FROM audit_log a LEFT JOIN staff_users u ON u.id = a.actor_id
         WHERE a.target_type = 'order' AND a.target_id = ? AND a.action = 'order.staff_entry'
         ORDER BY a.created_at ASC LIMIT 1`,
      )
      .bind(orderId)
      .first<Record<string, unknown>>(),
  ]);

  const refundedCents = refunds.results
    .filter((refund) => refund.status === "recorded")
    .reduce((sum, refund) => sum + Number(refund.amount_cents ?? 0), 0);

  return {
    ...core,
    events: events.results,
    refunds: refunds.results,
    refundedCents,
    feedback: feedback
      ? { ...feedback, answers: safeJson(String(feedback.answers_json ?? "{}"), {}), answers_json: undefined }
      : null,
    takenBy: staffEntry ? { name: staffEntry.actor_name ?? null, at: staffEntry.created_at } : null,
  };
}

/**
 * Redacts phone and email for a viewer without `view_customer_contact` — the
 * same rule the order history CSV export and the kitchen ticket already
 * follow. Nothing else on the order is gated by this permission.
 */
export function redactOrderContact<T extends Record<string, unknown>>(order: T, canViewContact: boolean): T {
  if (canViewContact) return order;
  return { ...order, customer_phone: undefined, customer_email: undefined, contactRedacted: true };
}
