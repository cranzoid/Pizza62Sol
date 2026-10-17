/**
 * The voice tools: what a phone agent may ask the restaurant's system to do.
 *
 * Each tool is a function of an authenticated voice session and a small,
 * whitelisted argument object. The HTTP route (app/api/voice/tools/[tool]) is a
 * thin wrapper that checks the provider's bearer token and hands over; tests
 * and the developer simulator call `runVoiceTool` directly.
 *
 * The rules that make this safe live here, in code, not in a prompt:
 *
 * - **No tool accepts money.** Prices, subtotals, tax, fees, free delivery,
 *   discounts, the channel and idempotency keys are refused by name
 *   (lib/voice/cart.ts). Every amount comes from `quoteOrder` / `createOrder`.
 *   A promo code is a string the server checks; a tip is a preset percentage
 *   or a dollar amount the server prices; an order time is a day and a clock
 *   time the server matches to the website's own slots.
 * - **Only real menu ids.** `search_menu` and `get_menu_item` read the public
 *   catalogue; `add_item` checks the product is in it, then `quoteOrder` with
 *   the AI policy validates it exactly as the website would.
 * - **Every change re-quotes** and moves the draft's version, which clears any
 *   review and confirmation (lib/voice/session.ts).
 * - **`review_order` writes the read-back; `confirm_order` binds the caller's
 *   yes to that exact version; `place_order` requires both, a confirmation
 *   under five minutes old and an unchanged total, then calls `createOrder`
 *   with the `ai_phone` context and the key `voice:<session>:<version>`.** A
 *   retried placement returns the same order.
 *
 * Every call is logged to `voice_call_events`, redacted, with its outcome; the
 * third consecutive failure tells the agent to hand the caller to staff.
 */
import { getD1, getSetting } from "@/db/runtime";
import {
  formatMoney,
  isStoreOpenAt,
  sectionOptionPrices,
  storeStatus,
  toppingWeight,
  type Fulfilment,
  type WeeklyHours,
} from "@/lib/domain";
import { closureMessage, loadActiveClosures } from "@/lib/closures";
import { logFailure } from "@/lib/log";
import { publicBaseUrl } from "@/lib/notifications/config";
import { aiPhoneOrderContext } from "@/lib/order-policy";
import {
  checkCartDeliveryEligibility,
  createOrder,
  OrderValidationError,
  quoteOrderDetailed,
  type OrderQuote,
  type QuotedItemDetail,
} from "@/lib/order-service";
import {
  assertOnlyFields,
  CHEESE_CHOICES,
  LINE_FIELDS,
  readId,
  readLineChoices,
  readText,
  toOrderRequest,
  ToolInputError,
  type ToolIssue,
} from "@/lib/voice/cart";
import {
  clockLabel,
  dayLabel,
  localDate,
  minuteLabel,
  orderSlots,
  parseDay,
  resolveSlot,
  SCHEDULE_INTERVAL_MINUTES,
  spokenWhen,
  upcomingDays,
  type SlotResolution,
} from "@/lib/voice/schedule";
import {
  VOICE_CONFIRMATION_TTL_MS,
  VOICE_ESCALATE_AFTER_FAILURES,
  VOICE_MAX_TOOL_CALLS,
  voiceMaxOrderCents,
  voicePilotFulfilments,
} from "@/lib/voice/config";
import {
  buildMenuIndex,
  canonicalProductId,
  equivalentPizzaFor,
  loadVoiceCatalog,
  resolveMenuQuery,
  type MenuIndex,
  type VoiceCatalog,
  type VoiceCatalogProduct,
} from "@/lib/voice/menu-index";
import { addressLine, buildReadback, describeLines } from "@/lib/voice/readback";
import { redactForLog, redactText } from "@/lib/voice/redact";
import {
  abandonPlacement,
  applyDraftChange,
  authenticateVoiceSession,
  beginPlacement,
  completePlacement,
  expireConfirmation,
  loadVoiceSession,
  recordConfirmation,
  recordReview,
  recordToolEvent,
  startDraft,
  type DraftChange,
  type TransitionResult,
  type VoiceCartLine,
  type VoiceOrderOptions,
  type VoiceSession,
} from "@/lib/voice/session";

const TZ = "America/Toronto";

/** What every tool answers with. `say` is server-written and safe to read to the caller as it is. */
export type ToolEnvelope = {
  ok: boolean;
  data?: Record<string, unknown>;
  issues?: ToolIssue[];
  say?: string;
  /** Hand the caller to a member of staff. */
  escalate?: boolean;
  cartVersion?: number;
  stage?: string;
};

type Outcome = {
  ok: boolean;
  data?: Record<string, unknown>;
  issues?: ToolIssue[];
  say?: string;
  escalate?: boolean;
  escalationReason?: string;
  /**
   * A refusal that is an ordinary answer — "we can't do 5:40, would 5:45 work?"
   * — rather than something going wrong. Logged as not ok, but it does not
   * count towards the consecutive failures that hand the caller to staff.
   */
  soft?: boolean;
  /** The session after the tool, when it changed. */
  session?: VoiceSession;
};

type Context = {
  session: VoiceSession;
  now: number;
  catalog: () => Promise<VoiceCatalog>;
  index: () => Promise<MenuIndex>;
};

type Tool = {
  /** The arguments it accepts. Anything else is refused. */
  fields: readonly string[];
  run: (context: Context, args: Record<string, unknown>) => Promise<Outcome>;
};

// --- shared pieces ----------------------------------------------------------------------

const refuse = (code: string, message: string, extra: Partial<Outcome> = {}): Outcome => ({
  ok: false,
  issues: [{ code, message }],
  say: message,
  ...extra,
});

function failedTransition(result: Extract<TransitionResult, { ok: false }>): Outcome {
  if (result.reason === "expired") return refuse("SESSION_EXPIRED", "This call's order session has ended.", { escalate: true });
  if (result.session?.stage === "placed") return refuse("ORDER_ALREADY_PLACED", "This order has already been placed. Changes to it go to the restaurant staff.");
  if (result.session?.stage === "placing") return refuse("PLACEMENT_IN_PROGRESS", "The order is being placed right now. Try again in a moment.");
  if (result.session?.stage === "new") return refuse("ORDER_NOT_STARTED", "Call start_order before adding to the order.");
  return refuse("CART_CHANGED", "The order changed since you last saw it. Look at it again with get_cart before changing it.");
}

function editable(session: VoiceSession): Outcome | null {
  if (session.stage === "new") return refuse("ORDER_NOT_STARTED", "Call start_order before adding to the order.");
  if (session.stage === "placed") return refuse("ORDER_ALREADY_PLACED", "This order has already been placed. Changes to it go to the restaurant staff.");
  if (session.stage === "placing") return refuse("PLACEMENT_IN_PROGRESS", "The order is being placed right now. Try again in a moment.");
  return null;
}

function expectedVersion(args: Record<string, unknown>, issues: ToolIssue[]): number | undefined {
  if (args.expectedCartVersion === undefined) return undefined;
  const version = Number(args.expectedCartVersion);
  if (!Number.isSafeInteger(version) || version < 0) {
    issues.push({ code: "INVALID_INPUT", field: "expectedCartVersion", message: "expectedCartVersion must be the cartVersion from the last response." });
    return undefined;
  }
  return version;
}

function readFulfilment(value: unknown, issues: ToolIssue[], required = false): Fulfilment | null {
  if (value === undefined || value === null) {
    if (required) issues.push({ code: "INVALID_INPUT", field: "fulfilment", message: "fulfilment must be pickup or delivery." });
    return null;
  }
  if (value === "pickup" || value === "delivery") return value;
  issues.push({ code: "INVALID_INPUT", field: "fulfilment", message: "fulfilment must be pickup or delivery." });
  return null;
}

const recipeLookup = (catalog: VoiceCatalog) => (productId: string) => {
  const product = catalog.products.find((entry) => entry.id === productId);
  return product?.configuration.fixedRecipe && Array.isArray(product.configuration.recipeToppingIds)
    ? (product.configuration.recipeToppingIds as unknown[]).map(String)
    : null;
};

const toppingNamesOf = (catalog: VoiceCatalog) => new Map(catalog.toppings.map((topping) => [topping.id, topping.name]));

const spokenPhone = (digits: string) => {
  const local = digits.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return local.length === 10 ? `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}` : digits;
};

/** "6:45 PM" — en-CA writes "p.m.", which reads badly mid-sentence and doubles a full stop. */
const clock = (timestamp: number) =>
  new Date(timestamp)
    .toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: TZ })
    .replace(/\s?a\.m\./i, " AM")
    .replace(/\s?p\.m\./i, " PM");

async function deliveryAllowed(): Promise<boolean> {
  return (await voicePilotFulfilments()).has("delivery");
}

async function aiContext(session: VoiceSession) {
  return aiPhoneOrderContext({ voiceSessionId: session.id, allowPayOnDelivery: await deliveryAllowed() });
}

type Priced = { quote: OrderQuote | null; items: QuotedItemDetail[]; itemsValid: boolean };

/** The draft (or a candidate cart, or candidate checkout choices) priced by the server, as the AI policy sees it. */
async function priceCart(
  session: VoiceSession,
  catalog: VoiceCatalog,
  cart: VoiceCartLine[] = session.cart,
  options: VoiceOrderOptions = session.orderOptions,
): Promise<Priced> {
  if (!cart.length) return { quote: null, items: [], itemsValid: true };
  return quoteOrderDetailed(toOrderRequest({ ...session, fulfilment: session.fulfilment ?? "pickup" }, recipeLookup(catalog), cart, options), await aiContext(session));
}

// --- the store's settings, as the website reads them --------------------------------------

type OrderingSettings = {
  enabled: boolean;
  paused: boolean;
  pauseMessage: string;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  payAtStorePickupEnabled?: boolean;
  pickupEstimateMinutes: number;
  deliveryEstimateMinutes: number | null;
  lastOrderCutoffMinutes?: number;
};

type StoreSettings = {
  ordering: OrderingSettings;
  hours: WeeklyHours;
  closures: Awaited<ReturnType<typeof loadActiveClosures>>;
  pilot: ReadonlySet<Fulfilment>;
};

