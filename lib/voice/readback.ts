/**
 * The authoritative read-back of a voice order, written by the server.
 *
 * What the caller says "yes" to has to be what the restaurant will make and
 * charge, so the agent never composes the summary itself: `review_order` hands
 * it this text and the structured lines behind it. Each line is described by
 * `snapshotDetails` / `snapshotFlags` from lib/order-presentation.ts — the same
 * functions that print the kitchen ticket and write the confirmation email —
 * from the snapshot `validateItems` produced for this exact cart. So the
 * read-back, the ticket and the email cannot describe the same order in
 * different words.
 */
import { formatMoney, type Fulfilment } from "@/lib/domain";
import type { OrderQuote, QuotedItemDetail } from "@/lib/order-service";
import { snapshotDetails, snapshotFlags, type ItemSnapshot } from "@/lib/order-presentation";
import type { VoiceCartLine } from "@/lib/voice/session";

export type ReadbackLine = {
  lineId: string;
  quantity: number;
  name: string;
  size: string | null;
  /** Preparation-critical: EXTRA CHEESE, NO MUSHROOMS. */
  flags: string[];
  /** Toppings by placement, then each option group: crust, sauce, wing sauce, the pizzas in a deal. */
  details: Array<{ label: string; value: string }>;
  notes: string | null;
  lineTotalCents: number;
};

export type Readback = {
  text: string;
  fulfilment: Fulfilment;
  lines: ReadbackLine[];
  deliveryAddress: string | null;
  totals: {
    subtotalCents: number;
    discountCents: number;
    deliveryFeeCents: number;
    taxCents: number;
    totalCents: number;
    amountDueCents: number;
  };
  promotions: string[];
  payment: string;
  estimate: { minutes: number; readyAround: string };
};

const torontoClock = (timestamp: number) =>
  new Date(timestamp)
    .toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })
    .replace(/\s?a\.m\./i, " AM")
    .replace(/\s?p\.m\./i, " PM");

const SPOKEN_COUNTS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const spokenCount = (quantity: number) => SPOKEN_COUNTS[quantity] ?? String(quantity);

function lineName(item: QuotedItemDetail): { name: string; size: string | null } {
  // "Large Pizza · 1 Item" already says Large; "Hawaiian" needs its size said.
  const size = item.variationName && !item.productName.toLowerCase().includes(item.variationName.toLowerCase()) ? item.variationName : null;
  return { name: item.productName, size };
}

export function addressLine(address: Record<string, string> | null): string | null {
  if (!address) return null;
  return [address.unit ? `Unit ${address.unit}, ${address.line1}` : address.line1, address.city, address.postalCode].filter(Boolean).join(", ");
}

/** Every quoted line, described in the kitchen ticket's words and keyed by its voice line id. */
export function describeLines(cart: VoiceCartLine[], items: QuotedItemDetail[], toppingNames: Map<string, string>): ReadbackLine[] {
  return items.map((item) => {
    const snapshot = item.snapshot as ItemSnapshot;
    const { name, size } = lineName(item);
    return {
      lineId: cart[item.index]?.lineId ?? `L${item.index + 1}`,
      quantity: item.quantity,
      name,
      size,
      flags: snapshotFlags(snapshot),
      details: snapshotDetails(snapshot, toppingNames),
      notes: item.instructions,
      lineTotalCents: item.lineTotalCents,
    };
  });
}

export function buildReadback(input: {
  fulfilment: Fulfilment;
  cart: VoiceCartLine[];
  quote: OrderQuote;
  items: QuotedItemDetail[];
  toppingNames: Map<string, string>;
  deliveryAddress: Record<string, string> | null;
  now: number;
}): Readback {
  const lines = describeLines(input.cart, input.items, input.toppingNames);

  const { totals } = input.quote;
  const payment = input.fulfilment === "delivery"
    ? "Payment is taken by the driver at the door."
    : "Payment is at the store when you pick up.";
  const readyAround = torontoClock(input.now + input.quote.estimateMinutes * 60_000);
  const address = input.fulfilment === "delivery" ? addressLine(input.deliveryAddress) : null;

  const spokenLines = lines.map((line, position) => {
    const parts = [...line.flags, ...line.details.map((detail) => `${detail.label}: ${detail.value}`)];
    if (line.notes) parts.push(`note: ${line.notes}`);
    // "two orders of 1 Pop", not "two 1 Pop".
    const what = /^\d/.test(line.name)
      ? `${spokenCount(line.quantity)} order${line.quantity === 1 ? "" : "s"} of ${line.name}`
      : `${spokenCount(line.quantity)} ${line.size ? `${line.size} ` : ""}${line.name}`;
    return `${position + 1}. ${what}${parts.length ? ` — ${parts.join("; ")}` : ""}, ${formatMoney(line.lineTotalCents)}.`;
  });
  const money = [
    `Subtotal ${formatMoney(totals.menuSubtotalCents)}`,
    ...(totals.discountCents > 0 ? [`discount ${formatMoney(totals.discountCents)}`] : []),
    ...(totals.deliveryFeeCents > 0 ? [`delivery ${formatMoney(totals.deliveryFeeCents)}`] : []),
    `tax ${formatMoney(totals.taxCents)}`,
  ].join(", ");
  const text = [
    `Here is your ${input.fulfilment} order.`,
    ...spokenLines,
    ...(address ? [`Delivering to ${address}.`] : []),
    `${money}. Your total is ${formatMoney(totals.amountDueCents)}.`,
    payment,
    `It should be ${input.fulfilment === "delivery" ? "with you" : "ready"} in about ${input.quote.estimateMinutes} minutes, around ${readyAround}.`,
    "Is everything correct?",
  ].join(" ");

  return {
    text,
    fulfilment: input.fulfilment,
    lines,
    deliveryAddress: address,
    totals: {
      subtotalCents: totals.menuSubtotalCents,
      discountCents: totals.discountCents,
      deliveryFeeCents: totals.deliveryFeeCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      amountDueCents: totals.amountDueCents,
    },
    promotions: input.quote.appliedPromotions.map((promotion) => promotion.name),
    payment,
    estimate: { minutes: input.quote.estimateMinutes, readyAround },
  };
}
