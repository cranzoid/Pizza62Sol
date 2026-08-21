/**
 * What each notification kind actually says, per channel.
 *
 * Kept separate from both the dispatcher (which decides *when*) and the channels
 * (which decide *how it leaves*) so that changing wording never risks changing
 * delivery semantics.
 *
 * **Only unrecoverable values live in the outbox payload.** Tracking and feedback
 * tokens are stored in `orders` as hashes, so a dispatcher running minutes later
 * cannot reconstruct them — they have to be handed over at write time. Everything
 * else (status, total, items, schedule) is read from the database at send time
 * instead, which keeps the payload small and, more usefully, keeps the message
 * accurate: an order that changed between being queued and being sent describes
 * itself correctly.
 *
 * The consequence is that a plaintext token sits in `notification_outbox` for the
 * life of the row. That is a deliberate, bounded trade — the alternative is a
 * confirmation email with no tracking link, and per H-15 the email *is* the
 * private channel that makes the link safe to hand out at all. The dispatcher
 * scrubs the payload once the row is sent, so the exposure is the queue window
 * rather than forever.
 */
import { publicBaseUrl } from "@/lib/notifications/config";

export type OrderSnapshot = {
  id: string;
  order_number: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  fulfilment: string;
  status: string;
  payment_status: string;
  payment_method: string;
  schedule_type: string;
  scheduled_for: number | null;
  estimated_for: number;
  total_cents: number;
  address_json: string | null;
  acknowledged_at: number | null;
};

export type RenderedMessage = {
  emailSubject: string;
  emailText: string;
  smsBody: string;
  /** Present only for kinds that place a call. */
  voiceSay?: string;
};

const TORONTO = "America/Toronto";

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-CA", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TORONTO,
  });
}

/**
 * A link only if a base URL is configured.
 *
 * Returning null rather than a relative path is deliberate: a relative URL in an
 * email is not a link, it is a dead string. Better to omit it and tell the
 * customer how to find the order by hand.
 */
async function trackingLink(orderNumber: string, token: string | undefined): Promise<string | null> {
  const base = await publicBaseUrl();
  if (!base || !token) return null;
  return `${base}/track?order=${encodeURIComponent(orderNumber)}&token=${encodeURIComponent(token)}`;
}

async function feedbackLink(orderNumber: string, token: string | undefined): Promise<string | null> {
  const base = await publicBaseUrl();
  if (!base || !token) return null;
  return `${base}/feedback?order=${encodeURIComponent(orderNumber)}&token=${encodeURIComponent(token)}`;
}

function whenLine(order: OrderSnapshot): string {
  const verb = order.fulfilment === "delivery" ? "Delivery" : "Pickup";
  return order.schedule_type === "scheduled" && order.scheduled_for
    ? `${verb} scheduled for ${clockTime(order.scheduled_for)}`
    : `${verb} estimated around ${clockTime(order.estimated_for)}`;
}

export async function renderCustomerConfirmation(
  order: OrderSnapshot,
  payload: { trackingToken?: string },
  itemLines: string[],
): Promise<RenderedMessage> {
  const link = await trackingLink(order.order_number, payload.trackingToken);
  const paid = order.payment_status === "paid";
  const body = [
    `Hi ${order.customer_name.split(" ")[0] || "there"},`,
    "",
    `Pizza 62 has your order ${order.order_number}.`,
    "",
    ...itemLines.map((line) => `  ${line}`),
    "",
    `Total: ${money(order.total_cents)}${paid ? " (paid)" : " — pay at the store"}`,
    whenLine(order),
    "",
    link
      ? `Track your order: ${link}`
      : `Track your order at pizza62.ca/track using order number ${order.order_number} and the tracking token from your receipt.`,
    "",
    "Questions? Call us at (905) 547-5777.",
    "Pizza 62 · 55 Parkdale Ave N, Hamilton, ON",
  ].join("\n");

  return {
    emailSubject: `Pizza 62 order ${order.order_number} confirmed`,
    emailText: body,
    // Short on purpose: one SMS segment where possible, and the link is the only
    // part that matters on a phone.
    smsBody: link
      ? `Pizza 62: order ${order.order_number} confirmed, ${money(order.total_cents)}. ${whenLine(order)}. Track: ${link}`
      : `Pizza 62: order ${order.order_number} confirmed, ${money(order.total_cents)}. ${whenLine(order)}.`,
  };
}