async function storeSettings(now: number): Promise<StoreSettings> {
  const [ordering, hours, closures, pilot] = await Promise.all([
    getSetting<OrderingSettings>("ordering"),
    getSetting<WeeklyHours>("hours"),
    loadActiveClosures(now),
    voicePilotFulfilments(),
  ]);
  return { ordering, hours, closures, pilot };
}

/** The lead time `quoteOrder` and `createOrder` apply to this fulfilment. */
const leadMinutes = (ordering: OrderingSettings, fulfilment: Fulfilment) =>
  fulfilment === "delivery" ? ordering.deliveryEstimateMinutes ?? 30 : ordering.pickupEstimateMinutes;

const orderingOn = (ordering: OrderingSettings) => ordering.enabled && !ordering.paused;
const fulfilmentOn = (settings: StoreSettings, fulfilment: Fulfilment) =>
  orderingOn(settings.ordering) &&
  (fulfilment === "delivery" ? settings.ordering.deliveryEnabled && settings.pilot.has("delivery") : settings.ordering.pickupEnabled);

/** Whether an ASAP order of this fulfilment would be accepted right now: the website's own test. */
function asapAvailable(settings: StoreSettings, fulfilment: Fulfilment, now: number): boolean {
  return fulfilmentOn(settings, fulfilment) && storeStatus(now, settings.hours, TZ, {
    closures: settings.closures,
    fulfilment,
    lastOrderCutoffMinutes: Number(settings.ordering.lastOrderCutoffMinutes ?? 0),
  }).open;
}

/** The times this fulfilment can be scheduled for, as the checkout offers them, less closures. */
function slotsFor(settings: StoreSettings, fulfilment: Fulfilment, now: number): number[] {
  if (!fulfilmentOn(settings, fulfilment)) return [];
  return orderSlots({ now, hours: settings.hours, closures: settings.closures, fulfilment, leadMinutes: leadMinutes(settings.ordering, fulfilment) });
}

const slotView = (slot: number, now: number) => ({ at: slot, date: localDate(slot), time: clockLabel(slot), when: spokenWhen(slot, now) });

function quoteIssues(quote: OrderQuote | null, cart: VoiceCartLine[]): ToolIssue[] {
  return (quote?.issues ?? []).map((issue) => ({
    code: issue.code,
    message: issue.message,
    lineId: issue.index === null ? null : cart[issue.index]?.lineId ?? null,
  }));
}

function totalsView(quote: OrderQuote | null) {
  if (!quote) return null;
  const { totals } = quote;
  return {
    subtotalCents: totals.menuSubtotalCents,
    discountCents: totals.discountCents,
    deliveryFeeCents: totals.deliveryFeeCents,
    taxCents: totals.taxCents,
    tipCents: totals.tipCents,
    totalCents: totals.totalCents,
    amountDueCents: totals.amountDueCents,
    spokenTotal: formatMoney(totals.amountDueCents),
  };
}

/** The caller's checkout choices as the agent may read them: the time, the code and what it did, the tip. */
function optionsView(session: VoiceSession, quote: OrderQuote | null, now: number) {
  const { schedule, couponCode, tip } = session.orderOptions;
  return {
    schedule: schedule.type === "scheduled" ? { type: "scheduled" as const, ...slotView(schedule.scheduledFor, now) } : { type: "asap" as const },
    coupon: quote?.coupon
      ? { code: quote.coupon.code, status: quote.coupon.status, message: quote.coupon.message }
      : couponCode
        ? { code: couponCode, status: "unpriced" as const, message: null }
        : null,
    tip,
    appliedPromotions: (quote?.appliedPromotions ?? []).map((promotion) => ({ name: promotion.name, discountCents: promotion.discountCents })),
  };
}

function cartView(session: VoiceSession, priced: Priced, catalog: VoiceCatalog, now: number) {
  return {
    cartVersion: session.cartVersion,
    stage: session.stage,
    fulfilment: session.fulfilment,
    customer: session.customerName ? { name: session.customerName, phone: session.customerPhone ? spokenPhone(session.customerPhone) : null, phoneSource: session.customerPhoneSource } : null,
    deliveryAddress: addressLine(session.deliveryAddress),
    deliveryInstructions: session.deliveryAddress?.instructions ?? null,
    lines: describeLines(session.cart, priced.items, toppingNamesOf(catalog)),
    ...optionsView(session, priced.quote, now),
    totals: totalsView(priced.quote),
    issues: quoteIssues(priced.quote, session.cart),
  };
}

function catalogProduct(catalog: VoiceCatalog, index: MenuIndex, productId: string): VoiceCatalogProduct | null {
  const id = canonicalProductId(index, productId);
  return catalog.products.find((product) => product.id === productId) ?? catalog.products.find((product) => product.id === id) ?? null;
}

/** Whether the website asks this item's cheese: pizzas, unless the owner switched the step off. */
function hasCheeseStep(product: VoiceCatalogProduct): boolean {
  return product.productType === "pizza" && product.configuration.cheeseEnabled !== false;
}

/** A cheese choice sent for an item the website offers none on is refused rather than dropped. */
function cheeseRefusal(product: VoiceCatalogProduct, args: Record<string, unknown>): Outcome | null {
  if (args.cheese === undefined || hasCheeseStep(product)) return null;
  return refuse("CHEESE_NOT_OFFERED", `${product.name} doesn't have a cheese choice.`);
}

/** A line's topping units as the menu counts them: halves are half, chicken counts double. */
function toppingUnitsOf(line: VoiceCartLine): number {
  return line.toppings.reduce((sum, topping) => sum + toppingWeight(topping.toppingId) * (topping.placement === "whole" ? 1 : 0.5), 0);
}

// --- information tools --------------------------------------------------------------------

async function getStoreStatus(context: Context): Promise<Outcome> {
  const settings = await storeSettings(context.now);
  const { ordering, hours, closures, pilot } = settings;
  const cutoff = Number(ordering.lastOrderCutoffMinutes ?? 0);
  const accepting = (fulfilment: Fulfilment) => storeStatus(context.now, hours, TZ, { closures, fulfilment, lastOrderCutoffMinutes: cutoff });
  const pickup = accepting("pickup");
  const delivery = accepting("delivery");
  const doors = storeStatus(context.now, hours, TZ, { closures });
  const on = orderingOn(ordering);
  const pickupNow = on && ordering.pickupEnabled && pickup.open;
  const deliveryNow = on && ordering.deliveryEnabled && delivery.open && pilot.has("delivery");
  const open = isStoreOpenAt(context.now, hours, TZ) && !doors.closure;
  const closure = pickup.closure ?? delivery.closure;
  // Orders for later, exactly as the website takes them while the store is shut.
  const pickupSlots = slotsFor(settings, "pickup", context.now);
  const deliverySlots = slotsFor(settings, "delivery", context.now);
  const data = {
    acceptingOrdersNow: pickupNow || deliveryNow,
    acceptingScheduledOrders: pickupSlots.length > 0 || deliverySlots.length > 0,
    open,
    lastOrdersAt: pickup.acceptingUntil ? clock(pickup.acceptingUntil) : null,
    asapCutoffPassed: open && !pickup.open && !closure,
    closesAt: open && doors.changesAt ? clock(doors.changesAt) : null,
    // "tomorrow at 11:00 AM": en-CA's own "Thursday 11:00 a.m." read as a doubled full stop mid-sentence.
    nextOpenAt: !open && doors.changesAt ? spokenWhen(doors.changesAt, context.now) : null,
    paused: ordering.paused || !ordering.enabled,
    pauseMessage: ordering.paused || !ordering.enabled ? ordering.pauseMessage : null,
    closureMessage: closure ? closureMessage(closure) : null,
    pickup: {
      enabled: ordering.pickupEnabled,
      acceptingNow: pickupNow,
      estimateMinutes: ordering.pickupEstimateMinutes,
      earliestScheduled: pickupSlots.length ? slotView(pickupSlots[0], context.now) : null,
    },
    delivery: {
      enabled: ordering.deliveryEnabled,
      availableByPhone: pilot.has("delivery"),
      acceptingNow: deliveryNow,
      estimateMinutes: ordering.deliveryEstimateMinutes ?? 30,
      earliestScheduled: deliverySlots.length ? slotView(deliverySlots[0], context.now) : null,
    },
    scheduling: { intervalMinutes: SCHEDULE_INTERVAL_MINUTES, latest: pickupSlots.length ? slotView(pickupSlots[pickupSlots.length - 1], context.now) : null },
  };
  const later = pickupSlots.length ? ` I can take a pickup order for later; the earliest time is ${spokenWhen(pickupSlots[0], context.now)}.` : "";
  const say = !on
    ? ordering.pauseMessage
    : pickupNow
      ? `We're taking orders until ${data.lastOrdersAt}. Pickup takes about ${ordering.pickupEstimateMinutes} minutes.${pilot.has("delivery") ? "" : " By phone we can take pickup orders only."}`
      : closure
        ? `${closureMessage(closure)}${later}`
        : open
          ? `Last orders have gone in for tonight.${later}`
          : `We're closed right now${data.nextOpenAt ? `; we open ${data.nextOpenAt}` : ""}.${later}`;
  return { ok: true, data, say };
}

/** "pizza62.ca" from the configured public origin; never an internal hostname. */
function websiteName(base: string | null): string | null {
  if (!base) return null;
  try {
    const host = new URL(base).hostname.replace(/^www\./, "");
    return host === "localhost" || host.endsWith(".azurewebsites.net") ? null : host;
  } catch {
    return null;
  }
}

/** "55 Parkdale Ave N, Hamilton, ON" as a person says it. Display text is kept as stored. */
function spokenAddress(address: string): string {
  const words: Record<string, string> = {
    Ave: "Avenue", St: "Street", Rd: "Road", Blvd: "Boulevard", Dr: "Drive", Hwy: "Highway",
    N: "North", S: "South", E: "East", W: "West", ON: "Ontario",
  };
  return address.replace(/\b(Ave|St|Rd|Blvd|Dr|Hwy|N|S|E|W|ON)\b\.?/g, (word: string) => words[word.replace(".", "")] ?? word);
}

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The restaurant's own facts — where it is, how to reach it, when it is open,
 * how ordering works — read from the same settings the website renders. Nothing
 * here is written into a prompt, so a change in Admin → Settings is the answer
 * the next caller gets.
 */
