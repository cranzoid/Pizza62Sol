"use client";

/**
 * Taking an order at the counter or on the phone.
 *
 * Written for someone standing at a till with a customer waiting. Staff
 * feedback on the first version (November 2026) was that it felt boxy and
 * confusing: the menu sat below a page of headings and customer fields, every
 * category was a page of its own to drill into, and paying meant scrolling to
 * the bottom of a long receipt. They had come from Loyverse, which is one full
 * screen. So this is laid out the same way:
 *
 * - **One screen, no page scroll.** The till takes the whole display. A thin
 *   bar along the top holds the order type and the customer; below it the
 *   categories, the items and the receipt sit side by side and each scrolls on
 *   its own.
 * - **Categories are always on screen.** One tap changes the items beside them;
 *   there is no "all categories" page to go back to.
 * - **Customer details live in a sheet**, opened from the bar (and on its own
 *   when a delivery needs an address), instead of pushing the menu down.
 * - **Paying is its own screen.** "Charge" opens a payment sheet with the amount
 *   due, the usual notes and the change, like the card machine. "Take payment &
 *   print" there opens the cash drawer as the ticket prints — cash or card —
 *   because staff reported needing a second tap to get the drawer open with the
 *   customer holding their money. A manual "Open cash drawer" stays at the
 *   bottom of the receipt for change and swapped notes.
 * - **A placed order can be edited.** "Edit an order" (or Edit on the Live
 *   orders board) loads it back into the till; saving keeps its number and
 *   prints an UPDATED ORDER ticket. See `editOrder` in lib/order-service.ts.
 *
 * The total comes from the server on every change, from the same pricing path
 * the website uses. That is the point of the whole feature — a counter order
 * priced by a second implementation is how a restaurant ends up with two sets of
 * books, and it is also how the HST on the day's takings stops adding up.
 *
 * The whole menu can be rung in, through the *same* customizer the website
 * mounts (`app/menu/ItemCustomizer.tsx`), so a pizza rung in here is built from
 * the same steps, priced by the same code, and reaches the kitchen in the same
 * shape as one ordered online. A phone order can be a delivery, and its address
 * goes through exactly the same validation as a website order.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MutableRefObject } from "react";
import { cashChange, parseCashTender, compareMenuPrice, formatMoney, isWithinWeeklyAvailability, type WeeklyAvailability } from "@/lib/domain";
import { drinkSummary } from "@/lib/drink-slots";
import { useServerQuote } from "@/app/menu/useServerQuote";
import { buildPassPrntDrawerUri, buildPassPrntUri, shouldUsePassPrnt } from "@/lib/passprnt";
import { capturePassPrntResult } from "@/lib/passprnt-result";
import { centsToQualify, formatEntryNumber } from "@/lib/giveaway";
import { orderEditRefusal } from "@/lib/order-edit";
import type { ToppingPlacement } from "@/lib/domain";
import {
  GenericCustomizer,
  PizzaCustomizer,
  needsCustomizing,
  toOrderItems,
  toppingText,
  type BuiltItem,
  type CustomizerProduct,
} from "@/app/menu/ItemCustomizer";
import type { Dashboard } from "@/app/staff/StaffPortal";
import {
  AddressSuggestionRow,
  CustomerHistorySheet,
  CustomerSuggestionRow,
  SuggestField,
  formatPhone,
  type AddressSuggestion,
} from "@/app/staff/TillLookup";
import type { CustomerHistory, CustomerSuggestion, PastOrder, SavedAddress } from "@/lib/customer-lookup";

/**
 * Two identical items are one line with a quantity of two; two pizzas built
 * differently are two lines. The whole build is the identity — every choice, in
 * a stable order, because `{cheese, crust}` and `{crust, cheese}` are the same
 * pizza and must stringify the same way.
 */
function buildSignature(item: BuiltItem): string {
  return JSON.stringify([
    item.productId,
    item.variationId ?? "",
    [...(item.toppings ?? [])].map((entry) => `${entry.toppingId}:${entry.placement}${entry.double ? ":x2" : ""}`).sort(),
    [...(item.modifiers ?? [])]
      .map((modifier) => `${modifier.id}=${[...modifier.values].map((value) => `${value.value}:${value.placement ?? "whole"}${value.double ? ":x2" : ""}`).sort().join("|")}`)
      .sort(),
    [...(item.omitToppings ?? [])].sort(),
    Boolean(item.extraCheese),
    item.specialInstructions ?? "",
  ]);
}

/**
 * The chosen options, spelled out under the item name on the receipt.
 *
 * `toppingNames` is needed for the omissions alone: a built item carries the
 * *names* of what was added and the *ids* of what was left off, and "No
 * real-bacon" on a ticket someone is reading down the phone is not good enough.
 */
function describeChoices(item: BuiltItem, toppingNames: Map<string, string>): string[] {
  const parts: string[] = [];
  if (item.variationName) parts.push(item.variationName);
  if (item.extraCheese) parts.push("Extra cheese");
  for (const topping of item.toppings ?? []) {
    if (!item.omitToppings?.includes(topping.toppingId)) parts.push(toppingText(topping));
  }
  for (const toppingId of item.omitToppings ?? []) parts.push(`No ${toppingNames.get(toppingId) ?? toppingId}`);
  const drinks = drinkSummary(item.modifiers ?? [], item.modifierSections ?? []);
  const drinkIds = new Set(drinks.flatMap((entry) => [...entry.ids]));
  for (const modifier of item.modifiers ?? []) {
    if (drinkIds.has(modifier.id)) continue;
    parts.push(`${modifier.label}: ${modifier.values.map((value) => toppingText(value)).join(", ")}`);
  }
  if (item.specialInstructions) parts.push(item.specialInstructions);
  parts.push(...drinks.filter((entry) => entry.text).map((entry) => `Included drinks: ${entry.text}`));
  return parts;
}

type Quote = {
  ok: boolean;
  lines: Array<{ index: number; unitPriceCents: number; lineTotalCents: number }>;
  totals: {
    menuSubtotalCents: number;
    discountCents: number;
    taxCents: number;
    deliveryFeeCents: number;
    tipCents?: number;
    totalCents: number;
    giftCardAppliedCents: number;
    amountDueCents: number;
  };
  issues: Array<{ index: number | null; message: string; code?: string }>;
  appliedPromotions?: Array<{ id: string; name: string; discountCents: number }>;
  /** Null until a code is entered. `message` says why one did not come off. */
  coupon: { code: string; accepted: boolean; message: string | null } | null;
  /** Null until a gift card code is entered. Never carries the code itself. */
  giftCard: {
    suffix: string;
    accepted: boolean;
    balanceCents: number;
    appliedCents: number;
    remainingAfterCents: number;
    message: string | null;
  } | null;
};

type PlacedOrder = {
  duplicate?: boolean;
  orderNumber?: string;
  totalCents?: number;
  previousTotalCents?: number;
  /** What is left to collect once a gift card has paid its part. */
  amountDueCents?: number;
  giftCardAppliedCents?: number;
  printOrder?: Record<string, unknown> | null;
  /** Set when the order earned a Thanksgiving Giveaway entry. */
  giveawayEntryNumber?: number | null;
  birthdaySaved?: boolean;
  error?: string;
};

type Tender = "cash" | "card" | "later";

/** The order being changed, as it was when it was loaded into the till. */
type EditTarget = {
  id: string;
  orderNumber: string;
  updatedAt: number;
  previousTotalCents: number;
  channel: string;
  contactRedacted: boolean;
};

/**
 * What the last placed or edited order needs said about it once it is in.
 *
 * Kept in localStorage as well as state because PassPRNT prints by leaving the
 * page and coming back to it, which reloads the till. Without this the change
 * to give and the "print again" button disappeared at the exact moment they
 * were needed.
 */
type Done = {
  at: number;
  orderNumber: string;
  edited: boolean;
  /** Money that changed hands at the till, if any, and which way. */
  collectedCents: number;
  refundCents: number;
  tender: Tender | null;
  changeCents: number | null;
  changeBreakdown: string | null;
  note: string;
  printOrder: Record<string, unknown> | null;
  /** The print could not be handed off from the tap; the button must be pressed. */
  printPending: boolean;
  /** The pending print should still open the drawer when it goes. */
  drawerWithPrint: boolean;
};