export function renderRestaurantNewOrder(order: OrderSnapshot, itemLines: string[]): RenderedMessage {
  const address = order.address_json ? (JSON.parse(order.address_json) as Record<string, string>) : null;
  const destination = address
    ? `${address.line1}${address.unit ? ` Unit ${address.unit}` : ""}, ${address.city ?? "Hamilton"}`
    : "Pickup at the store";
  const paid = order.payment_status === "paid";

  const body = [
    `NEW ${order.fulfilment.toUpperCase()} ORDER — ${order.order_number}`,
    "",
    ...itemLines.map((line) => `  ${line}`),
    "",
    `Total: ${money(order.total_cents)} — ${paid ? "PAID ONLINE" : "COLLECT AT STORE"}`,
    whenLine(order),
    `Customer: ${order.customer_name}, ${order.customer_phone}`,
    `Destination: ${destination}`,
  ].join("\n");

  // The spoken version is deliberately not the written one. A phone call cannot
  // convey a list of toppings usefully, and trying makes the important part —
  // that there IS an order, and roughly what shape it is — harder to catch. The
  // detail is on the kitchen screen and the ticket; the call exists to make
  // someone look at them.
  const voiceSay = [
    "New order from the Pizza 62 website.",
    `${order.fulfilment === "delivery" ? "Delivery" : "Pickup"} order, number ${order.order_number.replace("P62-", "")}.`,
    `${itemLines.length} ${itemLines.length === 1 ? "item" : "items"}, total ${money(order.total_cents)}.`,
    paid ? "Already paid online." : "To be paid at the store.",
    order.schedule_type === "scheduled" && order.scheduled_for
      ? `Scheduled for ${clockTime(order.scheduled_for)}.`
      : "As soon as possible.",
  ].join(" ");

  return {
    emailSubject: `NEW ${order.fulfilment} order ${order.order_number} — ${money(order.total_cents)}`,
    emailText: body,
    smsBody: `Pizza 62 NEW ${order.fulfilment} ${order.order_number}: ${itemLines.length} item(s), ${money(order.total_cents)}${paid ? " PAID" : " COLLECT"}. ${whenLine(order)}.`,
    voiceSay,
  };
}

export function renderLowRatingAlert(payload: {
  orderNumber?: string;
  overall?: number;
  writtenFeedback?: string | null;
  customerName?: string;
  customerPhone?: string;
}): RenderedMessage {
  const body = [
    `Low rating on order ${payload.orderNumber ?? "unknown"}.`,
    "",
    `Rating: ${payload.overall ?? "?"} out of 5`,
    `Customer: ${payload.customerName ?? "unknown"}${payload.customerPhone ? `, ${payload.customerPhone}` : ""}`,
    "",
    payload.writtenFeedback ? `They wrote:\n\n  ${payload.writtenFeedback}` : "They left no written comment.",
  ].join("\n");

  return {
    emailSubject: `Low rating (${payload.overall ?? "?"}/5) on order ${payload.orderNumber ?? ""}`.trim(),
    emailText: body,
    smsBody: `Pizza 62: ${payload.overall ?? "?"}/5 rating on ${payload.orderNumber ?? "an order"}. Check the dashboard.`,
  };
}

export async function renderFeedbackRequest(
  order: OrderSnapshot,
  payload: { feedbackToken?: string },
): Promise<RenderedMessage> {
  const link = await feedbackLink(order.order_number, payload.feedbackToken);
  const body = [
    `Hi ${order.customer_name.split(" ")[0] || "there"},`,
    "",
    `Thanks for ordering from Pizza 62. How did we do with order ${order.order_number}?`,
    "",
    link ? `Leave feedback: ${link}` : "Reply to this email and let us know.",
    "",
    "It takes under a minute and we read every one.",
    "Pizza 62 · 55 Parkdale Ave N, Hamilton, ON",
  ].join("\n");

  return {
    emailSubject: `How was your Pizza 62 order?`,
    emailText: body,
    smsBody: link
      ? `Pizza 62: how did we do with ${order.order_number}? ${link}`
      : `Pizza 62: how did we do with order ${order.order_number}?`,
  };
}