async function getBusinessInfo(context: Context): Promise<Outcome> {
  const [business, delivery, taxTips, settings, base] = await Promise.all([
    getSetting<{ name?: string; phone?: string; address?: string }>("business"),
    getSetting<{ radiusKm: number; feeCents: number; minimumCents: number }>("delivery"),
    getSetting<{ tippingEnabled?: boolean }>("taxAndTips"),
    storeSettings(context.now),
    publicBaseUrl(),
  ]);
  const { ordering, hours, closures, pilot } = settings;
  const cutoff = Number(ordering.lastOrderCutoffMinutes ?? 0);
  const days = upcomingDays({ now: context.now, hours, closures, lastOrderCutoffMinutes: cutoff, closureMessage: (closure) => closureMessage(closure) });
  const website = websiteName(base);
  const name = business.name ?? "Pizza 62";
  const phone = business.phone ? spokenPhone(business.phone) : null;
  const deliveryByPhone = ordering.deliveryEnabled && pilot.has("delivery");
  const data = {
    name,
    address: business.address ?? null,
    addressSpoken: business.address ? spokenAddress(business.address) : null,
    phone,
    website,
    timeZone: TZ,
    weeklyHours: WEEK_ORDER.map((weekday) => {
      const entry = hours.find((day) => day.weekday === weekday);
      return { day: WEEKDAY[weekday], open: Boolean(entry), opensAt: entry ? minuteLabel(entry.openMinute) : null, closesAt: entry ? minuteLabel(entry.closeMinute) : null };
    }),
    upcomingDays: days,
    pickup: {
      offered: ordering.pickupEnabled,
      byPhone: ordering.pickupEnabled,
      estimateMinutes: ordering.pickupEstimateMinutes,
      payment: ordering.payAtStorePickupEnabled === false
        ? "Pickup orders are paid online on our website."
        : "Pay at the store when you pick up: cash, debit or credit card.",
    },
    delivery: {
      offered: ordering.deliveryEnabled,
      byPhone: deliveryByPhone,
      estimateMinutes: ordering.deliveryEstimateMinutes ?? 30,
      area: "Hamilton, Ontario",
      radiusKm: delivery.radiusKm,
      feeCents: delivery.feeCents,
      minimumCents: delivery.minimumCents,
      payment: deliveryByPhone
        ? "By phone, delivery orders are paid to the driver at the door. On our website they are paid online by card."
        : "Delivery orders are placed and paid online by card on our website.",
    },
    ordering: {
      paused: !orderingOn(ordering),
      pauseMessage: orderingOn(ordering) ? null : ordering.pauseMessage,
      lastOrderCutoffMinutes: cutoff,
      scheduleIntervalMinutes: SCHEDULE_INTERVAL_MINUTES,
      promoCodesByPhone: true,
      giftCardsByPhone: false,
      cardPaymentByPhone: false,
      tipsByPhone: Boolean(taxTips.tippingEnabled),
    },
  };
  const today = days[0];
  const todaySay = !today
    ? ""
    : today.closed || !today.opensAt
      ? today.closureMessage ?? "We're closed today."
      : `Today we're open from ${today.opensAt} to ${today.closesAt}.`;
  const say = [
    data.addressSpoken ? `${name} is at ${data.addressSpoken}.` : null,
    phone ? `Our phone number is ${phone}${website ? ` and our website is ${website}` : ""}.` : website ? `Our website is ${website}.` : null,
    todaySay || null,
  ].filter(Boolean).join(" ");
  return { ok: true, data, say };
}

const CANDIDATE_FIELDS = ["productId", "name", "category", "variationId", "variationName", "sizes", "priceCents", "fulfilments", "available", "unavailableReason", "availabilityLabel", "suggestedQuantity", "detected"] as const;

async function searchMenuTool(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const issues: ToolIssue[] = [];
  const query = readText(args.query, "query", issues, { required: true, max: 200 });
  const fulfilment = readFulfilment(args.fulfilment, issues) ?? context.session.fulfilment;
  const category = args.category === undefined ? null : readId(args.category, "category", issues);
  if (issues.length || !query) return { ok: false, issues, say: "What would you like to order?" };
  const result = resolveMenuQuery(await context.index(), query, { fulfilment, category });
  const candidates = result.candidates.map((candidate) => Object.fromEntries(CANDIDATE_FIELDS.map((field) => [field, candidate[field]])));
  const data = { status: result.status, candidates, clarify: result.clarify, unrecognized: result.unrecognized, ambiguousToppings: result.ambiguousToppings };
  if (result.status === "no_match") {
    return { ok: false, data, issues: [{ code: "NO_MATCH", message: "Nothing on the menu matches that." }], say: "Sorry, we don't have that on our menu." };
  }
  const [first] = result.candidates;
  const say = result.status === "match"
    ? `That's the ${first.variationName && !first.name.includes(first.variationName) ? `${first.variationName} ` : ""}${first.name}, ${formatMoney(first.priceCents)}${first.sizes.length && !first.variationId ? " for the smallest size" : ""}.`
    : result.clarify ?? undefined;
  return { ok: true, data, say };
}

async function getMenuItem(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const issues: ToolIssue[] = [];
  const productId = readId(args.productId, "productId", issues);
  const fulfilment = readFulfilment(args.fulfilment, issues) ?? context.session.fulfilment;
  if (issues.length || !productId) return { ok: false, issues };
  const [catalog, index] = await Promise.all([context.catalog(), context.index()]);
  const product = catalog.products.find((entry) => entry.id === productId);
  const entry = index.products.find((candidate) => candidate.product.id === productId);
  if (!product || !entry) return refuse("PRODUCT_NOT_FOUND", "That isn't on the menu. Use search_menu to find the item.");
  const config = product.configuration;
  const toppingNames = toppingNamesOf(catalog);
  const recipe = config.fixedRecipe && Array.isArray(config.recipeToppingIds) ? (config.recipeToppingIds as unknown[]).map(String) : null;
  const fulfilments = entry.fulfilments;
  const notForFulfilment = fulfilment !== null && !fulfilments.includes(fulfilment);
  const data = {
    productId: product.id,
    name: product.name,
    description: product.description || null,
    category: product.categoryName,
    kind: entry.family,
    fulfilments,
    available: entry.state === "available" && !notForFulfilment,
    unavailableReason: notForFulfilment ? "not_for_fulfilment" : entry.state === "available" ? null : entry.state,
    availabilityLabel: entry.availabilityLabel,
    priceCents: product.basePriceCents,
    sizes: product.variations.map((variation) => ({
      variationId: variation.id,
      name: variation.name,
      priceCents: variation.basePriceCents,
      extraToppingPriceCents: variation.extraToppingPriceCents,
      includedToppings: variation.includedToppingUnitsBps / 10_000,
    })),
    sizeRequired: product.variations.length > 1,
    pizza: product.productType === "pizza"
      ? {
          recipe: recipe ? recipe.map((id) => ({ toppingId: id, name: toppingNames.get(id) ?? id })) : null,
          recipeNote: recipe
            ? "The recipe toppings are included automatically. Put additions in toppings and anything to leave off in omitToppings."
            : null,
          requiresIncludedToppings: Boolean(config.requireIncludedToppings),
          halfToppings: "A topping can be on the whole pizza, the left half or the right half. A half counts as half a topping.",
          chicken: "Real Chicken counts as two toppings.",
          // The website customizer's cheese step, offered where it offers it.
          cheese: hasCheeseStep(product)
            ? {
                options: [...CHEESE_CHOICES],
                default: "regular",
                note: "Send cheese as none, light, regular or extra. Extra cheese is charged as one extra topping at this size's rate; none and light cost nothing.",
              }
            : null,
          toppings: catalog.toppings.map((topping) => ({ toppingId: topping.id, name: topping.name })),
        }
      : null,
    sections: product.sections.map((section) => {
      const prices = sectionOptionPrices(section);
      const values = section.source === "toppings"
        ? catalog.toppings.map((topping) => ({ value: topping.id, name: topping.name, priceCents: 0 }))
        : (entry.options.filter((option) => option.sectionId === section.id).map((option) => option.value))
            .filter((value, position, list) => list.indexOf(value) === position)
            .map((value) => ({ value, name: value, priceCents: prices[value] ?? 0 }));
      return {
        id: section.id,
        label: section.label,
        group: section.group ?? null,
        required: section.min > 0,
        min: section.min,
        max: section.max,
        choosesToppings: section.source === "toppings",
        included: section.included ?? null,
        extraPriceCents: section.extraPriceCents ?? null,
        sharedAllowance: section.sharedGroup ? { group: section.sharedGroup, included: section.sharedIncluded ?? 0 } : null,
        options: values,
      };
    }),
    maxQuantity: Number(config.maxQuantity) || 20,
    notesAllowed: Boolean(config.specialInstructionsEnabled),
  };
  return { ok: true, data };
}

