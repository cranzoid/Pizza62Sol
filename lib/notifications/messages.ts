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
 *
 * ## Every email is built as a document, not a string
 *
 * Each renderer assembles an ordered list of `Section`s and hands it to
 * `email-template.ts`, which produces the HTML *and* the plain text from the
 * same source. That is the only reason the two cannot drift: a topping added to
 * the HTML it was not added to the text is a customer who reads one of them and
 * gets a different order description than the kitchen has.
 */
import { formatMoney } from "@/lib/domain";
import { publicBaseUrl } from "@/lib/notifications/config";
import type { FeedbackReward } from "@/lib/rewards";
import {
  loadOrderItemDetails,
  summariseItems,
  totalRows,
  type OrderItemDetail,
} from "@/lib/notifications/order-details";
import {
  renderEmailHtml,
  renderEmailText,
  type EmailDocument,
  type EmailItem,
  type Section,
} from "@/lib/notifications/email-template";

export type OrderSnapshot = {
  id: string;
  order_number: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  fulfilment: string;
  channel: string;
  status: string;
  payment_status: string;
  payment_method: string;
  schedule_type: string;
  scheduled_for: number | null;
  estimated_for: number;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  delivery_fee_cents: number;
  tip_cents: number;
  total_cents: number;
  address_json: string | null;
  instructions: string | null;
  acknowledged_at: number | null;
};

export type RenderedMessage = {
  emailSubject: string;
  emailText: string;
  emailHtml: string;
  smsBody: string;
  /** Present only for kinds that place a call. */
  voiceSay?: string;
};

const TORONTO = "America/Toronto";

function money(cents: number): string {
  return formatMoney(Number(cents ?? 0));
}

function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-CA", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: TORONTO,
  });
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || "there";
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

