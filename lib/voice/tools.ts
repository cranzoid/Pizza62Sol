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
  LINE_FIELDS,
  readId,
  readLineChoices,
  readText,
  toOrderRequest,
  ToolInputError,
  type ToolIssue,
} from "@/lib/voice/cart";
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

/** The draft (or a candidate cart) priced by the server, as the AI policy sees it. */
async function priceCart(session: VoiceSession, catalog: VoiceCatalog, cart: VoiceCartLine[] = session.cart): Promise<Priced> {
  if (!cart.length) return { quote: null, items: [], itemsValid: true };
  return quoteOrderDetailed(toOrderRequest({ ...session, fulfilment: session.fulfilment ?? "pickup" }, recipeLookup(catalog), cart), await aiContext(session));
}

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
    totalCents: totals.totalCents,
    amountDueCents: totals.amountDueCents,
    spokenTotal: formatMoney(totals.amountDueCents),
  };
}

function cartView(session: VoiceSession, priced: Priced, catalog: VoiceCatalog) {
  return {
    cartVersion: session.cartVersion,
    stage: session.stage,
    fulfilment: session.fulfilment,
    customer: session.customerName ? { name: session.customerName, phone: session.customerPhone ? spokenPhone(session.customerPhone) : null, phoneSource: session.customerPhoneSource } : null,
    deliveryAddress: addressLine(session.deliveryAddress),
    lines: describeLines(session.cart, priced.items, toppingNamesOf(catalog)),
    totals: totalsView(priced.quote),
    issues: quoteIssues(priced.quote, session.cart),
  };
}

function catalogProduct(catalog: VoiceCatalog, index: MenuIndex, productId: string): VoiceCatalogProduct | null {
  const id = canonicalProductId(index, productId);
  return catalog.products.find((product) => product.id === productId) ?? catalog.products.find((product) => product.id === id) ?? null;
}

/** A line's topping units as the menu counts them: halves are half, chicken counts double. */
function toppingUnitsOf(line: VoiceCartLine): number {
  return line.toppings.reduce((sum, topping) => sum + toppingWeight(topping.toppingId) * (topping.placement === "whole" ? 1 : 0.5), 0);
}

// --- information tools --------------------------------------------------------------------