async function getDeals(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const issues: ToolIssue[] = [];
  const fulfilment = readFulfilment(args.fulfilment, issues) ?? context.session.fulfilment;
  if (issues.length) return { ok: false, issues };
  const index = await context.index();
  const deals = index.products
    .filter((entry) => !entry.duplicateOf && entry.state === "available")
    .filter((entry) => entry.family === "bundle" || entry.product.configuration.dailySpecial || entry.product.configuration.featured || entry.product.configuration.availability)
    .filter((entry) => !fulfilment || entry.fulfilments.includes(fulfilment))
    .map((entry) => ({
      productId: entry.product.id,
      name: entry.product.name,
      category: entry.product.categoryName,
      priceCents: entry.product.basePriceCents,
      description: entry.product.description || null,
      fulfilments: entry.fulfilments,
      availabilityLabel: entry.availabilityLabel,
    }));
  const now = context.now;
  const promotions = await getD1()
    .prepare(
      `SELECT name, type, amount, min_subtotal_cents, fulfilment FROM promotions
       WHERE active = 1 AND (code IS NULL OR code = '') AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at >= ?)
         AND (usage_limit IS NULL OR usage_count < usage_limit)
       ORDER BY priority DESC, id`,
    )
    .bind(now, now)
    .all<{ name: string; type: string; amount: number; min_subtotal_cents: number | null; fulfilment: string | null }>();
  const automatic = promotions.results
    .filter((promotion) => !fulfilment || !promotion.fulfilment || promotion.fulfilment === "any" || promotion.fulfilment === fulfilment)
    .map((promotion) => ({
      name: promotion.name,
      description: promotion.type === "percentage"
        ? `${promotion.amount / 100}% off`
        : promotion.type === "fixed"
          ? `${formatMoney(promotion.amount)} off`
          : "free delivery",
      minimumCents: promotion.min_subtotal_cents ?? 0,
    }));
  const say = deals.length
    ? `Today's deals include ${deals.slice(0, 4).map((deal) => `${deal.name} for ${formatMoney(deal.priceCents)}`).join("; ")}.`
    : "We don't have any deals running right now.";
  return { ok: true, data: { fulfilment, deals, automaticPromotions: automatic }, say };
}

async function getCart(context: Context): Promise<Outcome> {
  const catalog = await context.catalog();
  return { ok: true, data: cartView(context.session, await priceCart(context.session, catalog), catalog, context.now) };
}

// --- building the order ---------------------------------------------------------------------

async function startOrder(context: Context, args: Record<string, unknown>, reset: boolean): Promise<Outcome> {
  const issues: ToolIssue[] = [];
  const fulfilment = reset ? context.session.fulfilment : readFulfilment(args.fulfilment, issues);
  if (issues.length) return { ok: false, issues };
  if (fulfilment === "delivery" && !(await deliveryAllowed())) {
    return refuse("VOICE_DELIVERY_UNAVAILABLE", "By phone we can take pickup orders only. Delivery orders can be placed on our website.");
  }
  if (context.session.stage === "placed") return refuse("ORDER_ALREADY_PLACED", "This order has already been placed. Changes to it go to the restaurant staff.");
  const result = await startDraft(context.session, { fulfilment, keepSchedule: reset, now: context.now });
  if (!result.ok) return failedTransition(result);
  return {
    ok: true,
    session: result.session,
    data: { cartVersion: result.session.cartVersion, stage: result.session.stage, fulfilment: result.session.fulfilment },
    say: reset ? "Okay, starting the order over." : undefined,
  };
}

/** Checks a candidate line against the product and its size, before pricing. */
function resolveVariation(product: VoiceCatalogProduct, requested: string | null | undefined): { variationId: string | null; issue?: ToolIssue } {
  if (requested) {
    return product.variations.some((variation) => variation.id === requested)
      ? { variationId: requested }
      : { variationId: null, issue: { code: "INVALID_SIZE", message: `That size isn't one of ${product.name}'s: ${product.variations.map((variation) => variation.name).join(", ")}.` } };
  }
  if (product.variations.length === 1) return { variationId: product.variations[0].id };
  if (product.variations.length > 1) {
    return { variationId: null, issue: { code: "SIZE_REQUIRED", message: `Which size: ${product.variations.map((variation) => variation.name).join(", ")}?` } };
  }
  return { variationId: null };
}

/**
 * Prices `candidate` with `targetIndex` as the changed line. Refuses when that
 * line, or the cart as a whole, would not validate; otherwise returns the
 * pricing so the change can be committed.
 */
async function validateCandidate(context: Context, catalog: VoiceCatalog, candidate: VoiceCartLine[], targetIndex: number | null): Promise<{ priced: Priced } | { outcome: Outcome }> {
  const priced = await priceCart(context.session, catalog, candidate);
  const issues = priced.quote?.issues ?? [];
  // The changed line's own problems block it. So does a problem with the items
  // together (a per-order cap) when no line is singled out. Problems with the
  // order as a whole — the store is closed, the minimum is not met yet — do
  // not: they are reported, and review_order will not pass until they clear.
  const own = issues.filter((issue) => targetIndex !== null && issue.index === targetIndex);
  const together = priced.itemsValid || issues.some((issue) => issue.index !== null) ? [] : issues.filter((issue) => issue.index === null).slice(0, 1);
  const blocking = own.length ? own : together;
  if (blocking.length) {
    const issues = blocking.map((issue) => ({ code: issue.code, message: issue.message, lineId: targetIndex !== null ? candidate[targetIndex]?.lineId ?? null : null }));
    return { outcome: { ok: false, issues, say: issues[0].message } };
  }
  return { priced };
}

async function commitCart(context: Context, catalog: VoiceCatalog, change: DraftChange, version: number | undefined, extra: Record<string, unknown> = {}, say?: string): Promise<Outcome> {
  const result = await applyDraftChange(context.session, change, { expectedVersion: version, now: context.now });
  if (!result.ok) return failedTransition(result);
  const priced = await priceCart(result.session, catalog);
  const view = cartView(result.session, priced, catalog, context.now);
  return { ok: true, session: result.session, data: { ...extra, ...view }, say: say ?? (view.totals ? `Your total so far is ${view.totals.spokenTotal}.` : undefined) };
}

async function addItem(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const blocked = editable(context.session);
  if (blocked) return blocked;
  if (!context.session.fulfilment) return refuse("FULFILMENT_REQUIRED", "Ask whether the order is for pickup or delivery, then call set_fulfilment.");
  const issues: ToolIssue[] = [];
  const version = expectedVersion(args, issues);
  const choices = readLineChoices(args, issues);
  if (!choices.productId && !issues.length) issues.push({ code: "INVALID_INPUT", field: "productId", message: "productId is required." });
  if (issues.length) return { ok: false, issues, say: issues[0].message };
  const [catalog, index] = await Promise.all([context.catalog(), context.index()]);
  const product = catalogProduct(catalog, index, choices.productId!);
  if (!product) return refuse("PRODUCT_NOT_FOUND", "That isn't on the menu. Use search_menu to find the item.");
  const variation = resolveVariation(product, choices.variationId);
  if (variation.issue) return { ok: false, issues: [variation.issue], say: variation.issue.message };
  const noCheese = cheeseRefusal(product, args);
  if (noCheese) return noCheese;
  const line: VoiceCartLine = {
    lineId: `L${context.session.nextLineNumber}`,
    productId: product.id,
    variationId: variation.variationId,
    quantity: choices.quantity ?? 1,
    toppings: choices.toppings ?? [],
    omitToppings: choices.omitToppings ?? [],
    extraCheese: choices.extraCheese ?? false,
    cheese: choices.cheese ?? null,
    modifiers: choices.modifiers ?? [],
    notes: choices.notes ?? null,
  };
  const candidate = [...context.session.cart, line];
  const checked = await validateCandidate(context, catalog, candidate, candidate.length - 1);
  if ("outcome" in checked) return checked.outcome;
  return commitCart(context, catalog, { cart: candidate, nextLineNumber: context.session.nextLineNumber + 1 }, version, { lineId: line.lineId }, `Added. Your total so far is ${formatMoney(checked.priced.quote?.totals.amountDueCents ?? 0)}.`);
}

async function updateItem(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const blocked = editable(context.session);
  if (blocked) return blocked;
  const issues: ToolIssue[] = [];
  const version = expectedVersion(args, issues);
  const lineId = readText(args.lineId, "lineId", issues, { required: true, max: 20 });
  const choices = readLineChoices(args, issues);
  if (issues.length || !lineId) return { ok: false, issues, say: issues[0]?.message };
  const position = context.session.cart.findIndex((line) => line.lineId === lineId);
  if (position < 0) return refuse("LINE_NOT_FOUND", `There is no line ${lineId} in this order. Use get_cart to see the lines.`);
  const [catalog, index] = await Promise.all([context.catalog(), context.index()]);
  const current = context.session.cart[position];
  const productChanged = choices.productId !== undefined && choices.productId !== current.productId;
  const product = catalogProduct(catalog, index, choices.productId ?? current.productId);
  if (!product) return refuse("PRODUCT_NOT_FOUND", "That isn't on the menu. Use search_menu to find the item.");
  const variation = resolveVariation(product, choices.variationId !== undefined ? choices.variationId : productChanged ? null : current.variationId);
  if (variation.issue) return { ok: false, issues: [{ ...variation.issue, lineId }], say: variation.issue.message };
  const noCheese = cheeseRefusal(product, args);
  if (noCheese) return noCheese;
  const updated: VoiceCartLine = {
    ...current,
    productId: product.id,
    variationId: variation.variationId,
    quantity: choices.quantity ?? current.quantity,
    toppings: choices.toppings ?? current.toppings,
    omitToppings: choices.omitToppings ?? (productChanged ? [] : current.omitToppings),
    extraCheese: choices.extraCheese ?? current.extraCheese,
    // A product without the cheese step cannot keep a light/no-cheese choice from the one before.
    cheese: choices.cheese !== undefined ? choices.cheese : hasCheeseStep(product) ? current.cheese ?? null : null,
    modifiers: choices.modifiers ?? current.modifiers,
    notes: choices.notes !== undefined ? choices.notes : current.notes,
  };
  const candidate = context.session.cart.map((line, at) => (at === position ? updated : line));
  const checked = await validateCandidate(context, catalog, candidate, position);
  if ("outcome" in checked) return checked.outcome;
  return commitCart(context, catalog, { cart: candidate }, version, { lineId }, `Changed. Your total is now ${formatMoney(checked.priced.quote?.totals.amountDueCents ?? 0)}.`);
}

async function removeItem(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const blocked = editable(context.session);
  if (blocked) return blocked;
  const issues: ToolIssue[] = [];
  const version = expectedVersion(args, issues);
  const lineId = readText(args.lineId, "lineId", issues, { required: true, max: 20 });
  if (issues.length || !lineId) return { ok: false, issues };
  if (!context.session.cart.some((line) => line.lineId === lineId)) {
    return refuse("LINE_NOT_FOUND", `There is no line ${lineId} in this order. Use get_cart to see the lines.`);
  }
  const catalog = await context.catalog();
  return commitCart(context, catalog, { cart: context.session.cart.filter((line) => line.lineId !== lineId) }, version, { removedLineId: lineId }, "Removed.");
}