function deliveryAddress(order: OrderSnapshot): Record<string, string> | null {
  if (!order.address_json) return null;
  try {
    return JSON.parse(order.address_json) as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * The address block, with the buzzer note attached.
 *
 * `orders.instructions` is where the delivery instruction is stored — the
 * address JSON is normalised down to the parts the radius check needs and does
 * not carry it — so the two have to be brought back together here or the driver
 * reads an address with no "buzz 402" on it.
 */
function addressLines(order: OrderSnapshot, address: Record<string, string>): string[] {
  return [
    `${address.line1}${address.unit ? `, Unit ${address.unit}` : ""}`,
    [address.city, address.province, address.postalCode].filter(Boolean).join(" "),
    order.instructions ? `Instructions: ${order.instructions}` : "",
  ].filter(Boolean);
}

/** The item detail, in the shape the template draws. */
function toEmailItems(details: OrderItemDetail[], withPrices: boolean): EmailItem[] {
  return details.map((item) => ({
    quantity: item.quantity,
    name: item.productName,
    variation: item.variationName,
    price: withPrices ? money(item.lineTotalCents) : null,
    flags: item.flags,
    details: item.details,
    note: item.instructions,
  }));
}

function build(document: EmailDocument): { emailHtml: string; emailText: string } {
  return { emailHtml: renderEmailHtml(document), emailText: renderEmailText(document) };
}

// --- customer: order confirmed ----------------------------------------------

export async function renderCustomerConfirmation(
  order: OrderSnapshot,
  payload: { trackingToken?: string },
): Promise<RenderedMessage> {
  const [link, base, details] = await Promise.all([
    trackingLink(order.order_number, payload.trackingToken),
    publicBaseUrl(),
    loadOrderItemDetails(order.id),
  ]);
  const paid = order.payment_status === "paid";
  const address = deliveryAddress(order);

  const sections: Section[] = [
    { type: "paragraph", text: `Hi ${firstName(order.customer_name)}, thanks for ordering. We have everything below and the kitchen has been told.` },
    {
      type: "callout",
      label: "Your order number",
      value: order.order_number,
      note: whenLine(order),
      tone: "good",
    },
    {
      type: "facts",
      rows: [
        { label: order.fulfilment === "delivery" ? "Delivery" : "Pickup", value: whenLine(order).replace(/^(Delivery|Pickup) /, "") },
        { label: "Payment", value: paid ? "Paid online" : "Pay at the store" },
        ...(address ? [] : [{ label: "Collect from", value: "55 Parkdale Ave N, Hamilton" }]),
      ],
    },
    { type: "divider" },
    { type: "items", items: toEmailItems(details, true) },
    { type: "totals", rows: totalRows(order) },
  ];

  if (address) {
    sections.push({ type: "note", title: "Delivering to", lines: addressLines(order, address) });
  } else if (order.instructions) {
    sections.push({ type: "note", title: "Your note to us", lines: [order.instructions] });
  }
  if (link) {
    sections.push({ type: "button", label: "Track your order", href: link });
  } else {
    sections.push({
      type: "paragraph",
      text: `Track your order at pizza62.ca/track using order number ${order.order_number} and the tracking token from your receipt.`,
    });
  }

  const { emailHtml, emailText } = build({
    eyebrow: "Order confirmed",
    heading: "You're all set.",
    tone: "confirmation",
    preheader: `${order.order_number} · ${money(order.total_cents)} · ${whenLine(order)}`,
    signoff: "Something not right? Call us and we will fix it before it goes in the oven.",
    baseUrl: base,
    sections,
  });

  return {
    emailSubject: `Pizza 62 order ${order.order_number} confirmed`,
    emailText,
    emailHtml,
    // Short on purpose: one SMS segment where possible, and the link is the only
    // part that matters on a phone.
    smsBody: link
      ? `Pizza 62: order ${order.order_number} confirmed, ${money(order.total_cents)}. ${whenLine(order)}. Track: ${link}`
      : `Pizza 62: order ${order.order_number} confirmed, ${money(order.total_cents)}. ${whenLine(order)}.`,
  };
}

// --- customer: the order moved ----------------------------------------------

/**
 * The statuses a customer is told about, and what each one says.
 *
 * **This map is the switch.** A status with an entry here queues an email when
 * staff move an order to it; one without is silent. Adding `preparing` — "we've
 * started making it" — is a matter of adding its five lines, and nothing else
 * has to change.
 *
 * Two statuses, deliberately, not four. `received` is what the confirmation
 * already said. `preparing` is the kitchen's business rather than the
 * customer's, and mailing it turns a normal order into four emails, which is
 * both an annoyance and — on a provider tier measured in a hundred a day — a
 * real cost. `completed` is followed a set delay later by the feedback request,
 * so mailing that too would be two messages inside a minute.
 *
 * What is left is exactly the pair a customer would otherwise phone the counter
 * to ask about: is it ready, and is it on its way.
 */
export const CUSTOMER_STATUS_UPDATES: Record<
  string,
  { eyebrow: string; heading: string; subject: (orderNumber: string) => string; body: string; callout: string; sms: (orderNumber: string) => string }
> = {
  ready_for_pickup: {
    eyebrow: "Ready now",
    heading: "Your order is ready for pickup.",
    subject: (orderNumber) => `Pizza 62 order ${orderNumber} is ready for pickup`,
    body: "It is boxed and waiting at the counter. Come on in and give the order number at the till.",
    callout: "Ready for pickup",
    sms: (orderNumber) => `Pizza 62: order ${orderNumber} is ready for pickup at 55 Parkdale Ave N.`,
  },
  out_for_delivery: {
    eyebrow: "On its way",
    heading: "Your order is out for delivery.",
    subject: (orderNumber) => `Pizza 62 order ${orderNumber} is on its way`,
    body: "Our driver has left the store with your order. Please keep your phone nearby in case they need directions.",
    callout: "Out for delivery",
    sms: (orderNumber) => `Pizza 62: order ${orderNumber} is out for delivery.`,
  },
};

/** True when a status change is one the customer should hear about. */
export function isCustomerNotifiableStatus(status: string): boolean {
  return Object.hasOwn(CUSTOMER_STATUS_UPDATES, status);
}

export async function renderCustomerStatusUpdate(
  order: OrderSnapshot,
  payload: { status?: string },
): Promise<RenderedMessage> {
  // The queued status, not the current one: an order that has already moved on
  // should still send the message that was queued for the step it passed
  // through, or a customer sees "ready for pickup" arrive after they have left
  // with the bag. Falls back to the live status if the payload predates this.
  const status = String(payload.status ?? order.status);
  const copy = CUSTOMER_STATUS_UPDATES[status];
  if (!copy) throw new Error(`no customer copy for status "${status}"`);
  const [base, details] = await Promise.all([publicBaseUrl(), loadOrderItemDetails(order.id)]);
  const address = deliveryAddress(order);

  const sections: Section[] = [
    { type: "paragraph", text: `Hi ${firstName(order.customer_name)}, ${copy.body}` },
    {
      type: "callout",
      label: `Order ${order.order_number}`,
      value: copy.callout,
      note: status === "out_for_delivery" && address ? addressLines(order, address)[0] : whenLine(order),
      tone: "good",
    },
    { type: "divider" },
    { type: "items", items: toEmailItems(details, false) },
    { type: "totals", rows: [{ label: "Order total", value: money(order.total_cents), strong: true }] },
  ];

  if (status === "ready_for_pickup") {
    sections.push({
      type: "note",
      title: "Pick up from",
      lines: ["Pizza 62", "55 Parkdale Ave N, Hamilton, ON L8H 5W7"],
    });
  }

  const { emailHtml, emailText } = build({
    eyebrow: copy.eyebrow,
    heading: copy.heading,
    tone: "status",
    preheader: `${order.order_number} · ${copy.callout}`,
    signoff: "Questions about this order? Call us and quote the order number.",
    baseUrl: base,
    sections,
  });

  return {
    emailSubject: copy.subject(order.order_number),
    emailText,
    emailHtml,
    smsBody: copy.sms(order.order_number),
  };
}

// --- restaurant: a new order arrived ----------------------------------------

export async function renderRestaurantNewOrder(order: OrderSnapshot): Promise<RenderedMessage> {
  const [base, details] = await Promise.all([publicBaseUrl(), loadOrderItemDetails(order.id)]);
  const address = deliveryAddress(order);
  const paid = order.payment_status === "paid";
  const itemLines = summariseItems(details);

  const sections: Section[] = [
    {
      type: "callout",
      label: `${order.fulfilment.toUpperCase()} · ${order.channel === "online" ? "WEBSITE" : order.channel.replace("_", " ").toUpperCase()}`,
      value: `${order.order_number} · ${money(order.total_cents)}`,
      note: paid ? "Paid online — do not take payment again." : "COLLECT PAYMENT AT THE STORE.",
      tone: paid ? "neutral" : "warn",
    },
    {
      type: "facts",
      rows: [
        { label: "When", value: whenLine(order) },
        { label: "Customer", value: order.customer_name },
        { label: "Phone", value: order.customer_phone || "not given" },
        { label: "Email", value: order.customer_email || "not given" },
        { label: "Payment", value: `${order.payment_method.replaceAll("_", " ")} · ${order.payment_status.replaceAll("_", " ")}` },
      ],
    },
    { type: "divider" },
    { type: "items", items: toEmailItems(details, true) },
    { type: "totals", rows: totalRows(order) },
  ];

  if (address) {
    sections.push({ type: "note", title: "Deliver to", lines: addressLines(order, address) });
  } else if (order.instructions) {
    sections.push({ type: "note", title: "Order note", lines: [order.instructions] });
  }
  if (base) {
    sections.push({ type: "button", label: "Open the kitchen board", href: `${base}/kitchen` });
  }

  const { emailHtml, emailText } = build({
    eyebrow: `New ${order.fulfilment} order`,
    heading: `${order.order_number} — ${money(order.total_cents)}`,
    tone: "alert",
    preheader: `${itemLines.length} item(s) · ${whenLine(order)} · ${paid ? "paid" : "collect"}`,
    baseUrl: base,
    sections,
  });

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
    emailText,
    emailHtml,
    smsBody: `Pizza 62 NEW ${order.fulfilment} ${order.order_number}: ${itemLines.length} item(s), ${money(order.total_cents)}${paid ? " PAID" : " COLLECT"}. ${whenLine(order)}.`,
    voiceSay,
  };
}

// --- restaurant: a customer was unhappy -------------------------------------

export async function renderLowRatingAlert(payload: {
  orderNumber?: string;
  overall?: number;
  writtenFeedback?: string | null;
  customerName?: string;
  customerPhone?: string;
}): Promise<RenderedMessage> {
  const base = await publicBaseUrl();
  const sections: Section[] = [
    {
      type: "callout",
      label: `Order ${payload.orderNumber ?? "unknown"}`,
      value: `${payload.overall ?? "?"} out of 5`,
      tone: "warn",
    },
    {
      type: "facts",
      rows: [
        { label: "Customer", value: payload.customerName ?? "unknown" },
        { label: "Phone", value: payload.customerPhone ?? "not given" },
      ],
    },
    {
      type: "note",
      title: "What they wrote",
      lines: [payload.writtenFeedback || "They left no written comment."],
    },
  ];
  if (base) sections.push({ type: "button", label: "Open the dashboard", href: `${base}/staff` });

  const { emailHtml, emailText } = build({
    eyebrow: "Low rating",
    heading: `${payload.overall ?? "?"}/5 on order ${payload.orderNumber ?? ""}`.trim(),
    tone: "alert",
    preheader: payload.writtenFeedback?.slice(0, 120) ?? "No written comment.",
    baseUrl: base,
    sections,
  });

  return {
    emailSubject: `Low rating (${payload.overall ?? "?"}/5) on order ${payload.orderNumber ?? ""}`.trim(),
    emailText,
    emailHtml,
    smsBody: `Pizza 62: ${payload.overall ?? "?"}/5 rating on ${payload.orderNumber ?? "an order"}. Check the dashboard.`,
  };
}

// --- customer: how did we do ------------------------------------------------

export async function renderFeedbackRequest(
  order: OrderSnapshot,
  payload: { feedbackToken?: string },
): Promise<RenderedMessage> {
  const [link, base, details] = await Promise.all([
    feedbackLink(order.order_number, payload.feedbackToken),
    publicBaseUrl(),
    loadOrderItemDetails(order.id),
  ]);

  const sections: Section[] = [
    {
      type: "paragraph",
      text: `Hi ${firstName(order.customer_name)}, thanks for ordering from Pizza 62. Now that you have had a chance to eat, how did we do?`,
    },
    {
      type: "callout",
      label: `Order ${order.order_number}`,
      value: summariseItems(details)[0] ?? "Your recent order",
      note: details.length > 1 ? `and ${details.length - 1} more item${details.length > 2 ? "s" : ""}` : undefined,
    },
  ];
  if (link) {
    sections.push({ type: "button", label: "Rate your order", href: link });
    sections.push({ type: "paragraph", text: "It takes under a minute, and we read every one." });
  } else {
    sections.push({ type: "paragraph", text: "Reply to this email and let us know — we read every one." });
  }

  const { emailHtml, emailText } = build({
    eyebrow: "One quick question",
    heading: "How was your Pizza 62 order?",
    tone: "feedback",
    preheader: `Tell us how order ${order.order_number} was — it takes under a minute.`,
    baseUrl: base,
    sections,
  });

  return {
    emailSubject: "How was your Pizza 62 order?",
    emailText,
    emailHtml,
    smsBody: link
      ? `Pizza 62: how did we do with ${order.order_number}? ${link}`
      : `Pizza 62: how did we do with order ${order.order_number}?`,
  };
}

// --- customer: thank you for telling us -------------------------------------

/**
 * The coupon that goes out to everyone who fills the form in.
 *
 * **The offer is read from the promotion, never from the payload.** What the
 * code is worth, what it has to be spent on and when it stops working live on
 * one row, and that row is the thing the till will actually honour — so the mail
 * quotes it rather than describing it from a second copy that can drift. An
 * email promising C$3.99 off against a code the checkout gives C$5 for is a
 * small embarrassment; the other direction is a customer told at the counter
 * that their thank-you is worth less than we said.
 *
 * The dispatcher will not call this without a live promotion, so `reward` is
 * always the real one.
 */
export async function renderFeedbackReward(
  order: OrderSnapshot,
  reward: FeedbackReward,
): Promise<RenderedMessage> {
  const base = await publicBaseUrl();
  const worth = reward.worth;
  const conditions = [
    reward.minimumCents > 0 ? `On orders of ${money(reward.minimumCents)} or more.` : "On any order.",
    reward.endsAt
      ? `Valid until ${new Date(reward.endsAt).toLocaleDateString("en-CA", { day: "numeric", month: "long", year: "numeric", timeZone: TORONTO })}.`
      : "No expiry date — use it whenever you are next in.",
    "One code per order. Pickup or delivery.",
  ];

  const sections: Section[] = [
    {
      type: "paragraph",
      text: `Thank you, ${firstName(order.customer_name)}. Someone here reads every one of these, and what you told us about order ${order.order_number} goes straight to the people who made it.`,
    },
    {
      type: "paragraph",
      text: `Have ${reward.offer} on us next time. Enter this code at checkout, or read it out to whoever answers the phone.`,
    },
    { type: "callout", label: "Your code", value: reward.code, note: worth, tone: "good" },
    { type: "note", title: "The small print", lines: conditions },
  ];
  if (base) sections.push({ type: "button", label: "Order again", href: base });

  const { emailHtml, emailText } = build({
    eyebrow: "Thank you",
    heading: `Have ${reward.offer} on us`,
    tone: "feedback",
    preheader: `${reward.code} — ${worth} on your next Pizza 62 order.`,
    baseUrl: base,
    sections,
  });

  return {
    emailSubject: `Thanks for the feedback — have ${reward.offer} on us`,
    emailText,
    emailHtml,
    smsBody: `Pizza 62: thanks for the feedback. Code ${reward.code} takes ${worth} your next order.`,
  };
}
