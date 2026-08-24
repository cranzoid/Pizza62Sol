/**
 * Turning an order's stored snapshots into something a person can read.
 *
 * `order_items.snapshot_json` is the immutable record of what was ordered —
 * toppings by id with a placement, modifier sections with their chosen values,
 * recipe omissions, the halal and extra-cheese flags. It is exact, and it is
 * unreadable: `{"toppingId":"pepperoni","placement":"left"}` tells a customer
 * checking their confirmation nothing.
 *
 * Every human-facing rendering of an order — the confirmation email, the
 * restaurant alert, the printed kitchen ticket — needs the same translation, so
 * it lives here once. A confirmation that said "1 x Large Pizza" and stopped is
 * what makes a wrong order an argument instead of a correction, and the kitchen
 * cannot make a half-and-half it cannot see.
 *
 * **Placement is grouped, not suffixed.** `Pepperoni (L), Mushroom (L), Onion
 * (R)` makes a reader assemble the pizza in their head, and a tired one at 9pm
 * misses it. `LEFT HALF: Pepperoni, Mushroom` / `RIGHT HALF: Onion` says the
 * same thing in the shape the kitchen actually works in.
 *
 * **Nothing here touches the database.** The printed ticket is rendered in the
 * browser from the dashboard payload and the emails are rendered on the server
 * from a query; they can only share this code while it stays pure. The loader
 * that reads `order_items` lives in `lib/notifications/order-details.ts`.
 */
import { formatMoney } from "@/lib/domain";

export type SnapshotPlacement = "whole" | "left" | "right";

export type ItemSnapshot = {
  halal?: unknown;
  extraCheese?: unknown;
  recipeOmissions?: unknown;
  toppings?: unknown;
  modifiers?: unknown;
};

type SnapshotTopping = { toppingId?: string; placement?: string };
type SnapshotModifier = {
  id?: string;
  label?: string;
  group?: string;
  values?: Array<{ value?: string; label?: string; placement?: string }>;
};

/** One order line, with every choice on it resolved to display text. */
export type OrderItemDetail = {
  quantity: number;
  productName: string;
  variationName: string | null;
  unitPriceCents: number;
  lineTotalCents: number;
  /** Preparation-critical, printed loudly: HALAL, EXTRA CHEESE, NO MUSHROOMS. */
  flags: string[];
  /** Label/value pairs — topping placements first, then modifier groups. */
  details: Array<{ label: string; value: string }>;
  instructions: string | null;
};

function normalizePlacement(raw: string | undefined): SnapshotPlacement {
  return raw === "left" || raw === "right" ? raw : "whole";
}

const PLACEMENT_LABEL: Record<SnapshotPlacement, string> = {
  whole: "Toppings",
  left: "Left half",
  right: "Right half",
};

/**
 * Groups topping selections by where they go.
 *
 * A pizza with nothing on the halves gets one "Toppings" row and reads like a
 * normal list; only a genuine half-and-half grows the extra rows, so the common
 * case is not made noisier to serve the rare one.
 */
export function toppingDetails(
  toppings: Array<{ toppingId?: string; placement?: string }>,
  toppingNames: Map<string, string>,
): Array<{ label: string; value: string }> {
  const grouped = new Map<SnapshotPlacement, string[]>();
  for (const topping of toppings) {
    const id = String(topping.toppingId ?? "");
    if (!id) continue;
    const placement = normalizePlacement(topping.placement);
    const list = grouped.get(placement) ?? [];
    list.push(toppingNames.get(id) ?? id);
    grouped.set(placement, list);
  }
  // Whole first: it is the base the halves are added to.
  return (["whole", "left", "right"] as const)
    .filter((placement) => grouped.get(placement)?.length)
    .map((placement) => ({
      label: PLACEMENT_LABEL[placement],
      value: (grouped.get(placement) ?? []).join(", "),
    }));
}

/**
 * Modifier sections — crust, sauce, wing flavour, the pizzas inside a deal.
 *
 * Values keep their own placement suffix rather than being grouped: a deal's
 * "Pizza 1 toppings" section is already a labelled group, and splitting it again
 * by side would bury which pizza it belongs to.
 */
export function modifierDetails(modifiers: SnapshotModifier[]): Array<{ label: string; value: string }> {
  return modifiers
    .filter((modifier) => (modifier.values ?? []).length)
    .map((modifier) => ({
      label: modifier.group ? `${modifier.group} · ${modifier.label ?? ""}` : String(modifier.label ?? "Options"),
      value: (modifier.values ?? [])
        .map((entry) => {
          const label = String(entry.label ?? entry.value ?? "");
          const placement = normalizePlacement(entry.placement);
          return placement === "whole" ? label : `${label} (${placement === "left" ? "left half" : "right half"})`;
        })
        .join(", "),
    }));
}

/** Halal, extra cheese and every deliberate omission, in the order they matter. */
export function snapshotFlags(snapshot: ItemSnapshot): string[] {
  const flags: string[] = [];
  if (snapshot.halal) flags.push("Halal");
  if (snapshot.extraCheese) flags.push("Extra cheese");
  const omissions = Array.isArray(snapshot.recipeOmissions) ? (snapshot.recipeOmissions as string[]) : [];
  for (const omission of omissions) flags.push(`No ${omission}`);
  return flags;
}

/** Every choice on one item, whichever surface is asking. */
export function snapshotDetails(
  snapshot: ItemSnapshot,
  toppingNames: Map<string, string>,
): Array<{ label: string; value: string }> {
  const toppings = Array.isArray(snapshot.toppings) ? (snapshot.toppings as SnapshotTopping[]) : [];
  const modifiers = Array.isArray(snapshot.modifiers) ? (snapshot.modifiers as SnapshotModifier[]) : [];
  return [...toppingDetails(toppings, toppingNames), ...modifierDetails(modifiers)];
}

/**
 * One line per item, for the places that have no room for the full detail — an
 * SMS, a spoken call, a subject line.
 */
export function summariseItems(details: OrderItemDetail[]): string[] {
  return details.map((item) => {
    const extras = [...item.flags, ...item.details.map((detail) => `${detail.label}: ${detail.value}`)];
    return `${item.quantity} x ${item.productName}${item.variationName ? ` (${item.variationName})` : ""}${
      extras.length ? ` — ${extras.join("; ")}` : ""
    }`;
  });
}

/** Money rows for an order, skipping the lines that are zero. */
export function totalRows(order: {
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  delivery_fee_cents: number;
  tip_cents: number;
  total_cents: number;
}): Array<{ label: string; value: string; strong?: boolean }> {
  const rows: Array<{ label: string; value: string; strong?: boolean }> = [
    { label: "Subtotal", value: formatMoney(Number(order.subtotal_cents ?? 0)) },
  ];
  if (Number(order.discount_cents ?? 0) > 0) {
    rows.push({ label: "Discount", value: `−${formatMoney(Number(order.discount_cents))}` });
  }
  if (Number(order.delivery_fee_cents ?? 0) > 0) {
    rows.push({ label: "Delivery", value: formatMoney(Number(order.delivery_fee_cents)) });
  }
  rows.push({ label: "HST", value: formatMoney(Number(order.tax_cents ?? 0)) });
  if (Number(order.tip_cents ?? 0) > 0) {
    rows.push({ label: "Tip", value: formatMoney(Number(order.tip_cents)) });
  }
  rows.push({ label: "Total", value: formatMoney(Number(order.total_cents ?? 0)), strong: true });
  return rows;
}