/**
 * Pickup ↔ delivery. A line whose product is sold for the new fulfilment
 * stays as it is. A build-your-own pizza moves to its exact equivalent for the
 * other fulfilment (same size, same toppings) only when exactly one exists.
 * Anything else blocks the change: the caller chooses, the server does not.
 */
async function setFulfilment(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const blocked = editable(context.session);
  if (blocked) return blocked;
  const issues: ToolIssue[] = [];
  const version = expectedVersion(args, issues);
  const fulfilment = readFulfilment(args.fulfilment, issues, true);
  if (issues.length || !fulfilment) return { ok: false, issues };
  if (fulfilment === "delivery" && !(await deliveryAllowed())) {
    return refuse("VOICE_DELIVERY_UNAVAILABLE", "By phone we can take pickup orders only. Delivery orders can be placed on our website.");
  }
  const [catalog, index] = await Promise.all([context.catalog(), context.index()]);
  const remapped: Array<{ lineId: string; from: string; to: string }> = [];
  const stuck: Array<{ lineId: string; productId: string; name: string; message: string }> = [];
  const cart = context.session.cart.map((line) => {
    const entry = index.products.find((candidate) => candidate.product.id === line.productId);
    if (entry?.fulfilments.includes(fulfilment)) return line;
    const duplicate = entry ? index.products.find((candidate) => candidate.product.id !== entry.product.id && candidate.fulfilments.includes(fulfilment) && (candidate.product.id === entry.duplicateOf || candidate.duplicateOf === entry.product.id)) : null;
    const target = duplicate?.product.id ?? equivalentPizzaFor(index, line.productId, fulfilment, toppingUnitsOf(line));
    const targetProduct = target ? catalog.products.find((product) => product.id === target) : null;
    if (targetProduct && targetProduct.variations.length <= 1) {
      remapped.push({ lineId: line.lineId, from: line.productId, to: targetProduct.id });
      return { ...line, productId: targetProduct.id, variationId: targetProduct.variations[0]?.id ?? null };
    }
    const name = entry?.product.name ?? line.productId;
    stuck.push({ lineId: line.lineId, productId: line.productId, name, message: `${name} is not available for ${fulfilment}, and there is no exact equivalent. Ask the caller what they would like instead.` });
    return line;
  });
  if (stuck.length) {
    return {
      ok: false,
      issues: stuck.map((line) => ({ code: "NEEDS_CLARIFICATION", message: line.message, lineId: line.lineId })),
      data: { blocked: stuck },
      say: stuck[0].message,
    };
  }
  if (cart.length) {
    const checked = await validateCandidate({ ...context, session: { ...context.session, fulfilment } }, catalog, cart, null);
    if ("outcome" in checked) return checked.outcome;
  }
  return commitCart(context, catalog, { cart, fulfilment }, version, { remapped }, fulfilment === "delivery" ? "Okay, delivery. What's the address?" : "Okay, pickup.");
}

async function setCustomer(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const blocked = editable(context.session);
  if (blocked) return blocked;
  const issues: ToolIssue[] = [];
  const version = expectedVersion(args, issues);
  const name = readText(args.name, "name", issues, { required: true, max: 100 });
  const spoken = readText(args.phone, "phone", issues, { max: 30 });
  if (args.useCallerId !== undefined && typeof args.useCallerId !== "boolean") {
    issues.push({ code: "INVALID_INPUT", field: "useCallerId", message: "useCallerId must be true or false." });
  }
  if (name && name.length < 2) issues.push({ code: "INVALID_INPUT", field: "name", message: "A name needs at least two letters." });
  if (issues.length || !name) return { ok: false, issues, say: issues[0]?.message };
  let phone = spoken?.replace(/[^0-9+]/g, "") ?? "";
  let source: "spoken" | "caller_id" = "spoken";
  // Caller ID is a convenience, never an identity: it is offered only when the
  // carrier presented a number, and it is read back for the caller to confirm.
  if (!phone && args.useCallerId === true && context.session.callerIdStatus === "presented" && context.session.callerPhone) {
    phone = context.session.callerPhone.replace(/[^0-9+]/g, "");
    source = "caller_id";
  }
  if (!phone) return refuse("PHONE_REQUIRED", "What's the best phone number to reach you?");
  if (phone.replace(/\D/g, "").length < 10 || phone.length > 16) return refuse("INVALID_PHONE", "That phone number doesn't look right. Could you say it again?");
  const catalog = await context.catalog();
  return commitCart(context, catalog, { customer: { name, phone, phoneSource: source } }, version, { customerPhoneToConfirm: spokenPhone(phone), phoneSource: source },
    `I have ${name} at ${spokenPhone(phone)}${source === "caller_id" ? " — is that the best number to reach you?" : "."}`);
}

async function checkDeliveryAddress(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const issues: ToolIssue[] = [];
  const line1 = readText(args.line1, "line1", issues, { required: true, max: 160 });
  const unit = readText(args.unit, "unit", issues, { max: 40 });
  const city = readText(args.city, "city", issues, { max: 80 }) ?? "Hamilton";
  const province = readText(args.province, "province", issues, { max: 2 }) ?? "ON";
  const postalCode = readText(args.postalCode, "postalCode", issues, { required: true, max: 10 });
  const instructions = readText(args.instructions, "instructions", issues, { max: 200 });
  if (issues.length || !line1 || !postalCode) return { ok: false, issues, say: "What's the street address and postal code?" };
  const catalog = await context.catalog();
  // The minimum and the fee come from the cart as the server prices it — never from the request.
  const check = await checkCartDeliveryEligibility(
    {
      items: toOrderRequest(context.session, recipeLookup(catalog)).items,
      address: { line1, unit: unit ?? "", city, province, postalCode },
    },
    await aiContext(context.session),
  );
  const byPhone = await deliveryAllowed();
  const data = {
    addressDeliverable: check.addressDeliverable,
    eligible: check.eligible,
    reason: check.reason,
    message: check.message,
    address: check.address ? addressLine(check.address) : null,
    feeCents: check.feeCents,
    minimumCents: check.minimumCents,
    shortfallCents: check.shortfallCents,
    deliveryAvailableByPhone: byPhone,
  };
  const say = !check.addressDeliverable
    ? check.reason === "invalid_address" || check.reason === "address_unverified"
      ? "I couldn't find that address. Could you repeat the street and postal code?"
      : check.message ?? "We don't deliver to that address."
    : !byPhone
      ? "We do deliver there, but by phone we can take pickup orders only. You can order delivery on our website."
      : check.eligible
        ? `Yes, we deliver there. The delivery fee is ${formatMoney(check.feeCents)}.`
        : `Yes, we deliver there. Delivery orders need ${formatMoney(check.minimumCents)} of food before tax — another ${formatMoney(check.shortfallCents)}.`;
  // The address becomes the order's only when the order is a delivery and the address is one we serve.
  const storable = check.addressDeliverable && check.address && context.session.fulfilment === "delivery" && byPhone && !editable(context.session);
  if (!storable) return { ok: check.addressDeliverable, data, say, ...(check.addressDeliverable ? {} : { issues: [{ code: "DELIVERY_ADDRESS_INELIGIBLE", message: say }] }) };
  const stored = await applyDraftChange(context.session, {
    deliveryAddress: { ...check.address!, ...(instructions ? { instructions } : {}) },
    deliveryCheck: {
      cartVersion: context.session.cartVersion + 1,
      addressDeliverable: check.addressDeliverable,
      eligible: check.eligible,
      reason: check.reason,
      feeCents: check.feeCents,
      minimumCents: check.minimumCents,
      shortfallCents: check.shortfallCents,
      checkedAt: context.now,
    },
  }, { now: context.now });
  if (!stored.ok) return failedTransition(stored);
  return { ok: true, session: stored.session, data: { ...data, stored: true, cartVersion: stored.session.cartVersion }, say };
}

// --- when, promo code, tip ------------------------------------------------------------------

/** The sentence for a time that is not one of the slots, with the nearest that are. */
function slotRefusal(resolution: Extract<SlotResolution, { ok: false }>, fulfilment: Fulfilment, now: number): Outcome {
  const kind = fulfilment === "delivery" ? "delivery" : "pickup";
  const options = resolution.suggestions.map((slot) => spokenWhen(slot, now));
  const earliest = options[0] ? ` The earliest ${kind} time is ${options[0]}.` : "";
  const day = resolution.date ? dayLabel(resolution.date, now) : null;
  const message = {
    invalid_day: "Which day would you like it: today, tomorrow, or a day of the week?",
    invalid_time: "What time would you like it?",
    past: `That time has already passed.${earliest}`,
    too_soon: `That's sooner than we can have a ${kind} order ready.${earliest}`,
    beyond_horizon: `We can't schedule that far ahead yet.${options[0] ? ` The latest ${kind} time we can book right now is ${options[0]}.` : ""}`,
    closure: `${resolution.closure ? closureMessage(resolution.closure) : "We're closed then."}${options.length ? ` Would ${options.join(" or ")} work?` : ""}`,
    closed_that_day: `We're closed ${day ?? "that day"}.${options[0] ? ` The next ${kind} time is ${options[0]}.` : ""}`,
    outside_hours: day && resolution.suggestions.length === 2 && resolution.suggestions.every((slot) => localDate(slot) === resolution.date)
      ? `${day[0].toUpperCase()}${day.slice(1)} we take ${kind} orders from ${clockLabel(resolution.suggestions[0])} to ${clockLabel(resolution.suggestions[1])}.`
      : `We're not open then.${earliest}`,
    off_grid: `We schedule orders in ${SCHEDULE_INTERVAL_MINUTES}-minute steps.${options.length ? ` Would ${options.join(" or ")} work?` : ""}`,
  }[resolution.reason];
  const code = resolution.reason === "invalid_day" || resolution.reason === "invalid_time" ? "INVALID_INPUT" : "TIME_UNAVAILABLE";
  return {
    ok: false,
    soft: true,
    issues: [{ code, message, ...(code === "INVALID_INPUT" ? { field: resolution.reason === "invalid_day" ? "day" : "time" } : {}) }],
    data: { reason: resolution.reason, suggestions: resolution.suggestions.map((slot) => slotView(slot, now)) },
    say: message,
  };
}