async function getStoreStatus(context: Context): Promise<Outcome> {
  const [ordering, hours, closures, pilot] = await Promise.all([
    getSetting<{ enabled: boolean; paused: boolean; pauseMessage: string; pickupEnabled: boolean; deliveryEnabled: boolean; pickupEstimateMinutes: number; deliveryEstimateMinutes: number | null; lastOrderCutoffMinutes?: number }>("ordering"),
    getSetting<WeeklyHours>("hours"),
    loadActiveClosures(context.now),
    voicePilotFulfilments(),
  ]);
  const cutoff = Number(ordering.lastOrderCutoffMinutes ?? 0);
  const accepting = (fulfilment: Fulfilment) => storeStatus(context.now, hours, TZ, { closures, fulfilment, lastOrderCutoffMinutes: cutoff });
  const pickup = accepting("pickup");
  const delivery = accepting("delivery");
  const doors = storeStatus(context.now, hours, TZ, { closures });
  const orderingOn = ordering.enabled && !ordering.paused;
  const pickupNow = orderingOn && ordering.pickupEnabled && pickup.open;
  const deliveryNow = orderingOn && ordering.deliveryEnabled && delivery.open && pilot.has("delivery");
  const open = isStoreOpenAt(context.now, hours, TZ) && !doors.closure;
  const closure = pickup.closure ?? delivery.closure;
  const data = {
    acceptingOrdersNow: pickupNow || deliveryNow,
    open,
    lastOrdersAt: pickup.acceptingUntil ? clock(pickup.acceptingUntil) : null,
    asapCutoffPassed: open && !pickup.open && !closure,
    closesAt: open && doors.changesAt ? clock(doors.changesAt) : null,
    nextOpenAt: !open && doors.changesAt ? new Date(doors.changesAt).toLocaleString("en-CA", { weekday: "long", hour: "numeric", minute: "2-digit", timeZone: TZ }) : null,
    paused: ordering.paused || !ordering.enabled,
    pauseMessage: ordering.paused || !ordering.enabled ? ordering.pauseMessage : null,
    closureMessage: closure ? closureMessage(closure) : null,
    pickup: { enabled: ordering.pickupEnabled, acceptingNow: pickupNow, estimateMinutes: ordering.pickupEstimateMinutes },
    delivery: {
      enabled: ordering.deliveryEnabled,
      availableByPhone: pilot.has("delivery"),
      acceptingNow: deliveryNow,
      estimateMinutes: ordering.deliveryEstimateMinutes ?? 30,
    },
  };
  const say = !orderingOn
    ? ordering.pauseMessage
    : closure
      ? closureMessage(closure)
      : pickupNow
        ? `We're taking orders until ${data.lastOrdersAt}. Pickup takes about ${ordering.pickupEstimateMinutes} minutes.${pilot.has("delivery") ? "" : " By phone we can take pickup orders only."}`
        : open
          ? "Last orders have gone in for tonight."
          : `We're closed right now${data.nextOpenAt ? `; we open ${data.nextOpenAt}` : ""}.`;
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
          extraCheese: "extraCheese adds extra cheese, charged as one extra topping. Light or no cheese goes in notes.",
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
  return { ok: true, data: cartView(context.session, await priceCart(context.session, catalog), catalog) };
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
  const result = await startDraft(context.session, { fulfilment, now: context.now });
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
  const view = cartView(result.session, priced, catalog);
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
  const line: VoiceCartLine = {
    lineId: `L${context.session.nextLineNumber}`,
    productId: product.id,
    variationId: variation.variationId,
    quantity: choices.quantity ?? 1,
    toppings: choices.toppings ?? [],
    omitToppings: choices.omitToppings ?? [],
    extraCheese: choices.extraCheese ?? false,
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
  const updated: VoiceCartLine = {
    ...current,
    productId: product.id,
    variationId: variation.variationId,
    quantity: choices.quantity ?? current.quantity,
    toppings: choices.toppings ?? current.toppings,
    omitToppings: choices.omitToppings ?? (productChanged ? [] : current.omitToppings),
    extraCheese: choices.extraCheese ?? current.extraCheese,
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
  const priced = await priceCart(session, catalog);
  issues.push(...quoteIssues(priced.quote, session.cart));
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
      totals: readback.totals,
      promotions: readback.promotions,
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

async function placedResult(orderId: string, duplicate: boolean, fulfilment: Fulfilment | null): Promise<Outcome> {
  const order = await getD1()
    .prepare("SELECT order_number, estimated_for, total_cents, gift_card_applied_cents, fulfilment FROM orders WHERE id = ?")
    .bind(orderId)
    .first<{ order_number: string; estimated_for: number; total_cents: number; gift_card_applied_cents: number; fulfilment: Fulfilment }>();
  if (!order) return refuse("ORDER_LOOKUP_FAILED", "The order was placed, but I couldn't read it back. The restaurant has it.");
  const number = order.order_number.replace("P62-", "");
  const due = Number(order.total_cents) - Number(order.gift_card_applied_cents ?? 0);
  const kind = order.fulfilment ?? fulfilment ?? "pickup";
  const say = `Your order is in. Your order number is ${number.split("").join(" ")}. ${kind === "delivery" ? `It should arrive around ${clock(Number(order.estimated_for))}.` : `It will be ready around ${clock(Number(order.estimated_for))}.`} ${kind === "delivery" ? "Please pay the driver" : "Please pay at the store when you pick it up"}: ${formatMoney(due)}.`;
  return {
    ok: true,
    data: {
      orderNumber: order.order_number,
      estimateAt: Number(order.estimated_for),
      readyAround: clock(Number(order.estimated_for)),
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
  if (session.orderId) return placedResult(session.orderId, true, session.fulfilment);
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
    if (current?.orderId) return placedResult(current.orderId, true, current.fulfilment);
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
  const result = await placedResult(orderId, Boolean(created.duplicate), session.fulfilment);
  return { ...result, session: placed.ok ? placed.session : session };
}

// --- the registry and the one entry point -------------------------------------------------------------

const TOOLS: Record<string, Tool> = {
  get_store_status: { fields: [], run: (context) => getStoreStatus(context) },
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
