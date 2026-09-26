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
import {
  formatEntryNumber,
  giveawayStatus,
  giveawaySummary,
  lastEntryDayLabel,
  minimumLabel,
  orderQualifies,
  type GiveawaySetting,
  type NudgeKind,
} from "@/lib/giveaway";
import { loadGiveaway, recordGiveawayEntrySafely } from "@/lib/giveaway-store";
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
  /** What a gift card paid. Zero on almost every order, and on every old one. */
  gift_card_applied_cents: number;
  address_json: string | null;
  instructions: string | null;
  acknowledged_at: number | null;
  /** When the order was placed — what the giveaway window is judged against. */
  created_at: number;
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
  const giftCardCents = Number(order.gift_card_applied_cents ?? 0);
  const amountDueCents = Math.max(0, Number(order.total_cents ?? 0) - giftCardCents);
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
        {
          label: "Payment",
          // Three answers, not two. Someone who paid with a gift card and owes
          // nothing should not be told to "pay at the store", and someone whose
          // card covered half of it needs to know what is still owed.
          value:
            giftCardCents > 0 && amountDueCents === 0
              ? "Paid in full by gift card"
              : giftCardCents > 0
                ? `${money(giftCardCents)} by gift card · ${money(amountDueCents)} ${paid ? "paid online" : "at the store"}`
                : paid
                  ? "Paid online"
                  : "Pay at the store",
        },
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

  // After the payment line and before the items: the first thing below the
  // order number the customer will actually read.
  const giveaway = await receiptGiveawaySection(order);
  if (giveaway) sections.splice(3, 0, giveaway);

  const { emailHtml, emailText } = build({
    eyebrow: "Order confirmed",
    heading: "You're all set.",
    tone: "confirmation",
    preheader: `${order.order_number} · ${money(order.total_cents)}${giftCardCents > 0 ? " · paid by gift card" : ""} · ${whenLine(order)}`,
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

// --- the Thanksgiving Giveaway ------------------------------------------------

const GIVEAWAY_KICKER = "Pizza 62 turns one · Thanksgiving Giveaway";

/** "a brand-new 55-inch TV" → "A brand-new 55-inch TV". */
function capitalise(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * A link back to the site, labelled so an order it produces is attributed to
 * the email that prompted it (see lib/attribution.ts). That is how the owner
 * finds out whether the nudges were worth sending.
 */
function campaignLink(base: string, medium: string): string {
  return `${base}/?utm_source=email&utm_medium=${medium}&utm_campaign=thanksgiving_giveaway`;
}

/**
 * The giveaway block on the receipt.
 *
 * A qualifying order shows its entry number. The number is fetched through
 * `recordGiveawayEntrySafely` rather than merely read: on a card order the
 * receipt is released the instant the payment clears, and the entry is written
 * a moment after — so a receipt that only *read* could, in that window, go out
 * saying nothing. Recording is idempotent, so this either finds the entry or
 * creates it, and the receipt always carries the number.
 *
 * An order under the minimum while the giveaway is open gets one line saying
 * how it works, rather than silence — the customer who spent $8 is the one
 * the rule is most worth telling.
 */
async function receiptGiveawaySection(order: OrderSnapshot): Promise<Section | null> {
  const giveaway = await loadGiveaway().catch(() => null);
  if (!giveaway?.enabled) return null;
  const qualifies = orderQualifies(giveaway, {
    placedAt: Number(order.created_at),
    subtotalCents: Number(order.subtotal_cents),
    discountCents: Number(order.discount_cents),
  });
  const entryNumber = qualifies ? await recordGiveawayEntrySafely(order.id) : null;
  if (entryNumber !== null) {
    return {
      type: "giveaway",
      kicker: GIVEAWAY_KICKER,
      headline: `You're entered to win ${giveaway.prize}.`,
      entry: formatEntryNumber(entryNumber),
      lines: [
        `Winner announced ${giveaway.winnerAnnouncedOn}.`,
        `Every order of ${minimumLabel(giveaway)} or more before tax is another entry, until closing on ${lastEntryDayLabel(giveaway)}.`,
      ],
    };
  }
  if (giveawayStatus(giveaway, Date.now()) !== "open") return null;
  return {
    type: "note",
    title: GIVEAWAY_KICKER,
    lines: [giveawaySummary(giveaway), `Winner announced ${giveaway.winnerAnnouncedOn}.`],
  };
}

/**
 * The "you're in" email: the thank-you the owner asked for, sent to everyone
 * whose order earned an entry — online, phone, or a walk-in who gave an email.
 *
 * It exists separately from the receipt because it is a different message. The
 * receipt is about the pizza and gets read for the pickup time; this one is
 * about the restaurant turning one, and it is the one worth keeping. It says
 * why the giveaway is happening, what the prize is, when the winner is picked,
 * how they will be reached, and that every order is another chance.
 */
export async function renderGiveawayEntry(
  order: OrderSnapshot,
  input: { entryNumber: number; giveaway: GiveawaySetting; totalEntries: number },
): Promise<RenderedMessage> {
  const base = await publicBaseUrl();
  const { giveaway } = input;
  const entry = formatEntryNumber(input.entryNumber);
  const total = Math.max(1, input.totalEntries);

  const sections: Section[] = [
    {
      type: "paragraph",
      text: `Hi ${firstName(order.customer_name)}, Pizza 62 turned one this year, and we're celebrating with the neighbours who got us here. Your order ${order.order_number} has entered you in our Thanksgiving Giveaway.`,
    },
    {
      type: "giveaway",
      size: "hero",
      kicker: "Thanksgiving Giveaway",
      headline: `Win ${giveaway.prize}`,
      entry,
      lines: [`From order ${order.order_number}`],
    },
    {
      type: "facts",
      rows: [
        { label: "The prize", value: capitalise(giveaway.prize) },
        { label: "Winner announced", value: giveaway.winnerAnnouncedOn },
        { label: "Entries close", value: `Closing time on ${lastEntryDayLabel(giveaway)}` },
        { label: "Your entries", value: total === 1 ? "1 so far" : `${total} so far` },
        {
          label: "More chances",
          value: `Every order of ${minimumLabel(giveaway)} or more before tax is another entry — pickup, delivery or in store.`,
        },
      ],
    },
    {
      type: "note",
      title: "How it works",
      lines: [
        "If your entry is picked, we'll call or email you using the details on this order.",
        "Keep this email — your entry number is your proof of entry.",
        "Orders that are cancelled or refunded are not eligible.",
      ],
    },
  ];
  if (base) {
    sections.push({ type: "button", label: "Order again", href: campaignLink(base, "giveaway_entry") });
    sections.push({ type: "paragraph", text: `Full details: ${base.replace(/^https?:\/\//, "")}/giveaway` });
  }

  const { emailHtml, emailText } = build({
    eyebrow: "Pizza 62 turns one",
    heading: "You're in the Thanksgiving Giveaway.",
    tone: "confirmation",
    preheader: `Entry ${entry} · Win ${giveaway.prize} · Winner announced ${giveaway.winnerAnnouncedOn}`,
    signoff: "Thank you for a wonderful first year. — Everyone at Pizza 62",
    baseUrl: base,
    sections,
  });

  return {
    emailSubject: `You're in! Pizza 62 Thanksgiving Giveaway entry ${entry}`,
    emailText,
    emailHtml,
    smsBody: `Pizza 62 turns one! Order ${order.order_number} is entry ${entry} in our Thanksgiving Giveaway for ${giveaway.prize}.`,
  };
}

/** "tonight", "tomorrow", or "on Sunday, October 11" — judged when the email is sent. */
function closesPhrase(giveaway: GiveawaySetting, now: number): string {
  const day = (timestamp: number) => new Date(timestamp).toLocaleDateString("en-CA", { timeZone: TORONTO });
  const last = day(giveaway.endsAt - 1);
  if (day(now) === last) return "tonight at closing";
  if (day(now + 86_400_000) === last) return "tomorrow at closing";
  return `at closing on ${lastEntryDayLabel(giveaway)}`;
}

/**
 * The nudge to past customers, in its two versions.
 *
 * A commercial message under CASL, so unlike everything else in this file it
 * carries an unsubscribe link and the reason the person is receiving it.
 */
export async function renderGiveawayNudge(input: {
  name: string;
  variant: NudgeKind;
  giveaway: GiveawaySetting;
  entries: number;
  unsubscribeHref: string;
  test?: boolean;
  now?: number;
}): Promise<RenderedMessage> {
  const base = await publicBaseUrl();
  const { giveaway } = input;
  const now = input.now ?? Date.now();
  const minimum = minimumLabel(giveaway);
  const closes = closesPhrase(giveaway, now);
  const greeting = input.name.trim() ? `Hi ${firstName(input.name)}` : "Hi there";
  const lastCall = input.variant === "last_call";

  const sections: Section[] = [
    {
      type: "paragraph",
      text: lastCall
        ? `${greeting}, our Thanksgiving Giveaway closes ${closes}. One order of ${minimum} or more (before tax) gets you an entry to win ${giveaway.prize} — and every order is another entry.`
        : `${greeting}, Pizza 62 is one year old — thank you for being part of our first year in Hamilton. To celebrate, we're giving away ${giveaway.prize} this Thanksgiving.`,
    },
    {
      type: "giveaway",
      size: "hero",
      kicker: lastCall ? "Thanksgiving Giveaway · Last call" : "Thanksgiving Giveaway",
      headline: lastCall ? `Entries close ${closes}` : `Every ${minimum} order is an entry`,
      lines: lastCall
        ? [`Winner announced ${giveaway.winnerAnnouncedOn}.`]
        : [`Order ${minimum}+ before tax by closing on ${lastEntryDayLabel(giveaway)}.`, `Winner announced ${giveaway.winnerAnnouncedOn}.`],
    },
  ];
  if (input.entries > 0) {
    sections.push({
      type: "paragraph",
      text: `You already have ${input.entries} ${input.entries === 1 ? "entry" : "entries"} — every order adds another.`,
    });
  }
  sections.push({
    type: "facts",
    rows: [
      { label: "The prize", value: capitalise(giveaway.prize) },
      { label: "How to enter", value: `Order ${minimum} or more (before tax) — online, by phone or in store.` },
      { label: "Pickup or delivery", value: "Both count." },
      { label: "Entries close", value: `Closing time on ${lastEntryDayLabel(giveaway)}` },
      { label: "Winner announced", value: giveaway.winnerAnnouncedOn },
    ],
  });
  if (base) {
    sections.push({ type: "button", label: "Order now", href: campaignLink(base, lastCall ? "nudge_last_call" : "nudge") });
    sections.push({ type: "paragraph", text: `Full details: ${base.replace(/^https?:\/\//, "")}/giveaway` });
  }

  const subject = lastCall
    ? `Last chance to win ${giveaway.prize} — entries close ${closes.replace(" at closing", "")}`
    : `Pizza 62 turns one — win ${giveaway.prize} this Thanksgiving`;
  const { emailHtml, emailText } = build({
    eyebrow: "Pizza 62 turns one",
    heading: lastCall ? `Last chance to win ${giveaway.prize}.` : `Win ${giveaway.prize} this Thanksgiving.`,
    tone: "feedback",
    preheader: `Every order of ${minimum}+ before tax is an entry. Winner announced ${giveaway.winnerAnnouncedOn}.`,
    signoff: "Thank you for a great first year. — Everyone at Pizza 62",
    baseUrl: base,
    sections,
    unsubscribe: {
      reason: "You're receiving this because you've ordered from Pizza 62.",
      href: input.unsubscribeHref,
    },
  });

  return {
    emailSubject: `${input.test ? "[TEST] " : ""}${subject}`,
    emailText,
    emailHtml,
    smsBody: `Pizza 62 turns one! Every ${minimum}+ order is an entry to win ${giveaway.prize}. Entries close ${closes}.`,
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
  // The restriction leads the small print. A customer who reads one line reads
  // the first one, and "only on garlic bread or pop" is the line that decides
  // what they put in the basket — telling them at checkout instead is telling
  // them after they have chosen.
  const conditions = [
    reward.restrictedTo ? `Redeemable on ${reward.restrictedTo} only.` : null,
    reward.minimumCents > 0 ? `On orders of ${money(reward.minimumCents)} or more.` : "On any order.",
    reward.endsAt
      ? `Valid until ${new Date(reward.endsAt).toLocaleDateString("en-CA", { day: "numeric", month: "long", year: "numeric", timeZone: TORONTO })}.`
      : "No expiry date — use it whenever you are next in.",
    "One code per order. Pickup or delivery.",
  ].filter((line): line is string => Boolean(line));

  const sections: Section[] = [
    {
      type: "paragraph",
      text: `Thank you, ${firstName(order.customer_name)}. Someone here reads every one of these, and what you told us about order ${order.order_number} goes straight to the people who made it.`,
    },
    {
      type: "paragraph",
      text: reward.restrictedTo
        ? `Have ${reward.offer} on us next time — the code comes off ${reward.restrictedTo}. Enter it at checkout, or read it out to whoever answers the phone.`
        : `Have ${reward.offer} on us next time. Enter this code at checkout, or read it out to whoever answers the phone.`,
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
    smsBody: reward.restrictedTo
      ? `Pizza 62: thanks for the feedback. Code ${reward.code} takes ${worth} ${reward.restrictedTo} on your next order.`
      : `Pizza 62: thanks for the feedback. Code ${reward.code} takes ${worth} your next order.`,
  };
}

// --- customer: the restaurant writes back ------------------------------------

/**
 * The reply a member of staff typed, in the house envelope.
 *
 * **The words are carried in the payload, not read back at send time.** That is
 * the opposite of the rule the rest of this file follows, and deliberately so:
 * everything else in a message is a *fact about the order* that should describe
 * itself correctly whenever it is sent, whereas a reply is a thing a person
 * said at a moment. If the owner writes a second, better reply while the first
 * is still queued, the first must go out as it was approved — or be replaced on
 * purpose — rather than silently becoming a message nobody wrote.
 *
 * The customer's own words are quoted back for the same reason a support reply
 * quotes the ticket: this may arrive days later, and "we are sorry about that"
 * with no antecedent is a message that cannot be understood.
 */
export async function renderFeedbackReply(
  order: OrderSnapshot,
  payload: {
    orderNumber?: string;
    overall?: number;
    writtenFeedback?: string | null;
    reply?: string;
  },
): Promise<RenderedMessage> {
  const base = await publicBaseUrl();
  const orderNumber = payload.orderNumber ?? order.order_number;
  const rating = Number(payload.overall);
  const rated = Number.isFinite(rating) && rating >= 1 && rating <= 5;
  const written = (payload.writtenFeedback ?? "").trim();
  const reply = (payload.reply ?? "").trim();

  // The opening line is ours, and it has to fit what they actually said. The
  // same "thanks for the kind words" sent to someone who rated us one star
  // reads as a form letter that nobody opened, which is the exact impression
  // replying at all is meant to dispel.
  const opening = !rated
    ? `Hi ${firstName(order.customer_name)}, thank you for your feedback on order ${orderNumber}. Someone here read it, and wanted to write back.`
    : rating <= 2
      ? `Hi ${firstName(order.customer_name)}, thank you for telling us about order ${orderNumber} — we are sorry it was not what it should have been. Someone here read every word, and this is their reply.`
      : rating >= 4
        ? `Hi ${firstName(order.customer_name)}, thank you for the kind words about order ${orderNumber}. Someone here read them, and wanted to write back.`
        : `Hi ${firstName(order.customer_name)}, thank you for your feedback on order ${orderNumber}. Someone here read it, and this is their reply.`;

  const sections: Section[] = [{ type: "paragraph", text: opening }];
  if (rated) {
    sections.push({
      type: "callout",
      label: `Order ${orderNumber}`,
      value: `${rating} out of 5`,
      tone: rating >= 4 ? "good" : rating <= 2 ? "warn" : "neutral",
    });
  }
  if (written) sections.push({ type: "note", title: "What you told us", lines: [written] });
  sections.push({ type: "divider" });
  // Every non-empty line becomes its own paragraph, so a reply typed with
  // breaks in it arrives with them. Collapsing it into one block is how a
  // three-point answer turns into a wall.
  for (const line of reply.split(/\n+/).map((entry) => entry.trim()).filter(Boolean)) {
    sections.push({ type: "paragraph", text: line });
  }
  if (base) sections.push({ type: "button", label: "Order again", href: base });

  const heading = !rated
    ? "Thank you for your feedback"
    : rating <= 2
      ? "Thank you for telling us"
      : rating >= 4
        ? "Thank you for the kind words"
        : "Thank you for your feedback";

  const { emailHtml, emailText } = build({
    eyebrow: "A reply from Pizza 62",
    heading,
    tone: "feedback",
    preheader: reply.slice(0, 120) || `A reply about order ${orderNumber}.`,
    baseUrl: base,
    // The invitation is only honest because the dispatcher sets a Reply-To that
    // reaches the restaurant. If that ever stops being true, this line goes.
    signoff: "Just reply to this email if you would like to talk it through — it comes straight to us.",
    sections,
  });

  return {
    emailSubject: `A reply from Pizza 62 about order ${orderNumber}`,
    emailText,
    emailHtml,
    smsBody: `Pizza 62 has replied to your feedback on order ${orderNumber} — it is in your email.`,
  };
}

// --- gift cards --------------------------------------------------------------

/**
 * What the recipient opens. This one is the product.
 *
 * Everything else in this file is a message *about* something that happened.
 * This one is the thing itself: the card exists nowhere but here, because the
 * code is stored only as a hash and cannot be reconstructed or re-sent. If this
 * email does not arrive and does not look right, there is no gift card.
 *
 * Three consequences run through the copy:
 *
 * - **The code is the payload**, so it gets its own panel in a monospace face
 *   and appears in the plain-text part too — not only in the HTML a text-mode
 *   client or an aggressive filter would throw away.
 * - **There is no "spend it" button carrying the code in a URL.** A link like
 *   `/order?giftcard=P62-…` would be genuinely convenient, and it would put the
 *   money in a URL — in browser history, in a `Referer` header, in every proxy
 *   log between here and there. The recipient copies the code and pastes it,
 *   which is one extra action and the reason this is safe to email at all.
 * - **"No expiry" is stated plainly**, because it is true (Ontario's Consumer
 *   Protection Act forbids one on a purchased card) and because everyone has
 *   been trained by every other gift card to assume the opposite.
 */
export async function renderGiftCardDelivery(payload: {
  amountCents: number;
  code: string;
  recipientName: string;
  senderName: string;
  message?: string | null;
}): Promise<RenderedMessage> {
  const base = await publicBaseUrl();
  const amount = money(payload.amountCents);

  const sections: Section[] = [
    {
      type: "paragraph",
      text: `${payload.senderName} has sent you a Pizza 62 gift card. Here it is.`,
    },
    {
      type: "giftcard",
      amount,
      code: payload.code,
      recipient: payload.recipientName,
      sender: payload.senderName,
      message: payload.message ?? null,
    },
    {
      type: "facts",
      rows: [
        { label: "How to use it", value: "Paste the code into the Gift card box at checkout." },
        { label: "Expires", value: "Never. This card has no expiry date and no fees." },
        { label: "Where", value: "Online at pizza62.ca, or at the counter — just read the code out." },
      ],
    },
  ];

  // The button goes to the menu, never to a redemption link carrying the code.
  if (base) {
    sections.push({ type: "button", label: "See the menu", href: base });
    sections.push({
      type: "paragraph",
      text: `You can check the balance any time at ${base.replace(/^https?:\/\//, "")}/gift-cards/balance.`,
    });
  }
  sections.push({
    type: "note",
    title: "Keep this email",
    lines: [
      "This code is the card. Treat it like cash — anyone who has it can spend it.",
      "We store it only in a scrambled form, so we cannot send it to you again. If you lose it, call us and we will cancel it and issue a replacement for whatever is left.",
    ],
  });

  const { emailHtml, emailText } = build({
    eyebrow: "A gift for you",
    heading: `${payload.senderName} sent you ${amount} at Pizza 62.`,
    tone: "confirmation",
    preheader: `${amount} gift card — no expiry. Your code is inside.`,
    signoff: "Questions about this card? Call us and we will help.",
    baseUrl: base,
    sections,
  });

  return {
    emailSubject: `${payload.senderName} sent you a ${amount} Pizza 62 gift card`,
    emailText,
    emailHtml,
    // Never sent — there is no phone number for a gift card recipient — but the
    // type requires it and a code in an SMS would be the wrong thing anyway.
    smsBody: `${payload.senderName} sent you a ${amount} Pizza 62 gift card. The code is in your email.`,
  };
}

/**
 * The buyer's receipt, which deliberately does **not** contain the code.
 *
 * A receipt is the thing people forward — to whoever is splitting the cost, to
 * an accountant, into a shared inbox. A forwarded receipt must not be a
 * spendable card, so the money stays in the recipient's message and this one
 * carries only the amount, who it went to, and the reference.
 */
export async function renderGiftCardReceipt(payload: {
  reference: string;
  amountCents: number;
  recipientName: string;
  recipientEmail: string;
  buyerName: string;
  sentAt: number;
}): Promise<RenderedMessage> {
  const base = await publicBaseUrl();
  const amount = money(payload.amountCents);

  const { emailHtml, emailText } = build({
    eyebrow: "Gift card sent",
    heading: `Your ${amount} gift card is on its way.`,
    tone: "confirmation",
    preheader: `${payload.reference} · ${amount} · delivered to ${payload.recipientName}`,
    signoff: "Need to change something? Call us and quote the reference above.",
    baseUrl: base,
    sections: [
      {
        type: "paragraph",
        text: `Hi ${firstName(payload.buyerName)}, thank you. We have emailed the card straight to ${payload.recipientName}.`,
      },
      { type: "callout", label: "Gift card reference", value: payload.reference, note: `Sent ${clockTime(payload.sentAt)}`, tone: "good" },
      {
        type: "facts",
        rows: [
          { label: "Amount", value: amount },
          { label: "Sent to", value: `${payload.recipientName} · ${payload.recipientEmail}` },
          { label: "Expires", value: "Never. Ontario gift cards carry no expiry and no fees." },
        ],
      },
      {
        type: "note",
        title: "Why the code is not in this email",
        lines: [
          "The card number went only to the recipient. Anyone holding it can spend it, so a receipt that carried it would be spendable the moment it was forwarded.",
          `If it has not arrived, check that ${payload.recipientEmail} is right and look in their junk folder — then call us.`,
        ],
      },
      // No HST line, and that is not an omission: buying a gift card is not a
      // taxable supply in Canada. The tax is charged in full when the card is
      // spent, on the food. A receipt showing HST here would be wrong.
      { type: "totals", rows: [{ label: "Paid today", value: amount, strong: true }] },
    ],
  });

  return {
    emailSubject: `Your Pizza 62 gift card ${payload.reference}`,
    emailText,
    emailHtml,
    smsBody: `Pizza 62: your ${amount} gift card for ${payload.recipientName} has been sent. Reference ${payload.reference}.`,
  };
}