/**
 * When the order can be for, without changing anything.
 *
 * ASAP when the store is taking orders now; otherwise, and always for later,
 * the slots the website's checkout would offer for this fulfilment.
 */
async function getOrderSlots(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const issues: ToolIssue[] = [];
  const fulfilment = readFulfilment(args.fulfilment, issues) ?? context.session.fulfilment ?? "pickup";
  const dayText = readText(args.day, "day", issues, { max: 40 });
  if (issues.length) return { ok: false, issues, say: issues[0].message };
  const settings = await storeSettings(context.now);
  if (fulfilment === "delivery" && !settings.pilot.has("delivery")) {
    return refuse("VOICE_DELIVERY_UNAVAILABLE", "By phone we can take pickup orders only. Delivery orders can be placed on our website.");
  }
  if (!orderingOn(settings.ordering)) return refuse("ORDERING_PAUSED", settings.ordering.pauseMessage);
  const date = dayText ? parseDay(dayText, context.now) : null;
  if (dayText && !date) {
    return { ok: false, soft: true, issues: [{ code: "INVALID_INPUT", field: "day", message: "Which day would you like it: today, tomorrow, or a day of the week?" }], say: "Which day would you like it: today, tomorrow, or a day of the week?" };
  }
  const slots = slotsFor(settings, fulfilment, context.now);
  const asap = asapAvailable(settings, fulfilment, context.now);
  const lead = leadMinutes(settings.ordering, fulfilment);
  const byDay = new Map<string, number[]>();
  for (const slot of slots) byDay.set(localDate(slot), [...(byDay.get(localDate(slot)) ?? []), slot]);
  const days = [...byDay].map(([day, list]) => ({ date: day, label: dayLabel(day, context.now), first: clockLabel(list[0]), last: clockLabel(list[list.length - 1]), count: list.length }));
  const daySlots = date ? byDay.get(date) ?? [] : [];
  const kind = fulfilment === "delivery" ? "delivery" : "pickup";
  const label = date ? dayLabel(date, context.now) : null;
  const say = date
    ? daySlots.length
      ? `${label![0].toUpperCase()}${label!.slice(1)} we can take a ${kind} order for any time from ${clockLabel(daySlots[0])} to ${clockLabel(daySlots[daySlots.length - 1])}, in ${SCHEDULE_INTERVAL_MINUTES}-minute steps.`
      : `We can't take ${kind} orders for ${label}.${slots[0] ? ` The earliest ${kind} time is ${spokenWhen(slots[0], context.now)}.` : ""}`
    : asap
      ? `We can have it as soon as possible, in about ${lead} minutes, or schedule it for a time later${slots.length ? `, up to ${spokenWhen(slots[slots.length - 1], context.now)}` : ""}.`
      : slots[0]
        ? `We're not taking orders for right now. The earliest ${kind} time is ${spokenWhen(slots[0], context.now)}.`
        : "We can't take orders for later right now.";
  return {
    ok: true,
    data: {
      fulfilment,
      asapAvailable: asap,
      asapEstimateMinutes: lead,
      earliest: slots[0] !== undefined ? slotView(slots[0], context.now) : null,
      day: date ? { date, label, times: daySlots.map((slot) => clockLabel(slot)) } : null,
      days,
      intervalMinutes: SCHEDULE_INTERVAL_MINUTES,
      latest: slots.length ? slotView(slots[slots.length - 1], context.now) : null,
    },
    say,
  };
}

/**
 * When the order is for: as soon as possible, or a time the caller named.
 *
 * The model sends a day and a clock time in words; the server matches them to
 * one of the website's slots and stores that slot's own timestamp. Anything
 * else is refused with the nearest times that exist. A change moves the
 * version, so a read-back given for another time can never be confirmed.
 */
async function setSchedule(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const blocked = editable(context.session);
  if (blocked) return blocked;
  const fulfilment = context.session.fulfilment;
  if (!fulfilment) return refuse("FULFILMENT_REQUIRED", "Is the order for pickup or delivery? The times depend on it.");
  const issues: ToolIssue[] = [];
  const version = expectedVersion(args, issues);
  const when = args.when;
  if (when !== "asap" && when !== "scheduled") issues.push({ code: "INVALID_INPUT", field: "when", message: "when must be asap or scheduled." });
  const day = readText(args.day, "day", issues, { max: 40 });
  const time = readText(args.time, "time", issues, { max: 20 });
  if (when === "scheduled" && (!day || !time) && !issues.length) {
    issues.push({ code: "INVALID_INPUT", field: day ? "time" : "day", message: day ? "What time would you like it?" : "Which day would you like it?" });
  }
  if (issues.length) return { ok: false, issues, say: issues[0].message };
  const settings = await storeSettings(context.now);
  if (!orderingOn(settings.ordering)) return refuse("ORDERING_PAUSED", settings.ordering.pauseMessage);
  const kind = fulfilment === "delivery" ? "delivery" : "pickup";
  let schedule: VoiceOrderOptions["schedule"];
  if (when === "asap") {
    if (!asapAvailable(settings, fulfilment, context.now)) {
      const earliest = slotsFor(settings, fulfilment, context.now)[0];
      const message = `We're not taking ${kind} orders for right now.${earliest !== undefined ? ` The earliest time is ${spokenWhen(earliest, context.now)}.` : ""}`;
      return { ok: false, soft: true, issues: [{ code: "ASAP_UNAVAILABLE", message }], data: { suggestions: earliest !== undefined ? [slotView(earliest, context.now)] : [] }, say: message };
    }
    schedule = { type: "asap" };
  } else {
    const resolution = resolveSlot(day!, time!, {
      now: context.now,
      hours: settings.hours,
      closures: settings.closures,
      fulfilment,
      leadMinutes: leadMinutes(settings.ordering, fulfilment),
    });
    if (!resolution.ok) return slotRefusal(resolution, fulfilment, context.now);
    schedule = { type: "scheduled", scheduledFor: resolution.slot };
  }
  const catalog = await context.catalog();
  const say = schedule.type === "asap"
    ? `Okay, as soon as possible: about ${leadMinutes(settings.ordering, fulfilment)} minutes.`
    : `Okay, ${kind} ${spokenWhen(schedule.scheduledFor, context.now)}.`;
  return commitCart(context, catalog, { options: { ...context.session.orderOptions, schedule } }, version, {}, say);
}

/** A promo code needs something to be priced against, exactly as the website's checkout does. */
function needsCart(session: VoiceSession, what: string): Outcome | null {
  if (!session.fulfilment) return refuse("FULFILMENT_REQUIRED", "Ask whether the order is for pickup or delivery, then call set_fulfilment.");
  if (!session.cart.length) return refuse("CART_EMPTY", `Let's add something to the order first, then I can add the ${what}.`);
  return null;
}

/**
 * A promo code the caller has. Only the code comes from the call: whether it
 * is real, live, for this fulfilment, and what it takes off, is decided by the
 * same `quoteOrder` the website's promo box uses. A code that is not one we
 * honour is never stored, because `createOrder` would refuse the order.
 */
async function applyCoupon(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const blocked = editable(context.session) ?? needsCart(context.session, "promo code");
  if (blocked) return blocked;
  const issues: ToolIssue[] = [];
  const version = expectedVersion(args, issues);
  const code = readText(args.code, "code", issues, { required: true, max: 40 });
  if (issues.length || !code) return { ok: false, issues, say: issues[0]?.message ?? "What's the promo code?" };
  const catalog = await context.catalog();
  const candidate: VoiceOrderOptions = { ...context.session.orderOptions, couponCode: code };
  let priced: Priced;
  try {
    priced = await priceCart(context.session, catalog, context.session.cart, candidate);
  } catch (error) {
    if (error instanceof OrderValidationError) return refuse(error.code, error.message);
    throw error;
  }
  const coupon = priced.quote?.coupon;
  if (!coupon || coupon.status === "invalid") {
    return refuse("PROMO_CODE_INVALID", coupon?.message ?? "That promo code isn't valid right now.");
  }
  const total = formatMoney(priced.quote!.totals.amountDueCents);
  const say = coupon.status === "applied"
    ? `${coupon.code} is applied. Your total is now ${total}.`
    : `${coupon.message ?? `${coupon.code} doesn't apply to this order.`} Your total is ${total}.`;
  return commitCart(context, catalog, { options: { ...candidate, couponCode: coupon.code } }, version, { coupon: { code: coupon.code, status: coupon.status, message: coupon.message } }, say);
}

async function removeCoupon(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const blocked = editable(context.session);
  if (blocked) return blocked;
  const issues: ToolIssue[] = [];
  const version = expectedVersion(args, issues);
  if (issues.length) return { ok: false, issues };
  if (!context.session.orderOptions.couponCode) return { ok: true, data: { removed: false }, say: "There's no promo code on the order." };
  const catalog = await context.catalog();
  const priced = await priceCart(context.session, catalog, context.session.cart, { ...context.session.orderOptions, couponCode: null });
  const total = priced.quote ? ` Your total is ${formatMoney(priced.quote.totals.amountDueCents)}.` : "";
  return commitCart(context, catalog, { options: { ...context.session.orderOptions, couponCode: null } }, version, { removed: true }, `I've taken the promo code off.${total}`);
}

