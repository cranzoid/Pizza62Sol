/**
 * Reading an order's items out of the database, already resolved for display.
 *
 * The translation itself — placements grouped, modifiers labelled, omissions
 * turned into "No mushrooms" — lives in `lib/order-presentation.ts`, which is
 * pure so the browser-rendered kitchen ticket can use the same code as these
 * server-rendered emails. This file is only the query.
 */
import { getD1 } from "@/db/runtime";
import { snapshotDetails, snapshotFlags, type ItemSnapshot, type OrderItemDetail } from "@/lib/order-presentation";

export { summariseItems, totalRows } from "@/lib/order-presentation";
export type { OrderItemDetail } from "@/lib/order-presentation";

function safeParse(raw: string | null): ItemSnapshot {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ItemSnapshot) : {};
  } catch {
    return {};
  }
}

type ItemRow = {
  product_name: string;
  variation_name: string | null;
  quantity: number;
  unit_price_cents: number;
  line_total_cents: number;
  snapshot_json: string | null;
  instructions: string | null;
};

/** Reads one item row's snapshot into display form. */
export function describeItem(item: ItemRow, toppingNames: Map<string, string>): OrderItemDetail {
  const snapshot = safeParse(item.snapshot_json);
  return {
    quantity: Number(item.quantity),
    productName: String(item.product_name),
    variationName: item.variation_name,
    unitPriceCents: Number(item.unit_price_cents),
    lineTotalCents: Number(item.line_total_cents),
    flags: snapshotFlags(snapshot),
    details: snapshotDetails(snapshot, toppingNames),
    instructions: item.instructions,
  };
}

/**
 * Every item on an order, resolved.
 *
 * Topping names are loaded once for the whole order rather than per item — a
 * ten-item order is one query either way, and the alternative is ten.
 */
export async function loadOrderItemDetails(orderId: string): Promise<OrderItemDetail[]> {
  const [items, toppings] = await Promise.all([
    getD1()
      .prepare(
        `SELECT product_name, variation_name, quantity, unit_price_cents, line_total_cents,
                snapshot_json, instructions
         FROM order_items WHERE order_id = ? ORDER BY created_at`,
      )
      .bind(orderId)
      .all<ItemRow>(),
    getD1().prepare("SELECT id, name FROM toppings").all<{ id: string; name: string }>(),
  ]);
  const toppingNames = new Map(toppings.results.map((topping) => [topping.id, topping.name]));
  return items.results.map((item) => describeItem(item, toppingNames));
}
