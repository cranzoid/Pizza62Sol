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
import { spokenWhen } from "@/lib/voice/schedule";
import type { VoiceCartLine, VoiceOrderOptions } from "@/lib/voice/session";

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
    tipCents: number;
    totalCents: number;
    amountDueCents: number;
  };
  promotions: string[];
  /** The promo code the caller gave and what the server made of it; null without one. */
  coupon: { code: string; applied: boolean; message: string | null } | null;
  deliveryInstructions: string | null;
  payment: string;
  /** `scheduledFor` is set for an order placed for a later time; `minutes` is the lead time otherwise. */
  estimate: { minutes: number; readyAround: string; scheduledFor: number | null; when: string };
};

const torontoClock = (timestamp: number) =>
  new Date(timestamp)
    .toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })
    .replace(/\s?a\.m\./i, " AM")
    .replace(/\s?p\.m\./i, " PM");

/** The ticket's " · " separator reads as nothing aloud; a comma reads as a pause. */
const spoken = (text: string) => text.replaceAll(" · ", ", ");

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
  /** The schedule, code and tip the quote was priced with. Defaults to ASAP, none, none. */
  options?: Pick<VoiceOrderOptions, "schedule">;
  now: number;
}): Readback {
  const lines = describeLines(input.cart, input.items, input.toppingNames);

  const { totals } = input.quote;
  const payment = input.fulfilment === "delivery"
    ? "Payment is taken by the driver at the door."
    : "Payment is at the store when you pick up.";
  const schedule = input.options?.schedule ?? { type: "asap" as const };
  const scheduledFor = schedule.type === "scheduled" ? schedule.scheduledFor : null;
  const readyAt = scheduledFor ?? input.now + input.quote.estimateMinutes * 60_000;
  const readyAround = torontoClock(readyAt);
  const when = scheduledFor !== null
    ? spokenWhen(scheduledFor, input.now)
    : `in about ${input.quote.estimateMinutes} minutes, around ${readyAround}`;
  const address = input.fulfilment === "delivery" ? addressLine(input.deliveryAddress) : null;
  const deliveryInstructions = input.fulfilment === "delivery" ? input.deliveryAddress?.instructions?.trim() || null : null;
  const promotions = input.quote.appliedPromotions.map((promotion) => promotion.name);
  const discounted = input.quote.appliedPromotions.filter((promotion) => promotion.discountCents > 0).map((promotion) => promotion.name);
  const coupon = input.quote.coupon
    ? { code: input.quote.coupon.code, applied: input.quote.coupon.status === "applied", message: input.quote.coupon.message }
    : null;

  const spokenLines = lines.map((line, position) => {
    const parts = [...line.flags, ...line.details.map((detail) => `${detail.label}: ${detail.value}`)];
    if (line.notes) parts.push(`note: ${spoken(line.notes)}`);
    // "two orders of 1 Pop", not "two 1 Pop".
    const what = /^\d/.test(line.name)
      ? `${spokenCount(line.quantity)} order${line.quantity === 1 ? "" : "s"} of ${line.name}`
      : `${spokenCount(line.quantity)} ${line.size ? `${line.size} ` : ""}${line.name}`;
    return `${position + 1}. ${what}${parts.length ? ` — ${parts.join("; ")}` : ""}, ${formatMoney(line.lineTotalCents)}.`;
  });
  const money = [
    `Subtotal ${formatMoney(totals.menuSubtotalCents)}`,
    ...(totals.discountCents > 0 ? [`discount ${formatMoney(totals.discountCents)}${discounted.length ? ` (${discounted.join(" and ")})` : ""}`] : []),
    ...(totals.deliveryFeeCents > 0 ? [`delivery ${formatMoney(totals.deliveryFeeCents)}`] : []),
    `tax ${formatMoney(totals.taxCents)}`,
    ...(totals.tipCents > 0 ? [`tip ${formatMoney(totals.tipCents)}`] : []),
  ].join(", ");
  // Free delivery takes nothing off the food, so it is said on its own.
  const freeDelivery = input.fulfilment === "delivery" && totals.deliveryFeeCents === 0 ? ["Delivery is free."] : [];
  const text = [
    `Here is your ${input.fulfilment} order${scheduledFor !== null ? `, for ${spokenWhen(scheduledFor, input.now)}` : ""}.`,
    ...spokenLines,
    ...(address ? [`Delivering to ${address}.`] : []),
    ...(deliveryInstructions ? [`Delivery instructions: ${spoken(deliveryInstructions)}.`] : []),
    ...(coupon && !coupon.applied ? [`The promo code ${coupon.code} is not taking anything off: ${coupon.message ?? "it does not apply to this order."}`] : []),
    `${money}. Your total is ${formatMoney(totals.amountDueCents)}.`,
    ...freeDelivery,
    payment,
    scheduledFor !== null
      ? `It will be ${input.fulfilment === "delivery" ? "delivered" : "ready for pickup"} ${when}.`
      : `It should be ${input.fulfilment === "delivery" ? "with you" : "ready"} ${when}.`,
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
      tipCents: totals.tipCents,
      totalCents: totals.totalCents,
      amountDueCents: totals.amountDueCents,
    },
    promotions,
    coupon,
    deliveryInstructions,
    payment,
    estimate: { minutes: input.quote.estimateMinutes, readyAround, scheduledFor, when },
  };
}