/** Dollars as a caller says them ("5", "5.50", "$5") to cents; null when it is not an amount. */
function dollarsToCents(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().replace(/^\$\s*/, "") : "";
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * A tip the caller offers. The website's checkout offers none, its preset
 * percentages, or a dollar amount; so does this. The server works out what a
 * percentage comes to and enforces the same ceiling a custom tip has online.
 */
async function setTip(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const blocked = editable(context.session) ?? needsCart(context.session, "tip");
  if (blocked) return blocked;
  const issues: ToolIssue[] = [];
  const version = expectedVersion(args, issues);
  const type = args.type;
  if (type !== "none" && type !== "percentage" && type !== "custom") issues.push({ code: "INVALID_INPUT", field: "type", message: "type must be none, percentage or custom." });
  if (issues.length) return { ok: false, issues, say: issues[0].message };
  const taxTips = await getSetting<{ tippingEnabled?: boolean; tipPresetBps?: number[]; customTipEnabled?: boolean }>("taxAndTips");
  let tip: VoiceOrderOptions["tip"] = { type: "none" };
  if (type !== "none") {
    if (!taxTips.tippingEnabled) return { ...refuse("TIPS_UNAVAILABLE", "We aren't taking tips on orders right now."), soft: true };
    const presets = (taxTips.tipPresetBps ?? []).filter((bps) => Number.isSafeInteger(bps) && bps > 0);
    const offered = `${presets.map((bps) => bps / 100).join(", ")} percent${taxTips.customTipEnabled ? ", or a dollar amount" : ""}`;
    if (type === "percentage") {
      const percent = Number(args.percent);
      if (!Number.isSafeInteger(percent) || !presets.includes(percent * 100)) {
        return { ...refuse("TIP_NOT_OFFERED", `I can add a tip of ${offered}.`), soft: true };
      }
      tip = { type: "percentage", valueBps: percent * 100 };
    } else {
      if (!taxTips.customTipEnabled) return { ...refuse("TIP_NOT_OFFERED", `I can add a tip of ${offered}.`), soft: true };
      const cents = dollarsToCents(args.amount);
      if (cents === null || cents <= 0) return refuse("INVALID_INPUT", "How much would you like to tip, in dollars?", { issues: [{ code: "INVALID_INPUT", field: "amount", message: "amount must be a dollar amount such as 5 or 5.50." }] });
      tip = { type: "custom", amountCents: cents };
    }
  }
  const catalog = await context.catalog();
  const candidate: VoiceOrderOptions = { ...context.session.orderOptions, tip };
  const priced = await priceCart(context.session, catalog, context.session.cart, candidate);
  const tipIssue = priced.quote?.issues.find((issue) => issue.code === "TIP_INVALID");
  if (tipIssue) return { ...refuse("TIP_INVALID", "That tip is more than we can add to this order."), soft: true };
  const totals = priced.quote!.totals;
  const say = tip.type === "none"
    ? `Okay, no tip. Your total is ${formatMoney(totals.amountDueCents)}.`
    : `Added a ${formatMoney(totals.tipCents)} tip. Your total is now ${formatMoney(totals.amountDueCents)}.`;
  return commitCart(context, catalog, { options: candidate }, version, {}, say);
}

// --- review, confirm, place --------------------------------------------------------------------

async function reviewOrder(context: Context): Promise<Outcome> {
  const blocked = editable(context.session);
  if (blocked) return blocked;
  const { session } = context;
  const issues: ToolIssue[] = [];
  if (!session.cart.length) issues.push({ code: "CART_EMPTY", message: "There is nothing in the order yet." });
  if (!session.fulfilment) issues.push({ code: "FULFILMENT_REQUIRED", message: "Ask whether the order is for pickup or delivery." });
  if (!session.customerName || !session.customerPhone) issues.push({ code: "CUSTOMER_REQUIRED", message: "Get the caller's name and phone number with set_customer." });
  if (session.fulfilment === "delivery" && !(await deliveryAllowed())) issues.push({ code: "VOICE_DELIVERY_UNAVAILABLE", message: "By phone we can take pickup orders only." });
  if (session.fulfilment === "delivery" && !session.deliveryAddress) issues.push({ code: "ADDRESS_REQUIRED", message: "Get the delivery address with check_delivery_address." });
  if (issues.length) return { ok: false, issues, say: issues[0].message };
  const catalog = await context.catalog();
  if (session.fulfilment === "delivery") {
    const check = await checkCartDeliveryEligibility(
      { items: toOrderRequest(session, recipeLookup(catalog)).items, address: session.deliveryAddress! },
      await aiContext(session),
    );
    if (!check.eligible) issues.push({ code: "DELIVERY_ADDRESS_INELIGIBLE", message: check.message ?? "That address can't be delivered to." });
  }
  // The time, judged against the slots the website would offer now. Said in
  // the caller's terms first, ahead of the engine's own refusal of the same.
  const settings = await storeSettings(context.now);
  const fulfilment = session.fulfilment!;
  if (orderingOn(settings.ordering) && fulfilmentOn(settings, fulfilment)) {
    const slots = slotsFor(settings, fulfilment, context.now);
    const earliest = slots[0] !== undefined ? ` The earliest time is ${spokenWhen(slots[0], context.now)}.` : "";
    const { schedule } = session.orderOptions;
    if (schedule.type === "asap" && !asapAvailable(settings, fulfilment, context.now)) {
      issues.push({ code: "SCHEDULE_REQUIRED", message: `We're not taking orders for right now, so this order needs a time.${earliest} What time would you like it?` });
    } else if (schedule.type === "scheduled" && !slots.includes(schedule.scheduledFor)) {
      const chosen = spokenWhen(schedule.scheduledFor, context.now);
      issues.push({ code: "TIME_UNAVAILABLE", message: `${chosen[0].toUpperCase()}${chosen.slice(1)} is no longer available.${earliest}` });
    }
  }
  const priced = await priceCart(session, catalog);
  issues.push(...quoteIssues(priced.quote, session.cart));
  // A code that is not one we honour makes `createOrder` refuse the order, though the quote prices around it.
  if (priced.quote?.coupon?.status === "invalid") {
    issues.push({ code: "PROMO_CODE_INVALID", message: `${priced.quote.coupon.message ?? "That promo code isn't valid right now."} I'll take it off unless you have another.` });
  }
  if (issues.length) return { ok: false, issues, say: issues[0].message };
  const amountDue = priced.quote!.totals.amountDueCents;
  if (amountDue > (await voiceMaxOrderCents())) {
    return refuse("ORDER_TOO_LARGE", "An order this size is best taken by our staff. Let me connect you.", { escalate: true, escalationReason: "order_too_large" });
  }
  const reviewed = await recordReview(session, amountDue, { now: context.now });
  if (!reviewed.ok) return failedTransition(reviewed);
  const readback = buildReadback({
    fulfilment: session.fulfilment!,
    cart: session.cart,
    quote: priced.quote!,
    items: priced.items,
    toppingNames: toppingNamesOf(catalog),
    deliveryAddress: session.deliveryAddress,
    options: session.orderOptions,
    now: context.now,
  });
  return {
    ok: true,
    session: reviewed.session,
    data: {
      cartVersion: reviewed.session.cartVersion,
      readback: readback.text,
      lines: readback.lines,
      deliveryAddress: readback.deliveryAddress,
      deliveryInstructions: readback.deliveryInstructions,
      totals: readback.totals,
      promotions: readback.promotions,
      coupon: readback.coupon,
      tip: session.orderOptions.tip,
      payment: readback.payment,
      estimate: readback.estimate,
      customer: { name: session.customerName, phone: spokenPhone(session.customerPhone ?? "") },
      amountDueCents: amountDue,
    },
    say: readback.text,
  };
}

async function confirmOrder(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const issues: ToolIssue[] = [];
  const version = Number(args.cartVersion);
  if (!Number.isSafeInteger(version)) issues.push({ code: "INVALID_INPUT", field: "cartVersion", message: "cartVersion must be the cartVersion review_order returned." });
  const utterance = readText(args.utterance, "utterance", issues, { max: 300 });
  if (issues.length) return { ok: false, issues };
  const { session } = context;
  if (session.stage === "placed") return refuse("ORDER_ALREADY_PLACED", "This order has already been placed.");
  if (session.stage !== "review" && session.stage !== "confirmed") return refuse("NOT_REVIEWED", "Read the order back with review_order before confirming.");
  if (version !== session.cartVersion || session.reviewedVersion !== session.cartVersion) {
    return refuse("CART_CHANGED", "The order changed after it was read back. Read it back again with review_order.");
  }
  const confirmed = await recordConfirmation(session, version, utterance ? redactText(utterance) : null, { now: context.now });
  if (!confirmed.ok) return refuse("CART_CHANGED", "The order changed after it was read back. Read it back again with review_order.");
  return { ok: true, session: confirmed.session, data: { cartVersion: version, confirmedAmountCents: confirmed.session.confirmedAmountCents }, say: "Great, placing your order now." };
}

async function placedResult(orderId: string, duplicate: boolean, fulfilment: Fulfilment | null, now: number): Promise<Outcome> {
  const order = await getD1()
    .prepare("SELECT order_number, estimated_for, schedule_type, total_cents, gift_card_applied_cents, fulfilment FROM orders WHERE id = ?")
    .bind(orderId)
    .first<{ order_number: string; estimated_for: number; schedule_type: string; total_cents: number; gift_card_applied_cents: number; fulfilment: Fulfilment }>();
  if (!order) return refuse("ORDER_LOOKUP_FAILED", "The order was placed, but I couldn't read it back. The restaurant has it.");
  const number = order.order_number.replace("P62-", "");
  const due = Number(order.total_cents) - Number(order.gift_card_applied_cents ?? 0);
  const kind = order.fulfilment ?? fulfilment ?? "pickup";
  const at = Number(order.estimated_for);
  const scheduled = order.schedule_type === "scheduled";
  const when = scheduled
    ? kind === "delivery" ? `It will be delivered ${spokenWhen(at, now)}.` : `It will be ready for pickup ${spokenWhen(at, now)}.`
    : kind === "delivery" ? `It should arrive around ${clock(at)}.` : `It will be ready around ${clock(at)}.`;
  const say = `Your order is in. Your order number is ${number.split("").join(" ")}. ${when} ${kind === "delivery" ? "Please pay the driver" : "Please pay at the store when you pick it up"}: ${formatMoney(due)}.`;
  return {
    ok: true,
    data: {
      orderNumber: order.order_number,
      estimateAt: at,
      scheduled,
      when: scheduled ? spokenWhen(at, now) : null,
      readyAround: clock(at),
      amountDueCents: due,
      payment: kind === "delivery" ? "pay the driver" : "pay at the store",
      duplicate,
    },
    say,
  };
}

async function placeOrder(context: Context, args: Record<string, unknown>): Promise<Outcome> {
  const version = Number(args.cartVersion);
  if (!Number.isSafeInteger(version)) return refuse("INVALID_INPUT", "cartVersion must be the cartVersion the caller confirmed.");
  let session = context.session;
  // Already placed: a retry gets the same order back, never a second one.
  if (session.orderId) return placedResult(session.orderId, true, session.fulfilment, context.now);
  if (session.stage !== "confirmed" && session.stage !== "placing") {
    return refuse(session.stage === "review" ? "NOT_CONFIRMED" : "NOT_REVIEWED", "Read the order back with review_order and get the caller's yes with confirm_order first.");
  }
  if (version !== session.cartVersion || session.reviewedVersion !== version || session.confirmedVersion !== version) {
    return refuse("CART_CHANGED", "The order changed after the caller confirmed it. Read it back again with review_order.");
  }
  if (session.stage === "confirmed" && (session.confirmedAt ?? 0) + VOICE_CONFIRMATION_TTL_MS < context.now) {
    await expireConfirmation(session, { now: context.now });
    return refuse("CONFIRMATION_EXPIRED", "It's been a few minutes since the caller confirmed. Read the order back again and ask them to confirm.");
  }
  const locked = await beginPlacement(session, version, { now: context.now });
  if (!locked.ok) {
    const current = await loadVoiceSession(session.id);
    if (current?.orderId) return placedResult(current.orderId, true, current.fulfilment, context.now);
    return failedTransition(locked);
  }
  session = locked.session;

  const catalog = await context.catalog();
  const priced = await priceCart(session, catalog);
  if (!priced.quote?.ok) {
    const issues = quoteIssues(priced.quote, session.cart);
    await abandonPlacement(session, issues[0]?.code ?? "QUOTE_FAILED", { now: context.now });
    return { ok: false, issues, say: `${issues[0]?.message ?? "The order can't be placed as it is."} I'll need to go over the order again.` };
  }
  const amountDue = priced.quote.totals.amountDueCents;
  if (amountDue !== session.confirmedAmountCents) {
    await abandonPlacement(session, "TOTAL_CHANGED", { now: context.now });
    return refuse("TOTAL_CHANGED", `The total changed to ${formatMoney(amountDue)} since the caller confirmed. Read the order back again and ask them to confirm.`, {
      data: { previousAmountCents: session.confirmedAmountCents, newAmountCents: amountDue },
    });
  }
  if (amountDue > (await voiceMaxOrderCents())) {
    await abandonPlacement(session, "ORDER_TOO_LARGE", { now: context.now });
    return refuse("ORDER_TOO_LARGE", "An order this size is best taken by our staff. Let me connect you.", { escalate: true, escalationReason: "order_too_large" });
  }

  let created: Awaited<ReturnType<typeof createOrder>>;
  try {
    created = await createOrder(
      {
        ...toOrderRequest(session, recipeLookup(catalog)),
        idempotencyKey: `voice:${session.id}:${version}`,
        expectedAmountDueCents: session.confirmedAmountCents ?? undefined,
      },
      await aiContext(session),
    );
  } catch (error) {
    if (error instanceof OrderValidationError && error.code === "CHECKOUT_IN_PROGRESS") {
      return refuse("PLACEMENT_IN_PROGRESS", "The order is still being placed. Call place_order again in a moment; it will not place a second order.");
    }
    if (error instanceof OrderValidationError) {
      await abandonPlacement(session, error.code, { now: context.now });
      return refuse(error.code, `${error.message} I'll need to go over the order again.`);
    }
    // Unknown whether it committed: the lock stays, and a retry with the same
    // key returns the order if there is one.
    logFailure("voice.place_order", error, { voiceSessionId: session.id });
    return refuse("PLACEMENT_UNCERTAIN", "Something went wrong placing the order. Call place_order again; it will not place a second order.");
  }
  const orderId = String(created.orderId);
  const placed = await completePlacement(session, orderId, { now: context.now });
  const result = await placedResult(orderId, Boolean(created.duplicate), session.fulfilment, context.now);
  return { ...result, session: placed.ok ? placed.session : session };
}

// --- the registry and the one entry point -------------------------------------------------------------

const TOOLS: Record<string, Tool> = {
  get_store_status: { fields: [], run: (context) => getStoreStatus(context) },
  get_business_info: { fields: [], run: (context) => getBusinessInfo(context) },
  get_order_slots: { fields: ["fulfilment", "day"], run: getOrderSlots },
  search_menu: { fields: ["query", "fulfilment", "category"], run: searchMenuTool },
  get_menu_item: { fields: ["productId", "fulfilment"], run: getMenuItem },
  get_deals: { fields: ["fulfilment"], run: getDeals },
  get_cart: { fields: [], run: (context) => getCart(context) },
  start_order: { fields: ["fulfilment"], run: (context, args) => startOrder(context, args, false) },
  reset_order: { fields: [], run: (context, args) => startOrder(context, args, true) },
  add_item: { fields: [...LINE_FIELDS, "expectedCartVersion"], run: addItem },
  update_item: { fields: ["lineId", ...LINE_FIELDS, "expectedCartVersion"], run: updateItem },
  remove_item: { fields: ["lineId", "expectedCartVersion"], run: removeItem },
  set_fulfilment: { fields: ["fulfilment", "expectedCartVersion"], run: setFulfilment },
  set_customer: { fields: ["name", "phone", "useCallerId", "expectedCartVersion"], run: setCustomer },
  check_delivery_address: { fields: ["line1", "unit", "city", "province", "postalCode", "instructions"], run: checkDeliveryAddress },
  set_schedule: { fields: ["when", "day", "time", "expectedCartVersion"], run: setSchedule },
  apply_coupon: { fields: ["code", "expectedCartVersion"], run: applyCoupon },
  remove_coupon: { fields: ["expectedCartVersion"], run: removeCoupon },
  set_tip: { fields: ["type", "percent", "amount", "expectedCartVersion"], run: setTip },
  review_order: { fields: [], run: (context) => reviewOrder(context) },
  confirm_order: { fields: ["cartVersion", "utterance"], run: confirmOrder },
  place_order: { fields: ["cartVersion"], run: placeOrder },
};

export const VOICE_TOOL_NAMES = Object.freeze(Object.keys(TOOLS));

export type VoiceToolResponse = { status: number; body: ToolEnvelope };

/**
 * Runs one tool for the session `sessionSecret` opens.
 *
 * 404 for an unknown tool, 401 when the secret opens no live session, 500 only
 * for a fault on our side; every business outcome — including refusals — is a
 * 200 with `ok: false` and `issues`, so the agent reads the reason instead of
 * treating it as a broken tool.
 */
export async function runVoiceTool(
  tool: string,
  sessionSecret: unknown,
  input: unknown,
  options: { now?: number } = {},
): Promise<VoiceToolResponse> {
  const definition = Object.hasOwn(TOOLS, tool) ? TOOLS[tool] : undefined;
  if (!definition) return { status: 404, body: { ok: false, issues: [{ code: "UNKNOWN_TOOL", message: `There is no tool called ${String(tool).slice(0, 40)}.` }] } };
  const now = options.now ?? Date.now();
  const session = await authenticateVoiceSession(sessionSecret, now);
  if (!session) return { status: 401, body: { ok: false, issues: [{ code: "SESSION_INVALID", message: "This call's session is not valid." }] } };

  let catalog: Promise<VoiceCatalog> | null = null;
  let index: Promise<MenuIndex> | null = null;
  const context: Context = {
    session,
    now,
    catalog: () => (catalog ??= loadVoiceCatalog()),
    index: () => (index ??= (catalog ??= loadVoiceCatalog()).then((loaded) => buildMenuIndex(loaded, { now }))),
  };

  const started = Date.now();
  let outcome: Outcome;
  let fault = false;
  if (session.toolCallCount >= VOICE_MAX_TOOL_CALLS) {
    outcome = refuse("SESSION_LIMIT", "This call has gone on longer than I can handle. Let me connect you to the restaurant.", { escalate: true, escalationReason: "tool_call_limit" });
  } else {
    try {
      outcome = await definition.run(context, assertOnlyFields(input, definition.fields));
    } catch (error) {
      if (error instanceof ToolInputError) outcome = { ok: false, issues: error.issues, say: error.issues[0]?.message };
      else {
        fault = true;
        logFailure("voice.tool", error, { tool, voiceSessionId: session.id });
        outcome = refuse("TOOL_FAILED", "Something went wrong on our side.");
      }
    }
  }

  const after = outcome.session ?? (await loadVoiceSession(session.id)) ?? session;
  const issueCodes = (outcome.issues ?? []).map((issue) => issue.code);
  const counters = await recordToolEvent(session.id, {
    tool,
    request: redactForLog(input),
    response: redactForLog({ ok: outcome.ok, data: outcome.data, issues: outcome.issues, say: outcome.say }),
    ok: outcome.ok,
    countsAsFailure: !outcome.ok && !outcome.soft,
    issueCodes,
    latencyMs: Date.now() - started,
    cartVersionBefore: session.cartVersion,
    cartVersionAfter: after.cartVersion,
    validationFailure: !outcome.ok && !fault,
    escalationReason: outcome.escalationReason ?? null,
  }, { now });
  const escalate = Boolean(outcome.escalate) || counters.consecutiveFailureCount >= VOICE_ESCALATE_AFTER_FAILURES;
  return {
    status: fault ? 500 : 200,
    body: {
      ok: outcome.ok,
      ...(outcome.data ? { data: outcome.data } : {}),
      ...(outcome.issues?.length ? { issues: outcome.issues } : {}),
      ...(outcome.say ? { say: outcome.say } : {}),
      escalate,
      cartVersion: after.cartVersion,
      stage: after.stage,
    },
  };
}