const DONE_KEY = "p62.till.lastOrder";
const DONE_TTL_MS = 20 * 60_000;

function readDone(): Done | null {
  try {
    const raw = window.localStorage.getItem(DONE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Done;
    return Date.now() - Number(parsed.at) < DONE_TTL_MS ? parsed : null;
  } catch {
    return null;
  }
}

function writeDone(done: Done | null) {
  try {
    if (done) window.localStorage.setItem(DONE_KEY, JSON.stringify(done));
    else window.localStorage.removeItem(DONE_KEY);
  } catch {
    // Private mode or storage full: the on-screen state still works.
  }
}

const BIRTHDAY_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const NEVER_CHANGES = () => () => {};
const NO_PRINT_RESULT = () => null;

/** What the Live orders board calls to send an order to the till for editing. */
export type TillApi = { startEdit: (order: Record<string, unknown>) => void };

export function StaffOrderEntry({
  dashboard,
  onPlaced,
  active = true,
  onDraftChange,
  onExit,
  newOrderCount = 0,
  apiRef,
}: {
  dashboard: Dashboard;
  onPlaced: () => Promise<void>;
  active?: boolean;
  onDraftChange?: (dirty: boolean) => void;
  /** Leave the full-screen till for the rest of the admin. */
  onExit?: () => void;
  /** Website and phone orders not yet acknowledged, shown on the bar. */
  newOrderCount?: number;
  apiRef?: MutableRefObject<TillApi | null>;
}) {
  const [channel, setChannel] = useState<"walk_in" | "phone">("walk_in");
  const [fulfilment, setFulfilment] = useState<"pickup" | "delivery">("pickup");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  // Month and day only, never the year — for a birthday treat, not an ID check.
  const [birthMonth, setBirthMonth] = useState("");
  const [birthDay, setBirthDay] = useState("");
  const [line1, setLine1] = useState("");
  const [unit, setUnit] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [deliveryInstructions, setDeliveryInstructions] = useState("");
  const [lines, setLines] = useState<BuiltItem[]>([]);
  // The product whose customizer is open, if any.
  const [building, setBuilding] = useState<CustomizerProduct | null>(null);
  const [editingLine, setEditingLine] = useState<BuiltItem | undefined>();
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const submittingRef = useRef(false);
  const submission = useRef<{ signature: string; key: string } | null>(null);
  const handoff = useRef(false);
  useEffect(() => {
    const resumed = () => { handoff.current = false; };
    window.addEventListener("focus", resumed);
    return () => window.removeEventListener("focus", resumed);
  }, []);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [couponInput, setCouponInput] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [giftCardInput, setGiftCardInput] = useState("");
  const [giftCardCode, setGiftCardCode] = useState("");
  const [showCodes, setShowCodes] = useState(false);
  const [orderSearch, setOrderSearch] = useState("");
  const [sheet, setSheet] = useState<"customer" | "payment" | "orders" | null>(null);
  const [tender, setTender] = useState<Tender>("cash");
  // For an edit: whether the customer already paid the old total at the till.
  const [alreadyPaid, setAlreadyPaid] = useState(true);
  // Cash handed over, in dollars as typed. Kept as the raw string so someone
  // half way through "20" is not shown change for C$2.
  const [cashGiven, setCashGiven] = useState("");
  // Restored from the last visit: see `Done` on why it outlives a reload.
  const [done, setDone] = useState<Done | null>(() => (typeof window === "undefined" ? null : readDone()));

  /**
   * What is on the menu right now, for this kind of order. The only exclusions
   * are the ones the server would enforce anyway: hidden, sold out, waiting on
   * owner setup, or not offered for the fulfilment the counter has selected.
   */
  const categoryOrder = new Map(dashboard.categories.map((category) => [category.id, category.display_order]));
  const sellable = dashboard.products
    .filter((product) => {
      if (!product.active || product.sold_out || product.setup_required || !isWithinWeeklyAvailability(product.configuration.availability as WeeklyAvailability | undefined)) return false;
      return Boolean(fulfilment === "delivery" ? product.delivery_eligible : product.pickup_eligible);
    })
    // Same order the website shows: categories in menu order, cheapest first.
    .sort((left, right) =>
      (categoryOrder.get(left.category_id) ?? 0) - (categoryOrder.get(right.category_id) ?? 0)
      || compareMenuPrice(left, right));

  const operations = (dashboard.settings.operations?.value ?? {}) as Record<string, unknown>;
  const halfToppingUnitsBps = Number(operations.halfToppingUnitsBps ?? 5_000);
  const activeToppings = dashboard.toppings.filter((topping) => topping.active);
  const toppingNames = useMemo(() => new Map(dashboard.toppings.map((topping) => [topping.id, topping.name])), [dashboard.toppings]);
  const buildingVariations = building
    ? dashboard.variations.filter((variation) => variation.product_id === building.id && variation.active)
    : [];

  const categories = dashboard.categories.filter((category) => category.active && sellable.some((product) => product.category_id === category.id));
  const categoryIndex = new Map(categories.map((category, index) => [category.id, index]));
  // Always a category on screen: there is no "pick a category" page any more.
  const shownCategoryId = categories.some((category) => category.id === categoryId) ? categoryId : categories[0]?.id ?? null;
  const searching = Boolean(search.trim());
  const matching = searching
    ? sellable.filter((product) => `${product.name} ${dashboard.categories.find((category) => category.id === product.category_id)?.name ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()))
    : sellable.filter((product) => product.category_id === shownCategoryId);

  const quoteChannel = editTarget ? (editTarget.channel === "walk_in" ? "walk_in" : "phone") : channel;
  const body = useCallback(
    (extra: Record<string, unknown> = {}) => ({
      channel: quoteChannel,
      fulfilment,
      customer: { name: name.trim() || "Counter", phone: phone.trim(), email: email.trim() },
      // Encoded by the same function the website uses.
      items: toOrderItems(lines),
      schedule: { type: "asap" as const },
      paymentMethod: "pay_at_store" as const,
      tip: { type: "none" as const },
      ...(couponCode ? { couponCode } : {}),
      ...(giftCardCode ? { giftCardCode } : {}),
      // City and province are fixed: the delivery area is a radius around one
      // Hamilton store, so any other answer is one the radius check rejects.
      ...(fulfilment === "delivery"
        ? {
            address: {
              line1: line1.trim(),
              unit: unit.trim(),
              city: "Hamilton",
              province: "ON",
              postalCode: postalCode.trim(),
              instructions: deliveryInstructions.trim(),
            },
          }
        : {}),
      ...extra,
    }),
    [quoteChannel, fulfilment, name, phone, email, line1, unit, postalCode, deliveryInstructions, lines, couponCode, giftCardCode],
  );

  // Re-priced by the server on every change. Sequenced so a slow earlier reply
  // cannot overwrite a newer total while someone is adding items quickly.
  const serialized = JSON.stringify(body({ quoteOnly: true }));
  const { quote, loading: quoteLoading, failed: quoteFailed, error: quoteError, retry: retryQuote } = useServerQuote<Quote>("/api/admin/orders", lines.length ? serialized : null, JSON.stringify([dashboard.settings, dashboard.products, dashboard.variations, dashboard.toppings]));
  const dirty = Boolean(lines.length || building || editTarget || name || phone || email || line1 || unit || postalCode || deliveryInstructions || couponInput || giftCardInput || birthMonth || birthDay);
  useEffect(() => { onDraftChange?.(dirty); }, [dirty, onDraftChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (handoff.current) return;
      event.preventDefault(); event.returnValue = "";
    };
    const leaving = (event: MouseEvent) => {
      const link = (event.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.getAttribute("href")?.startsWith("#")) return;
      if (!window.confirm("Leave this page and discard the unfinished order?")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", leaving, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", leaving, true); };
  }, [dirty]);

  const totals = quote?.totals ?? {
    menuSubtotalCents: 0,
    discountCents: 0,
    taxCents: 0,
    deliveryFeeCents: 0,
    tipCents: 0,
    totalCents: 0,
    giftCardAppliedCents: 0,
    amountDueCents: 0,
  };
  /**
   * What stops this order going in. An edit ignores the whole-order checks
   * about *placing* an order — hours, a paused website, a closure — because the
   * order was already accepted; `editOrder` does not apply them either.
   */
  const blockingIssues = (quote?.issues ?? []).filter((issue) =>
    !editTarget || issue.index !== null || issue.code === "DELIVERY_BELOW_MINIMUM" || issue.code === "GIFT_CARD_UNAVAILABLE");
  const quoteUsable = Boolean(quote && !quoteLoading && (editTarget ? blockingIssues.length === 0 : quote.ok));

  const clearDraft = () => {
    setLines([]); setBuilding(null); setEditingLine(undefined); setSelectedLine(null); setEditTarget(null);
    setName(""); setPhone(""); setEmail(""); setBirthMonth(""); setBirthDay("");
    setLine1(""); setUnit(""); setPostalCode(""); setDeliveryInstructions("");
    setCouponCode(""); setCouponInput(""); setGiftCardCode(""); setGiftCardInput(""); setShowCodes(false);
    setCashGiven(""); setTender("cash"); setAlreadyPaid(true);
    submission.current = null;
  };

  /**
   * Puts a built item on the receipt. An identical build adds a quantity
   * rather than a second line; two pizzas built differently stay apart.
   */
  const add = (item: BuiltItem) => {
    setMessage(null);
    setBuilding(null);
    setEditingLine(undefined);
    if (done && !lines.length) { setDone(null); writeDone(null); }
    setLines((current) => {
      const signature = buildSignature(item);
      const existing = current.find((line) => buildSignature(line) === signature);
      if (existing) {
        return current.map((line) => (line === existing ? { ...line, quantity: Math.min(99, line.quantity + item.quantity) } : line));
      }
      return [...current, item];
    });
  };

  /** A product with nothing to choose goes straight on, at its listed price. */
  const addPlain = (product: CustomizerProduct, variation?: { id: string; name: string; base_price_cents: number }) =>
    add({
      key: crypto.randomUUID(),
      productId: product.id,
      name: product.name,
      categoryId: product.category_id,
      variationId: variation?.id,
      variationName: variation?.name,
      quantity: 1,
      unitPriceCents: variation?.base_price_cents ?? product.base_price_cents,
      taxable: Boolean(product.taxable),
      freeDelivery: Boolean(product.configuration?.freeDelivery),
    });

  const setQuantity = (key: string, delta: number) =>
    setLines((current) =>
      current
        .map((line) => (line.key === key ? { ...line, quantity: Math.min(99, line.quantity + delta) } : line))
        .filter((line) => line.quantity > 0),
    );

  const removeLine = (key: string) => { setLines((current) => current.filter((line) => line.key !== key)); setSelectedLine(null); };

  const editLine = (line: BuiltItem) => {
    const product = dashboard.products.find((entry) => entry.id === line.productId);
    if (!product) { setMessage({ tone: "bad", text: "This item is no longer in the menu. Remove it and choose another item." }); return; }
    setEditingLine(line); setBuilding(product);
  };
  const saveLine = (line: BuiltItem) => {
    setLines((current) => current.map((entry) => entry.key === editingLine?.key ? { ...line, key: entry.key } : entry));
    setBuilding(null); setEditingLine(undefined);
  };
  const closeBuilder = () => { setBuilding(null); setEditingLine(undefined); };
  const discard = () => {
    if (!window.confirm(editTarget ? `Stop editing ${editTarget.orderNumber.replace("P62-", "#")}? The order stays as it was.` : "Discard this unfinished order?")) return;
    clearDraft(); setMessage(null); setSheet(null);
  };

  /**
   * Loads a placed order back into the till for editing.
   *
   * Each saved item is turned back into what the customizer builds, from the
   * snapshot the server stored when it was ordered — so an edited pizza opens
   * in the customizer with its toppings, halves and omissions as they were.
   */
  /**
   * Turns a placed order's items back into what the customizer builds, from
   * the snapshots the server stored — so a pizza opens with its toppings,
   * doubles, halves and omissions as they were. Used to edit an order and to
   * order one again.
   *
   * `orderable` additionally drops what cannot be sold right now (sold out, a
   * size no longer offered, not available for this kind of order): editing
   * keeps an item the customer already has, ordering again cannot.
   */
  const rebuildLines = (items: Array<Record<string, unknown>>, orderable: boolean) => {
    const toppingIds = new Map(dashboard.toppings.map((topping) => [topping.name, topping.id]));
    const missing: string[] = [];
    const built: BuiltItem[] = [];
    for (const item of items) {
      const product = (orderable ? sellable : dashboard.products).find((entry) => entry.id === item.productId);
      const snapshot = (item.snapshot ?? {}) as Record<string, unknown>;
      const variationId = typeof snapshot.variationId === "string" ? snapshot.variationId : undefined;
      if (!product || (orderable && variationId && !dashboard.variations.some((variation) => variation.id === variationId && variation.active))) {
        missing.push(String(item.productName ?? "An item"));
        continue;
      }
      const toppings = Array.isArray(snapshot.toppings) ? (snapshot.toppings as Array<{ toppingId: string; placement: ToppingPlacement; double?: boolean }>) : [];
      const omissions = Array.isArray(snapshot.recipeOmissions) ? (snapshot.recipeOmissions as string[]) : [];
      const modifiers = Array.isArray(snapshot.modifiers) ? (snapshot.modifiers as BuiltItem["modifiers"]) : [];
      built.push({
        key: crypto.randomUUID(),
        productId: product.id,
        name: String(item.productName ?? product.name),
        categoryId: product.category_id,
        variationId,
        variationName: item.variationName ? String(item.variationName) : undefined,
        quantity: Number(item.quantity ?? 1),
        unitPriceCents: Number(item.unitPriceCents ?? product.base_price_cents),
        taxable: Boolean(product.taxable),
        toppings: toppings.length ? toppings.map((entry) => ({ toppingId: entry.toppingId, placement: entry.placement, name: toppingNames.get(entry.toppingId) ?? entry.toppingId, ...(entry.double ? { double: true } : {}) })) : undefined,
        omitToppings: omissions.length ? omissions.map((label) => toppingIds.get(label) ?? label) : undefined,
        modifiers: modifiers?.length ? modifiers : undefined,
        extraCheese: snapshot.extraCheese ? true : undefined,
        specialInstructions: item.instructions ? String(item.instructions) : undefined,
        freeDelivery: Boolean(product.configuration?.freeDelivery),
      });
    }
    return { built, missing };
  };

  const startEdit = (order: Record<string, unknown>) => {
    const refusal = orderEditRefusal(order);
    if (refusal) { setMessage({ tone: "bad", text: refusal }); setSheet(null); return; }
    if (dirty && !editTarget && !window.confirm("Put the order you are ringing in aside and edit this one instead? The unfinished order will be discarded.")) return;
    const { built, missing } = rebuildLines((order.items as Array<Record<string, unknown>> | undefined) ?? [], false);
    const address = (order.address ?? null) as Record<string, string> | null;
    clearDraft();
    setEditTarget({
      id: String(order.id),
      orderNumber: String(order.order_number ?? ""),
      updatedAt: Number(order.updated_at ?? 0),
      previousTotalCents: Number(order.total_cents ?? 0),
      channel: String(order.channel ?? "phone"),
      contactRedacted: Boolean(order.contactRedacted),
    });
    setChannel(order.channel === "walk_in" ? "walk_in" : "phone");
    setFulfilment(order.fulfilment === "delivery" ? "delivery" : "pickup");
    setName(String(order.customer_name ?? "") === "Counter" ? "" : String(order.customer_name ?? ""));
    setPhone(order.customer_phone ? String(order.customer_phone) : "");
    setEmail(order.customer_email ? String(order.customer_email) : "");
    setLine1(address?.line1 ?? "");
    setUnit(address?.unit ?? "");
    setPostalCode(address?.postalCode ?? "");
    setDeliveryInstructions(order.instructions ? String(order.instructions) : "");
    setLines(built);
    setDone(null); writeDone(null);
    setSheet(null);
    setMessage(missing.length
      ? { tone: "bad", text: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} no longer on the menu and ${missing.length === 1 ? "was" : "were"} left off. Add a replacement before saving.` }
      : { tone: "ok", text: `Editing ${String(order.order_number ?? "").replace("P62-", "#")}. Change what you need, then tap Save changes.${Number(order.discount_cents ?? 0) > 0 ? " It had a discount: if that came from a promo code, enter the code again under Promo code." : ""}` });
  };
  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = { startEdit };
    return () => { apiRef.current = null; };
  });

  // --- A returning customer ------------------------------------------------
  // Typing a number offers the customers it matches; picking one opens their
  // history over the till. See app/staff/TillLookup.tsx.
  const canLookUpCustomers = dashboard.user.role === "owner" || dashboard.user.permissions.includes("view_customer_contact");
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const fillAddress = (address: { line1: string; unit?: string; postalCode: string; instructions?: string }) => {
    setLine1(address.line1);
    setUnit(address.unit ?? "");
    setPostalCode(address.postalCode);
    if (address.instructions !== undefined) setDeliveryInstructions(address.instructions);
  };
  const fillCustomer = (customer: CustomerHistory) => {
    if (customer.name) setName(customer.name);
    setPhone(formatPhone(customer.phone));
    if (customer.email) setEmail(customer.email);
  };
  const applyCustomerDetails = (customer: CustomerHistory) => {
    fillCustomer(customer);
    if (customer.addresses[0]) fillAddress(customer.addresses[0]);
    setHistoryFor(null);
    setSheet("customer");
  };
  const applyCustomerAddress = (customer: CustomerHistory, address: SavedAddress) => {
    fillCustomer(customer);
    fillAddress(address);
    setFulfilment("delivery");
    setHistoryFor(null);
    setSheet("customer");
  };
  /**
   * "Same as last time": that order's items onto the receipt, and the
   * customer's details and address into the form. The order type the till is
   * set to is left alone — whoever is on the phone chose it — but the address
   * is filled either way, so switching to delivery needs nothing typed.
   */
  const reorder = (customer: CustomerHistory, order: PastOrder) => {
    const { built, missing } = rebuildLines(order.items, true);
    fillCustomer(customer);
    const address = order.fulfilment === "delivery" && order.address?.line1
      ? { line1: order.address.line1, unit: order.address.unit ?? "", postalCode: order.address.postalCode ?? "", instructions: order.instructions ?? "" }
      : customer.addresses[0];
    if (address) fillAddress(address);
    if (done && !lines.length) { setDone(null); writeDone(null); }
    setLines((current) => {
      const merged = [...current];
      for (const item of built) {
        const existing = merged.findIndex((line) => buildSignature(line) === buildSignature(item));
        if (existing >= 0) merged[existing] = { ...merged[existing], quantity: Math.min(99, merged[existing].quantity + item.quantity) };
        else merged.push(item);
      }
      return merged;
    });
    setHistoryFor(null);
    const ref = order.order_number.replace("P62-", "#");
    const notes = [
      built.length ? `Added ${built.reduce((sum, line) => sum + line.quantity, 0)} item${built.length === 1 && built[0].quantity === 1 ? "" : "s"} from ${ref}.` : `Nothing from ${ref} can be ordered right now.`,
      missing.length ? `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not available now and ${missing.length === 1 ? "was" : "were"} left off.` : "",
      order.fulfilment === "delivery" && fulfilment === "pickup" ? "That order was a delivery: tap Delivery if it is going to them." : "",
      "Prices are today's.",
    ].filter(Boolean);
    setMessage({ tone: missing.length || !built.length ? "bad" : "ok", text: notes.join(" ") });
    if (fulfilment === "delivery" && (!address?.line1 || !address.postalCode)) setSheet("customer");
    else setSheet(null);
  };

  // What the printer app reported on its way back.
  const printResult = useSyncExternalStore(NEVER_CHANGES, capturePassPrntResult, NO_PRINT_RESULT);
  const printFailure = printResult && !printResult.ok ? printResult.message : null;

  const passPrntCallback = () => {
    const callback = new URL(window.location.href);
    callback.searchParams.delete("passprnt_code");
    callback.searchParams.delete("passprnt_message");
    return callback.toString();
  };

  /**
   * Hands the ticket to PassPRNT. Must run inside the tap's own handler:
   * Android allows the handoff only on a direct gesture. `openDrawer` kicks the
   * drawer as the ticket prints — the payment tap asks for it, a reprint not.
   */
  const printTicket = (order: Record<string, unknown>, printedAt: number, openDrawer: boolean): boolean => {
    if (!shouldUsePassPrnt(window.navigator.userAgent)) return false;
    handoff.current = true;
    window.location.assign(buildPassPrntUri({ order, toppingNames, printedAt, callbackUrl: passPrntCallback(), openDrawer }));
    return true;
  };

  // Kept for change, a swapped note or a drawer that did not open with the
  // payment. Inside the click handler for the same Android reason as above.
  const openCashDrawer = () => {
    if (!shouldUsePassPrnt(window.navigator.userAgent)) {
      setMessage({ tone: "bad", text: "The cash drawer opens from the till tablet only." });
      return;
    }
    handoff.current = true;
    window.location.assign(buildPassPrntDrawerUri({ callbackUrl: passPrntCallback() }));
  };

  // A birthday is filed against the customer's email or phone.
  const birthdayChosen = Boolean(birthMonth && birthDay);
  const birthdayReady = !editTarget && fulfilment === "pickup" && birthdayChosen && Boolean(email.trim() || phone.replace(/\D/g, "").length >= 10);

  /**
   * The money this tap moves.
   *
   * A new pickup: the amount due. An edit the customer already paid for: only
   * the difference — more to collect, or some to give back. An edit not yet
   * paid: the new total. A delivery moves no money at the counter; the driver
   * collects the full amount at the door.
   */
  const differenceCents = editTarget ? totals.totalCents - editTarget.previousTotalCents : 0;
  const collectCents = fulfilment === "delivery"
    ? 0
    : editTarget
      ? (alreadyPaid ? Math.max(0, differenceCents) : totals.amountDueCents)
      : totals.amountDueCents;
  const refundCents = editTarget && fulfilment === "pickup" && alreadyPaid ? Math.max(0, -differenceCents) : 0;
  const tenderUsed: Tender | null = collectCents > 0 ? tender : null;
  const tenderedCents = parseCashTender(cashGiven);
  const cashRounded = collectCents > 0 ? cashChange(collectCents, 0) : null;
  const cash =
    tenderUsed === "cash" && collectCents > 0 && cashGiven.trim() && tenderedCents !== null
      ? cashChange(collectCents, tenderedCents)
      : null;
  const invalidTender = tenderUsed === "cash" && Boolean(cashGiven.trim() && (tenderedCents === null || (cash && cash.shortCents > 0)));
  // Exact money and then the next few round notes above it: the common case
  // needs no typing at all.
  const quickTenders = cashRounded
    ? [...new Set([cashRounded.roundedTotalCents, Math.ceil(cashRounded.roundedTotalCents / 500) * 500, 2000, 5000, 10_000])]
        .filter((amount) => amount >= cashRounded.roundedTotalCents)
        .sort((left, right) => left - right)
        .slice(0, 4)
    : [];
  /** The drawer opens when money changes hands now, in or out. */
  const drawerOpens = (tenderUsed === "cash" || tenderUsed === "card") || refundCents > 0;

  const giveaway = dashboard.giveaway?.status === "open" ? dashboard.giveaway : null;
  const giveawayShort = giveaway && lines.length && quote
    ? centsToQualify(giveaway, { subtotalCents: totals.menuSubtotalCents, discountCents: totals.discountCents })
    : null;

  const finish = (result: PlacedOrder, edited: boolean, printRequestedAt: number, openDrawer: boolean) => {
    const printable = !result.duplicate && result.printOrder ? result.printOrder : null;
    const canPrint = Boolean(printable && shouldUsePassPrnt(window.navigator.userAgent));
    // Android lets the page hand off to PassPRNT only for a few seconds after
    // the tap. A slow placement (a delivery's address check) can outlast that
    // window; then ask for one more tap instead of pretending.
    const tapStillCounts = window.navigator.userActivation?.isActive ?? true;
    const willPrint = canPrint && tapStillCounts;
    const ref = String(result.orderNumber ?? "").replace("P62-", "#");
    const entry = result.giveawayEntryNumber ? ` Giveaway entry #${formatEntryNumber(result.giveawayEntryNumber)} — tell the customer!` : "";
    const birthdayNote = result.birthdaySaved ? " Birthday saved." : "";
    const record: Done = {
      at: Date.now(),
      orderNumber: String(result.orderNumber ?? ""),
      edited,
      collectedCents: collectCents,
      refundCents,
      tender: tenderUsed,
      changeCents: cash && cash.shortCents === 0 ? cash.changeCents : null,
      changeBreakdown: cash && cash.shortCents === 0 && cash.breakdown.length ? cash.breakdown.map((part) => `${part.count} × ${part.label}`).join(" · ") : null,
      note: `${edited ? `${ref} updated.` : `${ref} is in.`}${fulfilment === "delivery" ? ` The driver collects ${formatMoney(Number(result.amountDueCents ?? totals.amountDueCents))} at the door.` : ""}${entry}${birthdayNote}`,
      printOrder: printable,
      printPending: canPrint && !tapStillCounts,
      drawerWithPrint: openDrawer,
    };
    setDone(record);
    writeDone(record);
    setMessage(null);
    setSheet(null);
    clearDraft();
    onDraftChange?.(false);
    // Launch before refreshing: an extra round trip can lose the tap.
    if (printable && willPrint) printTicket(printable, printRequestedAt, openDrawer);
    void onPlaced().catch(() => undefined);
  };

  const submit = async (printRequestedAt: number) => {
    if (submittingRef.current || !quoteUsable || !quote || !lines.length || invalidTender) return;
    const openDrawer = drawerOpens;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      setMessage(null);
      if (editTarget) {
        const response = await fetch("/api/admin/orders", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body({ orderId: editTarget.id, expectedUpdatedAt: editTarget.updatedAt })),
        });
        const result = (await response.json()) as PlacedOrder;
        if (!response.ok) {
          setMessage({ tone: "bad", text: result.error ?? "That order could not be changed." });
          retryQuote();
          return;
        }
        finish(result, true, printRequestedAt, openDrawer);
        return;
      }
      const signature = JSON.stringify(body());
      if (submission.current?.signature !== signature) submission.current = { signature, key: `staff-${crypto.randomUUID()}-${crypto.randomUUID()}` };
      const response = await fetch("/api/admin/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body({
          idempotencyKey: submission.current.key,
          expectedAmountDueCents: quote.totals.amountDueCents,
          ...(birthdayReady ? { birthday: { month: Number(birthMonth), day: Number(birthDay) } } : {}),
        })),
      });
      const result = (await response.json()) as PlacedOrder;
      if (!response.ok) {
        setMessage({ tone: "bad", text: result.error ?? "That order could not be created." });
        retryQuote();
        return;
      }
      finish(result, false, printRequestedAt, openDrawer);
    } catch {
      setMessage({ tone: "bad", text: editTarget
        ? "The change could not be confirmed. Check the order on Live orders before trying again."
        : "The request could not be confirmed. Retry this order; the same submission reference will prevent a duplicate." });
    } finally { submittingRef.current = false; setSubmitting(false); }
  };

  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const quoteMoney = (cents: number) => lines.length && !quote ? "—" : formatMoney(cents);
  const deliveryMissing = fulfilment === "delivery" && (!line1.trim() || !postalCode.trim() || (!phone.trim() && !editTarget?.contactRedacted));
  const customerLabel = name.trim() || "Counter";
  const ref = editTarget?.orderNumber.replace("P62-", "#");

  /** The big button under the receipt. */
  const chargeLabel = submitting
    ? editTarget ? "Saving…" : "Sending to the kitchen…"
    : lines.length && !quote
      ? quoteFailed ? "Retry pricing" : "Pricing…"
      : editTarget
        ? `Save changes · ${formatMoney(totals.totalCents)}`
        : fulfilment === "delivery"
          ? `Send & print · ${formatMoney(totals.amountDueCents)}`
          : totals.giftCardAppliedCents > 0 && totals.amountDueCents === 0
            ? "Print · paid by gift card"
            : `Charge ${formatMoney(totals.amountDueCents)}`;
  const charge = () => {
    if (lines.length && quoteFailed) { retryQuote(); return; }
    if (deliveryMissing) { setSheet("customer"); return; }
    setCashGiven("");
    setTender(channel === "phone" && !editTarget ? "later" : "cash");
    setSheet("payment");
  };
  // A delivery, or a bill a gift card settled outright, has no money to take
  // at the counter, so it goes straight in from the receipt without the sheet.
  const chargeGoesStraightIn = !editTarget && (fulfilment === "delivery" || (totals.giftCardAppliedCents > 0 && totals.amountDueCents === 0));

  const editableOrders = dashboard.orders.filter((order) => !orderEditRefusal(order));
  const switchFulfilment = (next: "pickup" | "delivery") => {
    setFulfilment(next);
    if (next === "delivery" && (!line1.trim() || !postalCode.trim() || !phone.trim())) setSheet("customer");
  };

  return (
    <fieldset className="pos" disabled={submitting}>
      <header className="pos-bar">
        {onExit ? (
          <button type="button" className="pos-bar-exit" onClick={onExit}>
            <span aria-hidden="true">←</span> Live orders{newOrderCount ? <b className="pos-badge">{newOrderCount}</b> : null}
          </button>
        ) : null}
        <div className="pos-seg" role="group" aria-label="Where the order came from">
          <button type="button" aria-pressed={channel === "walk_in"} disabled={Boolean(editTarget)} onClick={() => setChannel("walk_in")}>Walk-in</button>
          <button type="button" aria-pressed={channel === "phone"} disabled={Boolean(editTarget)} onClick={() => setChannel("phone")}>Phone</button>
        </div>
        <div className="pos-seg" role="group" aria-label="Pickup or delivery">
          <button type="button" aria-pressed={fulfilment === "pickup"} onClick={() => switchFulfilment("pickup")}>Pickup</button>
          <button type="button" aria-pressed={fulfilment === "delivery"} onClick={() => switchFulfilment("delivery")}>Delivery</button>
        </div>
        <button type="button" className={`pos-customer${deliveryMissing ? " pos-customer--needs" : ""}`} onClick={() => setSheet("customer")}>
          <span aria-hidden="true" className="pos-customer-icon">👤</span>
          <span><strong>{customerLabel}</strong><small>{deliveryMissing ? "Add address & phone" : phone ? phone : fulfilment === "delivery" ? `${line1}` : "Customer details"}</small></span>
        </button>
        <input className="pos-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search the menu" aria-label="Search the menu" />
        <button type="button" className="pos-bar-button" onClick={() => { setOrderSearch(""); setSheet("orders"); }}>Edit an order</button>
      </header>

      <div className="pos-body">
        <nav className="pos-cats" aria-label="Menu categories">
          {categories.map((category, index) => (
            <button
              type="button"
              key={category.id}
              className={`pos-cat pos-tone-${index % 6}`}
              aria-pressed={!searching && category.id === shownCategoryId}
              onClick={() => { setCategoryId(category.id); setSearch(""); }}
            >
              {category.name}
            </button>
          ))}
        </nav>

        <section className="pos-menu" aria-label={searching ? "Search results" : "Menu items"}>
          {searching ? <p className="pos-menu-note">{matching.length} result{matching.length === 1 ? "" : "s"} for “{search.trim()}” <button type="button" onClick={() => setSearch("")}>Clear</button></p> : null}
          <div className="pos-items">
            {matching.flatMap((product) => {
              const tone = `pos-tone-${(categoryIndex.get(product.category_id) ?? 0) % 6}`;
              const variations = dashboard.variations.filter((variation) => variation.product_id === product.id && variation.active);
              // Anything with choices to make is one tile that opens the
              // customizer — including a pizza, whose sizes are chosen inside it.
              if (needsCustomizing(product)) {
                const from = variations.length ? Math.min(...variations.map((variation) => variation.base_price_cents)) : product.base_price_cents;
                return [(
                  <button type="button" className={`pos-item ${tone}`} key={product.id} onClick={() => { setBuilding(product); setEditingLine(undefined); }}>
                    <strong>{product.name}</strong>
                    <span className="pos-item-foot"><em>{product.configuration.staffOnly ? "Staff · " : ""}Options ›</em><b>{variations.length > 1 ? `from ${formatMoney(from)}` : formatMoney(from)}</b></span>
                  </button>
                )];
              }
              if (variations.length) {
                return variations.map((variation) => (
                  <button type="button" className={`pos-item ${tone}`} key={variation.id} onClick={() => addPlain(product, variation)}>
                    <strong>{product.name}</strong>
                    <span className="pos-item-foot"><em>{variation.name}</em><b>{formatMoney(variation.base_price_cents)}</b></span>
                  </button>
                ));
              }
              return [(
                <button type="button" className={`pos-item ${tone}`} key={product.id} onClick={() => addPlain(product)}>
                  <strong>{product.name}</strong>
                  <span className="pos-item-foot"><em>{product.configuration.isNew ? "New" : product.configuration.staffOnly ? "Staff only" : ""}</em><b>{formatMoney(product.base_price_cents)}</b></span>
                </button>
              )];
            })}
            {!matching.length ? <div className="pos-empty">No items found. Try another search or category.</div> : null}
          </div>
        </section>

        <aside className="pos-ticket" aria-label="This order">
          <div className={`pos-ticket-head${editTarget ? " pos-ticket-head--edit" : ""}`}>
            <div>
              <h2>{editTarget ? `Editing ${ref}` : "Current order"}</h2>
              <small>
                {editTarget ? `Was ${formatMoney(editTarget.previousTotalCents)} · ` : ""}
                {itemCount} item{itemCount === 1 ? "" : "s"} · {channel === "phone" ? "Phone" : "Walk-in"} · {fulfilment === "delivery" ? "Delivery" : "Pickup"}
              </small>
            </div>
            {dirty ? <button type="button" className="pos-link" onClick={discard}>{editTarget ? "Cancel edit" : "Clear"}</button> : null}
          </div>

          <div className="pos-lines">
            {done && !lines.length ? (
              <div className="pos-done" role="status">
                <strong>✓ {done.note}</strong>
                {done.collectedCents > 0 && done.tender !== "later" ? (
                  <small className="pos-done-paid">Took {formatMoney(done.collectedCents)} by {done.tender === "card" ? "card" : "cash"}</small>
                ) : null}
                {done.changeCents !== null ? (
                  done.changeCents > 0
                    ? <p>Change {formatMoney(done.changeCents)}{done.changeBreakdown ? <small>{done.changeBreakdown}</small> : null}</p>
                    : <p>No change to give</p>
                ) : null}
                {done.refundCents > 0 ? <p>Give back {formatMoney(done.refundCents)}</p> : null}
                {done.printOrder ? (
                  <button
                    type="button"
                    className={done.printPending ? "pos-primary" : "pos-secondary"}
                    onClick={() => {
                      const pending = done.printPending;
                      const next = { ...done, printPending: false };
                      setDone(next); writeDone(next);
                      printTicket(done.printOrder!, Date.now(), pending && done.drawerWithPrint);
                    }}
                  >
                    {done.printPending ? "Print ticket now" : "Print ticket again"}
                  </button>
                ) : null}
              </div>
            ) : null}
            {lines.map((line, index) => {
              const priced = quote?.lines.find((entry) => entry.index === index);
              const selected = selectedLine === line.key;
              return (
                <div className={`pos-line${selected ? " pos-line--selected" : ""}`} key={line.key}>
                  <button type="button" className="pos-line-main" onClick={() => setSelectedLine(selected ? null : line.key)} aria-expanded={selected}>
                    <span className="pos-line-qty">{line.quantity}×</span>
                    <span className="pos-line-name">
                      <strong>{line.name}</strong>
                      {/* Everything chosen, spelled out: a "no onions" that only
                          exists inside the payload gets made with onions. */}
                      {describeChoices(line, toppingNames).map((choice, choiceIndex) => <small key={`${choiceIndex}-${choice}`}>{choice}</small>)}
                    </span>
                    <b>{priced ? formatMoney(priced.lineTotalCents) : "—"}</b>
                  </button>
                  {selected ? (
                    <div className="pos-line-tools">
                      <div className="pos-qty">
                        <button type="button" onClick={() => setQuantity(line.key, -1)} aria-label={`One fewer ${line.name}`}>−</button>
                        <span>{line.quantity}</span>
                        <button type="button" onClick={() => setQuantity(line.key, 1)} aria-label={`One more ${line.name}`}>+</button>
                      </div>
                      <button type="button" onClick={() => editLine(line)}>Change options</button>
                      <button type="button" className="pos-danger" onClick={() => removeLine(line.key)}>Remove</button>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {!lines.length && !done ? <div className="pos-empty">Tap an item to start the order.</div> : null}
          </div>

          <div className="pos-ticket-foot">
            {message ? <p className={message.tone === "bad" ? "pos-msg pos-msg--bad" : "pos-msg"} role="status">{message.text}</p> : null}
            {printFailure ? <p className="pos-msg pos-msg--bad" role="alert">{printFailure} The order is safe — print it from <b>Live orders</b>.</p> : null}

            {lines.length ? (
              <>
                <button type="button" className="pos-link pos-codes-toggle" onClick={() => setShowCodes((value) => !value)} aria-expanded={showCodes}>
                  {showCodes ? "Hide promo & gift card" : couponCode || giftCardCode ? "Promo / gift card applied ›" : "Promo code or gift card ›"}
                </button>
                {showCodes ? (
                  <div className="pos-codes">
                    <div className="pos-code-row">
                      <input value={couponInput} onChange={(event) => setCouponInput(event.target.value.toUpperCase())} placeholder="Promo code" aria-label="Promo code" autoComplete="off" spellCheck={false} />
                      {couponCode
                        ? <button type="button" onClick={() => { setCouponCode(""); setCouponInput(""); }}>Remove</button>
                        : <button type="button" disabled={!couponInput.trim()} onClick={() => setCouponCode(couponInput.trim())}>Apply</button>}
                    </div>
                    {quote?.coupon ? <p className={quote.coupon.accepted ? "coupon-ok" : "coupon-bad"} role="status">{quote.coupon.accepted ? `${quote.coupon.code} applied.` : quote.coupon.message}</p> : null}
                    {editTarget ? null : quote?.giftCard?.accepted ? (
                      <div className="giftcard-applied" role="status">
                        <strong><span aria-hidden="true">✓</span> Gift card ending {quote.giftCard.suffix}</strong>
                        <div><span>Balance on the card</span><b>{formatMoney(quote.giftCard.balanceCents)}</b></div>
                        <div><span>Applied to this order</span><b>−{formatMoney(quote.giftCard.appliedCents)}</b></div>
                        <div><span>Left after this order</span><b>{formatMoney(quote.giftCard.remainingAfterCents)}</b></div>
                        <button type="button" className="text-button" onClick={() => { setGiftCardCode(""); setGiftCardInput(""); }}>Remove gift card</button>
                      </div>
                    ) : (
                      <>
                        <div className="pos-code-row">
                          <input value={giftCardInput} onChange={(event) => setGiftCardInput(event.target.value.toUpperCase())} placeholder="Gift card code" aria-label="Gift card code" autoComplete="off" autoCapitalize="characters" spellCheck={false} />
                          {giftCardCode
                            ? <button type="button" onClick={() => { setGiftCardCode(""); setGiftCardInput(""); }}>Remove</button>
                            : <button type="button" disabled={!giftCardInput.trim()} onClick={() => setGiftCardCode(giftCardInput.trim())}>Apply</button>}
                        </div>
                        {quote?.giftCard && !quote.giftCard.accepted ? <p className="coupon-bad" role="status">{quote.giftCard.message}</p> : null}
                      </>
                    )}
                  </div>
                ) : null}

                <div className="pos-totals">
                  <div><span>Subtotal</span><b>{quoteMoney(totals.menuSubtotalCents)}</b></div>
                  {totals.discountCents > 0 ? <div className="pos-discount"><span>Discount</span><b>−{formatMoney(totals.discountCents)}</b></div> : null}
                  {totals.deliveryFeeCents > 0 ? <div><span>Delivery</span><b>{formatMoney(totals.deliveryFeeCents)}</b></div> : null}
                  {Number(totals.tipCents ?? 0) > 0 ? <div><span>Tip</span><b>{formatMoney(Number(totals.tipCents))}</b></div> : null}
                  <div><span>HST</span><b>{quoteMoney(totals.taxCents)}</b></div>
                  {totals.giftCardAppliedCents > 0 ? <div><span>Gift card</span><b>−{formatMoney(totals.giftCardAppliedCents)}</b></div> : null}
                </div>
                {giveawayShort !== null ? (
                  <p className={giveawayShort === 0 ? "giveaway-hint giveaway-hint--in" : "giveaway-hint"} role="status">
                    {giveawayShort === 0 ? "✓ This order enters the Thanksgiving Giveaway." : `${formatMoney(giveawayShort)} more food (before tax) enters the Thanksgiving Giveaway.`}
                  </p>
                ) : null}
                {blockingIssues.map((issue, index) => <p className="cart-blocker" role="status" key={`${index}-${issue.message}`}>{issue.message}</p>)}
                {quoteFailed ? <p className="pos-msg pos-msg--bad" role="alert">{quoteError}</p> : null}
              </>
            ) : null}

            <button
              type="button"
              className="pos-charge"
              disabled={!lines.length || submitting || (!quoteFailed && !quoteUsable)}
              onClick={() => {
                if (chargeGoesStraightIn && !deliveryMissing && !(lines.length && quoteFailed)) { void submit(Date.now()); return; }
                charge();
              }}
            >
              <span>{chargeLabel}</span>
              {lines.length && !chargeGoesStraightIn && !editTarget && totals.giftCardAppliedCents > 0 ? <small>Total {quoteMoney(totals.totalCents)} · gift card −{formatMoney(totals.giftCardAppliedCents)}</small> : null}
            </button>
            <div className="pos-foot-tools">
              <button type="button" onClick={openCashDrawer}>Open cash drawer</button>
              {done?.printOrder && lines.length ? (
                <button type="button" onClick={() => printTicket(done.printOrder!, Date.now(), false)}>Reprint {done.orderNumber.replace("P62-", "#")}</button>
              ) : null}
            </div>
          </div>
        </aside>
      </div>

      {sheet === "customer" ? (
        <div className="pos-sheet-backdrop" role="presentation" onMouseDown={() => setSheet(null)}>
          <section className="pos-sheet" role="dialog" aria-modal="true" aria-labelledby="pos-customer-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="pos-sheet-head">
              <h2 id="pos-customer-title">Customer</h2>
              <button type="button" className="pos-sheet-close" onClick={() => setSheet(null)} aria-label="Close">×</button>
            </div>
            <div className="pos-form">
              {/* The number comes first: on the phone it is the quickest way to
                  find someone who has ordered before, and picking them fills
                  in the rest. */}
              {editTarget?.contactRedacted ? (
                <p className="pos-hint">Phone and email are hidden for your account; they stay as they were.</p>
              ) : canLookUpCustomers && !editTarget ? (
                <SuggestField<CustomerSuggestion>
                  label={fulfilment === "delivery" ? "Phone · for the driver" : "Phone · optional"}
                  value={phone}
                  onChange={setPhone}
                  url={phone.replace(/\D/g, "").length >= 3 ? `/api/admin/customer-lookup?phone=${encodeURIComponent(phone.replace(/\D/g, ""))}` : null}
                  onPick={(item) => {
                    setPhone(formatPhone(item.phone));
                    if (item.name && !name.trim()) setName(item.name);
                    setHistoryFor(item.phone);
                  }}
                  itemKey={(item) => item.phone}
                  renderItem={(item) => <CustomerSuggestionRow item={item} />}
                  inputProps={{ inputMode: "tel", autoComplete: "off", autoFocus: true, placeholder: "Start typing their number" }}
                />
              ) : (
                <label>{fulfilment === "delivery" ? "Phone · for the driver" : "Phone · optional"}<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" autoFocus /></label>
              )}
              <label>Name for the order<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Counter" /></label>
              {editTarget?.contactRedacted ? null : (
                <label>Email · optional<input value={email} onChange={(event) => setEmail(event.target.value)} inputMode="email" /></label>
              )}
              {fulfilment === "pickup" && !editTarget ? (
                <div className="till-birthday">
                  <span>Birthday · optional</span>
                  <div>
                    <select value={birthMonth} onChange={(event) => setBirthMonth(event.target.value)} aria-label="Birthday month">
                      <option value="">Month</option>
                      {BIRTHDAY_MONTHS.map((label, index) => <option key={label} value={String(index + 1)}>{label}</option>)}
                    </select>
                    <select value={birthDay} onChange={(event) => setBirthDay(event.target.value)} aria-label="Birthday day">
                      <option value="">Day</option>
                      {Array.from({ length: birthMonth ? DAYS_IN_MONTH[Number(birthMonth) - 1] : 31 }, (_, index) => <option key={index + 1} value={String(index + 1)}>{index + 1}</option>)}
                    </select>
                  </div>
                  <small>{birthdayChosen && !birthdayReady ? "Add their phone or email so we can find them on their birthday." : "No year — just so we can treat them on the day."}</small>
                </div>
              ) : null}
              {/* The delivery fee, the radius check and the minimum all key off
                  this, and all three are enforced on the server. */}
              {fulfilment === "delivery" ? (
                <>
                  <SuggestField<AddressSuggestion>
                    label="Street address"
                    value={line1}
                    onChange={setLine1}
                    url={/[a-z]/i.test(line1) && line1.trim().length >= 3 ? `/api/admin/address-suggest?q=${encodeURIComponent(line1.trim())}` : null}
                    onPick={(item) => {
                      setLine1(item.line1);
                      if (item.unit) setUnit(item.unit);
                      // A partial code from Maps is left for the person to
                      // finish rather than written in half-done. A code left
                      // over from a different part of town is cleared, so it
                      // cannot ride along with the new street.
                      setPostalCode((current) => item.postalCode || (item.postalPrefix && current.startsWith(item.postalPrefix) ? current : ""));
                    }}
                    itemKey={(item) => `${item.source}|${item.line1}|${item.unit}|${item.postalCode}`}
                    renderItem={(item) => <AddressSuggestionRow item={item} />}
                    inputProps={{ placeholder: "Start typing: 31 King", autoComplete: "off", spellCheck: false }}
                  />
                  <label>Unit · optional<input value={unit} onChange={(event) => setUnit(event.target.value)} autoComplete="off" /></label>
                  <label>Postal code<input value={postalCode} onChange={(event) => setPostalCode(event.target.value.toUpperCase())} placeholder="L8N 1B2" autoComplete="off" spellCheck={false} /></label>
                  <label>Buzzer or directions · optional<input value={deliveryInstructions} onChange={(event) => setDeliveryInstructions(event.target.value)} autoComplete="off" /></label>
                  <p className="pos-hint">Hamilton, ON only. Pick a suggestion or type the address out; either way it is checked against the delivery radius when the order is sent.</p>
                </>
              ) : null}
            </div>
            <button type="button" className="pos-primary" onClick={() => setSheet(null)}>Done</button>
          </section>
        </div>
      ) : null}

      {historyFor ? (
        <CustomerHistorySheet
          phone={historyFor}
          toppingNames={toppingNames}
          onClose={() => setHistoryFor(null)}
          onUseDetails={applyCustomerDetails}
          onUseAddress={applyCustomerAddress}
          onReorder={reorder}
        />
      ) : null}

      {sheet === "orders" ? (
        <div className="pos-sheet-backdrop" role="presentation" onMouseDown={() => setSheet(null)}>
          <section className="pos-sheet pos-sheet--wide" role="dialog" aria-modal="true" aria-labelledby="pos-orders-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="pos-sheet-head">
              <h2 id="pos-orders-title">Edit an order</h2>
              <button type="button" className="pos-sheet-close" onClick={() => setSheet(null)} aria-label="Close">×</button>
            </div>
            <p className="pos-hint">Orders still owed at the store can be changed until they are completed. Card-paid and gift-card orders are changed from History.</p>
            <input className="pos-order-search" type="search" value={orderSearch} onChange={(event) => setOrderSearch(event.target.value)} placeholder="Order number, name or phone" aria-label="Find an order" autoFocus />
            <div className="pos-order-list">
              {dashboard.orders.filter((order) => {
                const query = orderSearch.trim().toLowerCase().replace(/^#/, "");
                if (!query) return true;
                return `${String(order.order_number).replace("P62-", "")} ${String(order.customer_name ?? "")} ${String(order.customer_phone ?? "")}`.toLowerCase().includes(query);
              }).map((order) => {
                const refusal = orderEditRefusal(order);
                return (
                  <button type="button" key={String(order.id)} className="pos-order-row" disabled={Boolean(refusal)} title={refusal ?? undefined} onClick={() => startEdit(order)}>
                    <b>{String(order.order_number).replace("P62-", "#")}</b>
                    <span>
                      <strong>{String(order.customer_name)}</strong>
                      <small>
                        {String(order.fulfilment) === "delivery" ? "Delivery" : "Pickup"} · {new Date(Number(order.created_at)).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })}
                        {" · "}{((order.items as unknown[]) ?? []).length} item{((order.items as unknown[]) ?? []).length === 1 ? "" : "s"}
                        {refusal ? (String(order.payment_method) === "online" ? " · paid online" : " · can't edit") : ""}
                      </small>
                    </span>
                    <em>{formatMoney(Number(order.total_cents))}</em>
                  </button>
                );
              })}
              {!dashboard.orders.length ? <div className="pos-empty">No active orders right now.</div> : null}
              {dashboard.orders.length && !editableOrders.length ? <div className="pos-empty">None of the active orders can be edited here.</div> : null}
            </div>
          </section>
        </div>
      ) : null}

      {sheet === "payment" ? (
        <div className="pos-sheet-backdrop" role="presentation" onMouseDown={() => { if (!submitting) setSheet(null); }}>
          <section className="pos-sheet pos-sheet--pay" role="dialog" aria-modal="true" aria-labelledby="pos-pay-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="pos-sheet-head">
              <h2 id="pos-pay-title">{editTarget ? `Save changes to ${ref}` : "Payment"}</h2>
              <button type="button" className="pos-sheet-close" onClick={() => setSheet(null)} aria-label="Close" disabled={submitting}>×</button>
            </div>

            {editTarget ? (
              <div className="pos-pay-diff">
                <div><span>Was</span><b>{formatMoney(editTarget.previousTotalCents)}</b></div>
                <div><span>Now</span><b>{formatMoney(totals.totalCents)}</b></div>
                <div className={differenceCents > 0 ? "pos-up" : differenceCents < 0 ? "pos-down" : ""}><span>Difference</span><b>{differenceCents > 0 ? "+" : differenceCents < 0 ? "−" : ""}{formatMoney(Math.abs(differenceCents))}</b></div>
              </div>
            ) : null}

            {editTarget && fulfilment === "pickup" ? (
              <div className="pos-tabs" role="group" aria-label="Has the customer paid already?">
                <button type="button" aria-pressed={alreadyPaid} onClick={() => { setAlreadyPaid(true); setCashGiven(""); }}>Already paid {formatMoney(editTarget.previousTotalCents)}</button>
                <button type="button" aria-pressed={!alreadyPaid} onClick={() => { setAlreadyPaid(false); setCashGiven(""); }}>Not paid yet</button>
              </div>
            ) : null}

            {fulfilment === "delivery" ? (
              <p className="pos-pay-note">Delivery: the driver collects {formatMoney(totals.amountDueCents)} at the door. Nothing is taken at the counter.</p>
            ) : refundCents > 0 ? (
              <div className="pos-pay-due pos-pay-due--refund"><span>Give back</span><b>{formatMoney(refundCents)}</b></div>
            ) : collectCents === 0 ? (
              <p className="pos-pay-note">Nothing more to collect.</p>
            ) : (
              <>
                <div className="pos-pay-due"><span>{editTarget && alreadyPaid ? "Collect the difference" : "Amount due"}</span><b>{formatMoney(collectCents)}</b></div>
                <div className="pos-tabs" role="group" aria-label="How they are paying">
                  <button type="button" aria-pressed={tender === "cash"} onClick={() => setTender("cash")}>Cash</button>
                  <button type="button" aria-pressed={tender === "card"} onClick={() => { setTender("card"); setCashGiven(""); }}>Card</button>
                  {channel === "phone" || (editTarget && !alreadyPaid) ? <button type="button" aria-pressed={tender === "later"} onClick={() => { setTender("later"); setCashGiven(""); }}>Pay at pickup</button> : null}
                </div>
                {tender === "cash" && cashRounded ? (
                  <div className="pos-cash">
                    {cashRounded.roundingCents !== 0 ? <p className="pos-hint">Cash rounds to {formatMoney(cashRounded.roundedTotalCents)} — there is no penny.</p> : null}
                    <div className="pos-quick">
                      {quickTenders.map((amount) => (
                        <button type="button" key={amount} aria-pressed={tenderedCents === amount} onClick={() => setCashGiven((amount / 100).toFixed(2))}>
                          {amount === cashRounded.roundedTotalCents ? <><small>Exact</small>{formatMoney(amount)}</> : formatMoney(amount)}
                        </button>
                      ))}
                    </div>
                    <label className="pos-cash-input">Cash received · C$
                      <input inputMode="decimal" value={cashGiven} onChange={(event) => setCashGiven(event.target.value)} placeholder="0.00" aria-label="Cash received" />
                    </label>
                    {cashGiven.trim() && tenderedCents === null ? <p className="pos-msg pos-msg--bad" role="alert">Enter a valid cash amount, such as 20 or 20.00.</p> : null}
                    {cash ? (
                      cash.shortCents > 0
                        ? <p className="pos-msg pos-msg--bad" role="status">{formatMoney(cash.shortCents)} still to come.</p>
                        : (
                          <div className="pos-change" role="status">
                            <div><span>Change to give</span><b>{formatMoney(cash.changeCents)}</b></div>
                            <p>{cash.breakdown.length ? cash.breakdown.map((part) => `${part.count} × ${part.label}`).join(" · ") : "Nothing to hand back."}</p>
                          </div>
                        )
                    ) : null}
                  </div>
                ) : tender === "card" ? (
                  <p className="pos-pay-note">Run {formatMoney(collectCents)} on the card machine, then tap below.</p>
                ) : (
                  <p className="pos-pay-note">The customer pays {formatMoney(collectCents)} when they pick up. The drawer stays shut.</p>
                )}
              </>
            )}

            {message?.tone === "bad" ? <p className="pos-msg pos-msg--bad" role="alert">{message.text}</p> : null}
            <button
              type="button"
              className="pos-primary pos-pay-go"
              disabled={submitting || !quoteUsable || invalidTender}
              onClick={() => { void submit(Date.now()); }}
            >
              {submitting
                ? editTarget ? "Saving…" : "Sending…"
                : editTarget
                  ? drawerOpens ? "Save changes & print · opens drawer" : "Save changes & print"
                  : tenderUsed === "later"
                    ? "Send & print · pay at pickup"
                    : "Take payment & print"}
            </button>
            <small className="pos-pay-foot">
              {drawerOpens ? "Opens the cash drawer and prints the ticket." : "Prints the ticket. The drawer stays shut."}
            </small>
          </section>
        </div>
      ) : null}

      {/* The same customizer the website mounts, over the till. `key` is the
          product id so switching straight from one product to another starts a
          fresh build rather than reusing the last one's state. */}
      {building && active ? (
        building.product_type === "pizza" ? (
          <PizzaCustomizer
            key={editingLine?.key ?? building.id}
            product={building}
            variations={buildingVariations}
            toppings={activeToppings}
            halfToppingUnitsBps={halfToppingUnitsBps}
            initialItem={editingLine}
            onSave={editingLine ? saveLine : undefined}
            onClose={closeBuilder}
            onAdd={add}
          />
        ) : (
          <GenericCustomizer
            key={editingLine?.key ?? building.id}
            product={building}
            toppings={activeToppings}
            halfToppingUnitsBps={halfToppingUnitsBps}
            initialItem={editingLine}
            onSave={editingLine ? saveLine : undefined}
            onClose={closeBuilder}
            onAdd={add}
          />
        )
      ) : null}
    </fieldset>
  );
}
