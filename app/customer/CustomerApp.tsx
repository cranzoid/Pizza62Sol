"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { BrandLogo } from "@/app/BrandLogo";
import { CloverCardForm, type CloverCardFormHandle } from "@/app/customer/CloverCardForm";
import { useDialogBehavior } from "@/app/useDialogBehavior";
import {
  GenericCustomizer,
  PizzaCustomizer,
  placementSuffix,
  toOrderItems,
  type BuiltItem,
  type CustomizerProduct,
  type CustomizerTopping,
  type CustomizerVariation,
} from "@/app/menu/ItemCustomizer";
import {
  formatMoney,
  isWithinWeeklyAvailability,
  nextOrderSlots,
  storeStatus,
  zonedParts,
  type StoreStatus,
  type WeeklyHours,
  type StoreClosure,
  type WeeklyAvailability,
} from "@/lib/domain";

type Category = { id: string; name: string; slug: string; description?: string | null };
/**
 * The catalogue rows the storefront reads, on top of what a customizer needs.
 *
 * `image_url` and the two eligibility flags are the menu page's business —
 * whether to show a picture, and whether an item survives switching to delivery.
 * The customizer neither knows nor cares, so its own types stay narrower and the
 * staff dashboard's rows satisfy them too.
 */
type Product = CustomizerProduct & {
  image_url?: string | null;
  pickup_eligible: number;
  delivery_eligible: number;
};
type Variation = CustomizerVariation;
type Topping = CustomizerTopping;
type Catalog = {
  categories: Category[];
  products: Product[];
  variations: Variation[];
  toppings: Topping[];
  settings: Record<string, { value: Record<string, unknown>; version: number }>;
  closures: StoreClosure[];
  integrations: {
    clover: boolean;
    email: boolean;
    /**
     * Present and enabled once Clover is configured for inline card entry. The
     * public token is safe to ship to the browser — it identifies the merchant to
     * Clover's SDK and cannot move money on its own.
     */
    cloverIframe?: { enabled: boolean; publicToken?: string; merchantId?: string; sandbox?: boolean };
  };
};
/** A line in the bag is one built item, with a quantity the shopper controls. */
type CartLine = BuiltItem;

/**
 * The server's price for the current cart (H-24).
 *
 * Mirrors `OrderQuote` in lib/order-service.ts. The browser deliberately does no
 * pricing of its own any more: it used to run its own copy of the discount and
 * HST arithmetic and label the result "estimated", which is the shape of problem
 * where a customer agrees to one number and is charged another.
 */
type Quote = {
  ok: boolean;
  totals: {
    menuSubtotalCents: number;
    discountCents: number;
    discountedMenuSubtotalCents: number;
    taxableSubtotalCents: number;
    nonTaxableSubtotalCents: number;
    taxCents: number;
    deliveryFeeCents: number;
    tipCents: number;
    totalCents: number;
  };
  taxRateBps: number;
  deliveryFeeTaxable: boolean;
  appliedPromotions: Array<{ id: string; name: string; discountCents: number }>;
  coupon: { code: string; accepted: boolean; message: string | null } | null;
  delivery: { minimumCents: number; shortfallCents: number; feeCents: number; meetsMinimum: boolean } | null;
  estimateMinutes: number;
  issues: Array<{ index: number | null; productId: string | null; code: string; message: string }>;
};

const EMPTY_TOTALS: Quote["totals"] = {
  menuSubtotalCents: 0,
  discountCents: 0,
  discountedMenuSubtotalCents: 0,
  taxableSubtotalCents: 0,
  nonTaxableSubtotalCents: 0,
  taxCents: 0,
  deliveryFeeCents: 0,
  tipCents: 0,
  totalCents: 0,
};


/**
 * Keeps a server quote in step with the cart.
 *
 * Debounced, because it re-runs on every tip tap and every keystroke of a promo
 * code. Responses are sequenced so a slow earlier request cannot overwrite a
 * newer answer — without that, changing the tip twice quickly can leave the
 * screen showing the price for the first tip.
 */
function useOrderQuote(input: {
  cart: CartLine[];
  fulfilment: "pickup" | "delivery";
  tip?: { type: "none" } | { type: "percentage"; valueBps: number } | { type: "custom"; amountCents: number };
  couponCode?: string;
  schedule?: { type: "asap" | "scheduled"; scheduledFor?: number };
  enabled?: boolean;
}): { quote: Quote | null; loading: boolean; failed: boolean } {
  const { cart, fulfilment, tip, couponCode, schedule, enabled = true } = input;
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // Serialised so the body is a stable dependency rather than a new object each
  // render, which would re-fetch forever.
  const body = JSON.stringify({ fulfilment, items: toOrderItems(cart), tip, couponCode, schedule });
  const empty = cart.length === 0;

  useEffect(() => {
    // An empty or disabled cart is handled by *deriving* the result below rather
    // than by resetting state here — clearing it in the effect body would be a
    // synchronous setState on every such render, and a cascade of them.
    if (!enabled || empty) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      // Flipped inside the debounce, not in the effect body: no synchronous
      // setState on every keystroke, and "Updating…" appears only when a request
      // is actually about to go out rather than flickering on every character.
      setLoading(true);
      void (async () => {
        try {
          const response = await fetch("/api/orders/quote", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
          const result = (await response.json()) as Quote & { error?: string };
          if (cancelled) return;
          if (!response.ok) {
            setFailed(true);
            setQuote(null);
          } else {
            setFailed(false);
            setQuote(result);
          }
        } catch {
          if (!cancelled) setFailed(true);
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [body, enabled, empty]);

  // Derived, not stored: an empty cart has no quote by definition, and a stale
  // one from before the last item was removed must never be shown as current.
  if (!enabled || empty) return { quote: null, loading: false, failed: false };
  return { quote, loading, failed };
}

const FALLBACK_PHONE = "(905) 547-5777";

const DEFAULT_PROMISES = [
  { title: "Built your way", text: "Simple topping selection" },
  { title: "Clear totals", text: "No surprise math at checkout" },
  { title: "Local & direct", text: "Order straight from Pizza 62" },
  { title: "Track every step", text: "Private, secure order updates" },
];

const HOMEPAGE_OFFER_CATEGORY_IDS = new Set(["hamilton-heroes", "pickup-specials", "deals"]);

function formatMinuteTime(value: number) {
  if (value === 1440) return "Midnight";
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  const displayHour = hour % 12 || 12;
  return `${displayHour}${minute ? `:${String(minute).padStart(2, "0")}` : ""} ${hour < 12 ? "AM" : "PM"}`;
}

/** "45m", "3h 20m", "2d 4h" — how long until the restaurant opens. */
function countdown(milliseconds: number) {
  const total = Math.max(0, Math.round(milliseconds / 60_000));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Set once the visitor has actually been asked delivery-or-pickup this visit.
 *
 * Session-scoped, not local: the answer is good for as long as the tab is open,
 * and the next visit asks again. A customer who ordered delivery on Friday is
 * not committed to delivery on Saturday just because the browser remembered.
 */
const METHOD_ASKED_KEY = "p62_fulfilment_asked";

function alreadyAskedMethod(): boolean {
  // "Asked" on the server, so the markup React hydrates never contains the
  // prompt. Nothing is lost: the prompt waits for the catalogue, which arrives
  // from a fetch long after hydration.
  if (typeof window === "undefined") return true;
  return window.sessionStorage.getItem(METHOD_ASKED_KEY) === "1";
}

function rememberedFulfilment(): "pickup" | "delivery" {
  if (typeof window === "undefined") return "pickup";
  return window.localStorage.getItem("p62_fulfilment") === "delivery"
    ? "delivery"
    : "pickup";
}

function rememberedCart(): CartLine[] {
  if (typeof window === "undefined") return [];
  const value = window.localStorage.getItem("p62_cart_draft");
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as CartLine[]) : [];
  } catch {
    return [];
  }
}

function analytics(eventName: string, context: Record<string, unknown> = {}) {
  const sessionId = getSessionId();
  void fetch("/api/analytics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventName, sessionId, context }),
    keepalive: true,
  });
}

function getSessionId() {
  if (typeof window === "undefined") return "";
  const key = "p62_analytics_session";
  let value = sessionStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID();
    sessionStorage.setItem(key, value);
  }
  return value;
}

function PizzaMark({ large = false }: { large?: boolean }) {
  return (
    <span className={`pizza-mark ${large ? "pizza-mark--large" : ""}`} aria-hidden="true">
      <span>62</span>
      <i className="pizza-dot pizza-dot--one" />
      <i className="pizza-dot pizza-dot--two" />
      <i className="pizza-dot pizza-dot--three" />
    </span>
  );
}

function ArrowIcon() {
  return <span aria-hidden="true">↗</span>;
}

export default function CustomerApp() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadingError, setLoadingError] = useState("");
  const [chosenFulfilment, setFulfilment] = useState<"pickup" | "delivery">(rememberedFulfilment);
  const [deliveryGate, setDeliveryGate] = useState(false);
  const [postalCode, setPostalCode] = useState("");
  const [gateMessage, setGateMessage] = useState("");
  const [cart, setCart] = useState<CartLine[]>(rememberedCart);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<Record<string, unknown> | null>(null);
  const menuRef = useRef<HTMLElement>(null);

  useEffect(() => {
    fetch("/api/catalog")
      .then(async (response) => {
        if (!response.ok) throw new Error("Menu unavailable");
        return response.json() as Promise<Catalog>;
      })
      .then(setCatalog)
      .catch(() => setLoadingError("We couldn't load the live menu. Please try again or call the store."));
    analytics("website_visit");
  }, []);

  const business = catalog?.settings.business?.value ?? {};
  const phone = (business.phone as string | undefined) ?? FALLBACK_PHONE;
  const businessName = String(business.name ?? "Pizza 62");
  const businessAddress = String(business.address ?? "55 Parkdale Ave N, Hamilton, ON L8H 5W7");
  const ordering = catalog?.settings.ordering?.value ?? {};
  // Only read for the delivery-or-pickup prompt, so the customer is choosing
  // against the real fee rather than being shown it after the cart is built.
  const deliveryFeeCents = Number(catalog?.settings.delivery?.value.feeCents ?? 350);

  // Which methods the restaurant is actually taking. `!== false` rather than a
  // truthiness check so a settings row that predates a flag still offers both,
  // which is what the storefront did before the flag existed.
  const pickupEnabled = ordering.pickupEnabled !== false;
  const deliveryEnabled = ordering.deliveryEnabled !== false;

  // A remembered method the restaurant has since switched off is corrected here
  // rather than left to be discovered at checkout. Derived rather than written
  // back to state so there is one answer, not a stored one racing a rendered one.
  const fulfilment: "pickup" | "delivery" =
    !deliveryEnabled && pickupEnabled ? "pickup" : !pickupEnabled && deliveryEnabled ? "delivery" : chosenFulfilment;

  useEffect(() => {
    window.localStorage.setItem("p62_fulfilment", fulfilment);
    window.localStorage.setItem("p62_cart_draft", JSON.stringify(cart));
  }, [fulfilment, cart]);

  const operations = catalog?.settings.operations?.value ?? {};
  const content = catalog?.settings.content?.value ?? {};
  const logoUrl = String(content.logoUrl ?? "");
  // Everything below is owner-controlled from the website editor; each falls back
  // to the built-in wording so an empty field never blanks the page.
  const theme = Object.fromEntries(
    ([["themePrimary", "--red"], ["themeAccent", "--yellow"], ["themeInk", "--ink"], ["themeSurface", "--paper"]] as const)
      .filter(([key]) => /^#[0-9a-fA-F]{6}$/.test(String(content[key] ?? "")))
      .map(([key, variable]) => [variable, String(content[key])]),
  ) as CSSProperties;
  const sectionOrder = (Array.isArray(content.sectionOrder) && content.sectionOrder.length
    ? content.sectionOrder.map(String)
    : ["promises", "menu", "deal", "hours"]).filter((id) => ["promises", "menu", "deal", "hours"].includes(id));
  const sectionVisible = (id: string) => id === "menu" || content[`show_${id}`] === undefined || Boolean(content[`show_${id}`]);
  const promises = (Array.isArray(content.promises) ? content.promises : [])
    .map((entry) => entry as { title?: string; text?: string })
    .concat(DEFAULT_PROMISES)
    .slice(0, 4)
    .map((entry, index) => ({
      title: String(entry?.title || DEFAULT_PROMISES[index].title),
      text: String(entry?.text || DEFAULT_PROMISES[index].text),
    }));
  const heroImageUrl = String(content.heroImageUrl ?? "");
  // How much of the included-topping allowance a half topping consumes, owner-set.
  const halfToppingUnitsBps = Number(operations.halfToppingUnitsBps ?? 10_000);
  const hours = useMemo<WeeklyHours>(
    () => (Array.isArray(catalog?.settings.hours?.value) ? catalog.settings.hours.value as unknown as WeeklyHours : []),
    [catalog],
  );
  const timeZone = String(business.timeZone ?? "America/Toronto");
  // A minute-resolution clock so the open/closed state and the countdown stay live
  // for someone who leaves the page open across opening or closing time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  // H-08/H-10: the banner answers "can I order right now", which is not the same
  // question as "are the lights on". A closure overrides the weekly schedule, and
  // the last-order cutoff closes ordering before the door shuts — a kitchen that
  // closes at 22:00 cannot start a pizza at 21:59.
  // Memoised, not `catalog?.closures ?? []`: the fallback allocates a new array
  // on every render, which would make the store-status memo below recompute
  // continuously and re-render the whole page on each tick.
  const closures = useMemo(() => catalog?.closures ?? [], [catalog]);
  const lastOrderCutoffMinutes = Number(ordering.lastOrderCutoffMinutes ?? 0);
  const store = useMemo(
    () => storeStatus(now, hours, timeZone, { closures, fulfilment, lastOrderCutoffMinutes }),
    [now, hours, timeZone, closures, fulfilment, lastOrderCutoffMinutes],
  );
  // Counts down to the cutoff, not to closing. Shown only inside the last hour,
  // because a countdown that runs all day is wallpaper rather than information.
  const orderingEndsIn = store.acceptingUntil && store.acceptingUntil > now && store.acceptingUntil - now < 60 * 60_000
    ? countdown(store.acceptingUntil - now)
    : "";
  const [closedNoticeDismissed, setClosedNoticeDismissed] = useState(false);
  const showClosedNotice = Boolean(catalog) && !store.open && !closedNoticeDismissed;

  // The site used to open on pickup — inherited from a previous visit, or just
  // the default — and say so only in small type beside the estimate. A customer
  // who meant to order delivery could reach the payment step before the
  // difference showed up as an address form and a fee. Ask instead, so the
  // method is chosen rather than assumed.
  const [methodAsked, setMethodAsked] = useState(alreadyAskedMethod);

  // Behind the closed notice: a customer who arrives after hours needs to be
  // told the kitchen is shut before being asked how they want the food.
  const showMethodPrompt =
    Boolean(catalog) && !methodAsked && !showClosedNotice && pickupEnabled && deliveryEnabled;
  const deliveryDialogRef = useDialogBehavior<HTMLFormElement>(deliveryGate, () => setDeliveryGate(false));
  const closedDialogRef = useDialogBehavior<HTMLDivElement>(showClosedNotice, () => setClosedNoticeDismissed(true));
  const opensIn = store.changesAt ? countdown(store.changesAt - now) : "";
  const opensAtLabel = store.changesAt
    ? new Date(store.changesAt).toLocaleString("en-CA", { weekday: "long", hour: "numeric", minute: "2-digit", timeZone })
    : "";
  const categories = catalog?.categories ?? [];
  const eligibleProducts = (catalog?.products ?? []).filter((product) =>
    fulfilment === "pickup" ? product.pickup_eligible : product.delivery_eligible,
  );
  const homepageOffers = (catalog?.products ?? [])
    .filter((product) => HOMEPAGE_OFFER_CATEGORY_IDS.has(product.category_id))
    .map((product) => {
      const availability = product.configuration.availability as WeeklyAvailability | undefined;
      return { product, availability, availableNow: isWithinWeeklyAvailability(availability, new Date(now)) };
    })
    .sort((left, right) => {
      const priority = (offer: typeof left) => offer.availability
        ? (offer.availableNow ? 0 : 3)
        : offer.product.category_id === "pickup-specials" ? 1 : 2;
      return priority(left) - priority(right);
    });
  const cartItemCount = cart.reduce((sum, line) => sum + line.quantity, 0);

  // H-24: the cart's totals come from the server, priced by the same code that
  // will charge the card. The browser used to run its own copy of the discount
  // and HST arithmetic here and call the answer "estimated"; two implementations
  // of tax drift, and when they do the customer is charged something they never
  // agreed to. There is now one implementation, and it lives on the server.
  const { quote: cartQuote, loading: cartQuoteLoading } = useOrderQuote({ cart, fulfilment });

  const chooseFulfilment = (next: "pickup" | "delivery") => {
    setFulfilment(next);
    setDeliveryGate(next === "delivery");
    setGateMessage("");
    analytics("fulfilment_selected", { fulfilment: next });
    if (next === "pickup") {
      window.setTimeout(() => menuRef.current?.scrollIntoView({ behavior: "smooth" }), 80);
    }
  };

  /**
   * Closes the delivery-or-pickup prompt, with or without an answer.
   *
   * Dismissing it counts as asked — the question has been put in front of the
   * customer, and a dialog that cannot be closed is worse than the problem it
   * solves. The method stays visible in the hero and above the menu either way.
   */
  const answerMethodPrompt = (next?: "pickup" | "delivery") => {
    window.sessionStorage.setItem(METHOD_ASKED_KEY, "1");
    setMethodAsked(true);
    if (next) chooseFulfilment(next);
  };

  const methodDialogRef = useDialogBehavior<HTMLDivElement>(showMethodPrompt, () => answerMethodPrompt());

  const screenPostalCode = () => {
    const normalized = postalCode.toUpperCase().replace(/\s/g, "");
    if (!/^[A-Z][0-9][A-Z][0-9][A-Z][0-9]$/.test(normalized)) {
      setGateMessage("Enter a complete Canadian postal code, like L8K 4S2.");
      return;
    }
    setGateMessage("Thanks. Enter your full Hamilton address at checkout; the restaurant confirms delivery coverage when your order is received.");
    analytics("delivery_eligibility_checked", { result: "potential" });
    window.setTimeout(() => {
      setDeliveryGate(false);
      menuRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 700);
  };

  const addLine = (line: CartLine) => {
    setCart((current) => [...current, line]);
    setCartOpen(true);
    analytics("add_to_cart", { productId: line.productId, quantity: line.quantity });
  };

  const addSimple = (product: Product) => {
    if (product.setup_required || product.sold_out) return;
    addLine({
      key: crypto.randomUUID(),
      productId: product.id,
      name: product.name,
      categoryId: product.category_id,
      quantity: 1,
      unitPriceCents: product.base_price_cents,
      taxable: Boolean(product.taxable),
      freeDelivery: Boolean(product.configuration.freeDelivery),
    });
  };

  const openProduct = (product: Product) => {
    analytics("product_viewed", { productId: product.id });
    const sections = product.configuration.sections;
    if (product.product_type === "pizza" || (Array.isArray(sections) && sections.length)) {
      setSelectedProduct(product);
    } else addSimple(product);
  };

  const openOffer = (product: Product) => {
    // Pickup-only offers stay visible even if a returning visitor last selected
    // delivery. Selecting one makes the necessary fulfilment change explicit and
    // prevents a valid special from failing later when the cart is quoted.
    if (product.pickup_eligible && !product.delivery_eligible) setFulfilment("pickup");
    openProduct(product);
  };

  const siteSections: Record<string, React.ReactNode> = {
    promises: <>
        <section className="promise-strip" aria-label={`${businessName} ordering promises`}>
          {promises.map((promise, index) => <div key={promise.title}><b>0{index + 1}</b><span><strong>{promise.title}</strong><small>{promise.text}</small></span></div>)}
        </section>
    </>,
    menu: <>
        <section className="menu-section" id="menu" ref={menuRef}>
          <div className="section-heading">
            <div><p className="eyebrow dark"><span /> The menu</p><h2>What are you<br /><em>craving?</em></h2></div>
            <div className="menu-context">
              <span>Ordering for</span>
              <div className="segmented-control" role="group" aria-label="Ordering method">
                <button type="button" aria-pressed={fulfilment === "pickup"} className={fulfilment === "pickup" ? "active" : ""} onClick={() => chooseFulfilment("pickup")}>Pickup</button>
                <button type="button" aria-pressed={fulfilment === "delivery"} className={fulfilment === "delivery" ? "active" : ""} onClick={() => chooseFulfilment("delivery")}>Delivery</button>
              </div>
            </div>
          </div>
          {loadingError ? <div className="error-banner" role="alert">{loadingError}</div> : null}
          {!catalog && !loadingError ? <div className="menu-loading" role="status"><span />Loading the live menu…</div> : null}
          <nav className="category-tabs" aria-label="Menu categories">
            {categories.map((category) => <a key={category.id} href={`#category-${category.id}`}>{category.name}</a>)}
          </nav>
          {categories.map((category, categoryIndex) => {
            const products = eligibleProducts.filter((product) => product.category_id === category.id);
            if (!products.length) return null;
            return (
              <div className="menu-category" id={`category-${category.id}`} key={category.id}>
                <div className="category-title"><span>0{categoryIndex + 1}</span><h3>{category.name}</h3><i /></div>
                <div className="product-grid">
                  {products.map((product, index) => {
                    const availability = product.configuration.availability as WeeklyAvailability | undefined;
                    const availableNow = isWithinWeeklyAvailability(availability);
                    return (
                    <article className={`product-card product-card--${(index % 4) + 1}`} key={product.id}>
                      <div className={`product-visual ${product.image_url ? "product-visual--image" : ""}`} style={product.image_url ? { backgroundImage: `url(${product.image_url})` } : undefined} aria-hidden="true">
                        {!product.image_url ? (product.product_type === "pizza" ? <div className="mini-pizza"><i /><i /><i /><i /></div> : product.product_type === "bundle" ? <div className="deal-type">DEAL<br />{String(index + 1).padStart(2, "0")}</div> : <div className="dip-cup">62</div>) : null}
                        {product.setup_required ? <span className="setup-ribbon">Setup required</span> : !availableNow ? <span className="setup-ribbon">{availability?.label ?? "Limited hours"}</span> : null}
                      </div>
                      <div className="product-content">
                        <div className="product-kicker">{product.product_type === "bundle" ? "Family favourite" : product.product_type === "pizza" ? "Make it yours" : "The essentials"}</div>
                        <h4>{product.name}</h4>
                        <p>{product.description}</p>
                        <div className="product-footer"><span><small>{product.product_type === "pizza" ? "from" : ""}</small>{formatMoney(product.base_price_cents)}</span>
                          <button disabled={Boolean(product.setup_required || product.sold_out || !availableNow)} onClick={() => openProduct(product)}>
                            {product.sold_out ? "Sold out" : product.setup_required ? "Owner setup" : !availableNow ? "Offer closed" : product.product_type === "simple" && !Array.isArray(product.configuration.sections) ? "Add" : "Customize"}<ArrowIcon />
                          </button>
                        </div>
                      </div>
                    </article>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </section>
    </>,
    deal: <>
        <section className="deal-feature" id="deals">
          <div className="deal-stamp">{String(content.dealBadge ?? "PICKUP ONLY").split(" ").map((word, index) => index === 0 ? <span key={word}>{word}<br /></span> : <b key={word}>{word}</b>)}</div>
          <div className="deal-copy"><p className="eyebrow"><span /> {String(content.dealEyebrow ?? "Pick it up & save")}</p><h2>{String(content.dealHeadline ?? "Two large. Six toppings.")}</h2><p>{String(content.dealDescription ?? "Split all six included toppings across both pizzas any way you want.")}</p></div>
          <div className="deal-price"><span>ONLY</span><strong>{String(content.dealPriceLabel ?? "$27.99")}</strong><a className="primary-button" href={`#category-${String(content.dealTargetCategoryId ?? "pickup-specials")}`}>Choose this deal <ArrowIcon /></a></div>
        </section>
    </>,
    hours: <>
        <section className="hours-section" id="hours">
          <div><p className="eyebrow dark"><span /> Hamilton&apos;s neighbourhood pizza</p><h2>Hot, local,<br /><em>ready when you are.</em></h2><p>Pickup at {businessAddress} or choose delivery and enter your Hamilton address at checkout.</p><a href={`tel:${phone.replace(/[^0-9+]/g, "")}`}>Call {phone} <ArrowIcon /></a></div>
          <div className="hours-card"><div className="hours-card-title"><span>Weekly hours</span><i>Hamilton time</i></div>
            {hours.map((entry) => <div className="hours-row" key={entry.weekday}><span>{entry.label}</span><b>{formatMinuteTime(entry.openMinute)} – {formatMinuteTime(entry.closeMinute)}</b></div>)}
            <small>Online orders are accepted until the configured closing time.</small>
          </div>
        </section>
    </>,
  };

  return (
    <div className="customer-site" style={theme}>
      <a className="skip-link" href="#menu">Skip to menu</a>
      {content.announcementEnabled && String(content.announcementText ?? "").trim() ? (
        <div className="announcement-bar">
          {String(content.announcementHref ?? "").trim()
            ? <a href={String(content.announcementHref)}>{String(content.announcementText)}</a>
            : <span>{String(content.announcementText)}</span>}
        </div>
      ) : null}
      {catalog && !store.open ? (
        <div className="closed-strip" role="status">
          <span className="closed-clock" aria-hidden="true">{store.changesAt ? opensIn : "—"}</span>
          <span><strong>We&apos;re closed right now.</strong> {store.changesAt ? `Opens ${opensAtLabel}.` : "Opening hours are not set."} You can still order ahead.</span>
          <button onClick={() => { setClosedNoticeDismissed(true); menuRef.current?.scrollIntoView({ behavior: "smooth" }); }}>Order for later</button>
        </div>
      ) : null}
      <header className="public-header">
        <a className="brand" href="#top" aria-label={`${businessName} home`}>
          <BrandLogo src={logoUrl} name={businessName} />
          <span className="brand-copy"><small>Hamilton, Ontario</small></span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#offers">Offers</a>
          <a href="#menu">Menu</a>
          <a href="#hours">Hours</a>
          <Link href="/track">Track order</Link>
        </nav>
        <div className="header-actions">
          <nav className="header-shortcuts" aria-label="Mobile navigation">
            <a href="#offers">Offers</a>
            <a href="#menu">Menu</a>
            <Link href="/track">Track</Link>
          </nav>
          <a className="phone-link" href={`tel:${phone.replace(/[^0-9+]/g, "")}`}>{phone}</a>
          <button className="cart-pill" onClick={() => setCartOpen(true)} aria-label={`Open cart with ${cartItemCount} item${cartItemCount === 1 ? "" : "s"}`}>
            <span>Bag</span><b>{cartItemCount}</b>
          </button>
        </div>
      </header>

      <main id="top">
        <section className="offers-first" id="offers" aria-labelledby="offers-title">
          <div className="offers-first__heading">
            <div>
              <p className="eyebrow dark"><span /> Today at Pizza 62</p>
              <h2 id="offers-title">Start with<br /><em>a special.</em></h2>
            </div>
            <p>See today&apos;s available specials first, plus the ongoing pickup and family offers configured in our live menu.</p>
          </div>
          {!catalog && !loadingError ? <div className="offers-loading" role="status"><span />Loading today&apos;s offers…</div> : null}
          {loadingError ? <div className="error-banner" role="alert">Offers are temporarily unavailable. The rest of the site is still available below.</div> : null}
          {catalog && homepageOffers.length ? (
            <div className="offers-track" aria-label="Current offers">
              {homepageOffers.map(({ product, availability, availableNow }) => {
                const pickupOnly = Boolean(product.pickup_eligible && !product.delivery_eligible);
                const categoryName = categories.find((category) => category.id === product.category_id)?.name ?? "Offer";
                const unavailable = Boolean(product.setup_required || product.sold_out || (availability && !availableNow));
                const badge = availability
                  ? (availableNow ? "Available today" : String(availability.label ?? "Limited hours"))
                  : pickupOnly ? "Pickup special" : categoryName;
                return (
                  <article className={`offer-card ${availability && availableNow ? "offer-card--today" : ""}`} key={product.id}>
                    <div className="offer-card__meta"><span>{badge}</span><small>{pickupOnly ? "Pickup only" : "Pickup or delivery"}</small></div>
                    <h3>{product.name}</h3>
                    <p>{product.description}</p>
                    <div className="offer-card__footer">
                      <strong><small>from</small>{formatMoney(product.base_price_cents)}</strong>
                      <button type="button" disabled={unavailable} onClick={() => openOffer(product)}>
                        {product.sold_out ? "Sold out" : product.setup_required ? "Owner setup" : availability && !availableNow ? "Not available now" : pickupOnly && fulfilment === "delivery" ? "Switch to pickup" : "Choose offer"}<ArrowIcon />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}
          <a className="offers-first__all" href="#category-deals">See the complete deals menu <ArrowIcon /></a>
        </section>

        <section className="hero-section">
          <div className="hero-grain" aria-hidden="true" />
          <div className="hero-copy">
            <p className="eyebrow"><span /> {String(content.heroEyebrow ?? "Hamilton-made since the first slice")}</p>
            <h1>{String(content.heroHeadline ?? "Big flavour.")}<br /><em>{String(content.heroAccent ?? "Zero fuss.")}</em></h1>
            <p className="hero-lede">{String(content.heroDescription ?? "Hot pizza, honest prices, and the kind of local service that remembers your order.")}</p>
            <div className="hero-method" role="group" aria-label="Choose how to get your order">
              <button aria-pressed={fulfilment === "delivery"} className={fulfilment === "delivery" ? "active" : ""} onClick={() => chooseFulfilment("delivery")}>
                <span className="method-icon">D</span><span><b>Delivery</b><small>About {String(ordering.deliveryEstimateMinutes ?? 30)} min</small></span><ArrowIcon />
              </button>
              <button aria-pressed={fulfilment === "pickup"} className={fulfilment === "pickup" ? "active" : ""} onClick={() => chooseFulfilment("pickup")}>
                <span className="method-icon">P</span><span><b>Pickup</b><small>About {String(ordering.pickupEstimateMinutes ?? 15)} min</small></span><ArrowIcon />
              </button>
            </div>
            <div className="hero-note"><span className={`pulse-dot ${store.open ? "" : "pulse-dot--closed"}`} /> {
              ordering.paused ? String(ordering.pauseMessage ?? "Online ordering is temporarily paused")
              // A closure explains itself. Falling back to the weekly schedule
              // here would tell a customer the store opens at 11 on a day it is
              // shut all day, which is worse than saying nothing.
              : store.closure ? `${store.closure.scope === "delivery" ? "Delivery closed" : store.closure.scope === "pickup" ? "Pickup closed" : "Closed"} · ${store.closure.reason}${store.changesAt ? ` · back ${new Date(store.changesAt).toLocaleString("en-CA", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone })}` : ""}`
              : store.open ? `Open now${orderingEndsIn ? ` · last orders in ${orderingEndsIn}` : store.changesAt ? ` · until ${new Date(store.changesAt).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone })}` : ""}`
              // Past the cutoff the doors are open but the kitchen has stopped.
              // Saying "closed" would be a lie a customer standing outside can see.
              : store.acceptingUntil ? "Last orders have gone in for tonight · order ahead for tomorrow"
              : `Closed · opens ${opensAtLabel}${opensIn ? ` (in ${opensIn})` : ""}`
            }</div>
          </div>
          <div className={`hero-art ${heroImageUrl ? "hero-art--photo" : ""}`} role="img" style={heroImageUrl ? { backgroundImage: `url(${heroImageUrl})` } : undefined} aria-label={heroImageUrl ? `${businessName} food photograph` : "A playful illustration of a fresh pizza"}>
            {heroImageUrl ? null : <div className="pizza-scene">
              <div className="pizza-shadow" />
              <div className="pizza-disc">
                <span className="topping pepperoni p1" /><span className="topping pepperoni p2" /><span className="topping pepperoni p3" />
                <span className="topping basil b1" /><span className="topping basil b2" /><span className="topping basil b3" />
                <span className="topping onion o1" /><span className="topping onion o2" />
                <span className="pizza-slice-line l1" /><span className="pizza-slice-line l2" /><span className="pizza-slice-line l3" />
                <PizzaMark large />
              </div>
              <div className="floating-tag floating-tag--top"><small>FROM</small><strong>$8.40</strong><span>medium · 1 topping</span></div>
              <div className="floating-tag floating-tag--bottom"><strong>13%</strong><span>HST, calculated right</span></div>
              <div className="scribble-note">made fresh<br />for Hamilton ↗</div>
            </div>}
          </div>
          <div className="hero-marquee" aria-hidden="true"><span>PIZZA • WINGS • DEALS • PICKUP • DELIVERY • HAMILTON •&nbsp;</span><span>PIZZA • WINGS • DEALS • PICKUP • DELIVERY • HAMILTON •&nbsp;</span></div>
        </section>

        {sectionOrder.map((id) => sectionVisible(id) ? <Fragment key={id}>{siteSections[id]}</Fragment> : null)}
      </main>

      <footer className="public-footer">
        <div className="footer-brand"><BrandLogo src={logoUrl} name={businessName} chip /><p>{String(content.footerTagline ?? "Hamilton pizza made for real life.")}</p></div>
        <div><b>Order</b><a href="#offers">Offers</a><a href="#menu">Menu</a><Link href="/track">Track an order</Link></div>
        <div><b>Information</b><a href="#hours">Hours & delivery</a><Link href="/privacy">Privacy</Link><Link href="/accessibility">Accessibility</Link></div>
        <div><b>Restaurant</b><a href={`tel:${phone.replace(/[^0-9+]/g, "")}`}>{phone}</a>{String(content.socialInstagram ?? "").trim() ? <a href={String(content.socialInstagram)} rel="noreferrer">Instagram</a> : null}{String(content.socialFacebook ?? "").trim() ? <a href={String(content.socialFacebook)} rel="noreferrer">Facebook</a> : null}<Link href="/admin">Staff portal</Link></div>
        <small>© {new Date().getFullYear()} {businessName}. Prices shown in Canadian dollars.</small>
      </footer>

      {showMethodPrompt ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => answerMethodPrompt()}>
          <div ref={methodDialogRef} className="delivery-gate method-gate" role="dialog" aria-modal="true" aria-labelledby="method-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" className="modal-close" onClick={() => answerMethodPrompt()} aria-label="Close">×</button>
            <div className="gate-number">01</div><p className="eyebrow dark"><span /> Before you build your order</p>
            <h2 id="method-title">Delivery, or<br /><em>picking it up?</em></h2>
            <p>Timing, the delivery fee and which offers you can use all follow from this. Pick one now — you can switch it any time from the menu.</p>
            <div className="method-choices">
              <button type="button" className="method-choice" onClick={() => answerMethodPrompt("delivery")}>
                <span className="method-icon">D</span>
                <span><b>Deliver it to me</b><small>About {String(ordering.deliveryEstimateMinutes ?? 30)} min · {deliveryFeeCents === 0 ? "no delivery fee" : `${formatMoney(deliveryFeeCents)} delivery`}</small></span>
                <ArrowIcon />
              </button>
              <button type="button" className="method-choice" onClick={() => answerMethodPrompt("pickup")}>
                <span className="method-icon">P</span>
                <span><b>I&apos;ll pick it up</b><small>About {String(ordering.pickupEstimateMinutes ?? 15)} min · {businessAddress}</small></span>
                <ArrowIcon />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deliveryGate ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeliveryGate(false)}>
          <form ref={deliveryDialogRef} className="delivery-gate" role="dialog" aria-modal="true" aria-labelledby="delivery-title" tabIndex={-1} onSubmit={(event) => { event.preventDefault(); screenPostalCode(); }} onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" className="modal-close" onClick={() => setDeliveryGate(false)} aria-label="Close">×</button>
            <div className="gate-number">01</div><p className="eyebrow dark"><span /> Quick delivery check</p>
            <h2 id="delivery-title">Are we in your<br /><em>neighbourhood?</em></h2>
            <p>Enter your postal code for an initial Hamilton-area screen. Your full address is collected at checkout; no third-party address provider is used.</p>
            <label>Postal code<input autoFocus value={postalCode} onChange={(event) => setPostalCode(event.target.value)} placeholder="L8K 4S2" autoComplete="postal-code" /></label>
            {gateMessage ? <div className={gateMessage.startsWith("This") ? "gate-success" : "gate-error"} role="status">{gateMessage}</div> : null}
            <button type="submit" className="primary-button">Check my area <ArrowIcon /></button>
            <button type="button" className="text-button" onClick={() => chooseFulfilment("pickup")}>I&apos;ll pick it up instead</button>
          </form>
        </div>
      ) : null}

      {showClosedNotice ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setClosedNoticeDismissed(true)}>
          <div ref={closedDialogRef} className="delivery-gate closed-gate" role="dialog" aria-modal="true" aria-labelledby="closed-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setClosedNoticeDismissed(true)} aria-label="Close">×</button>
            <div className="closed-face" aria-hidden="true"><i /><b /></div>
            <p className="eyebrow dark"><span /> Kitchen closed</p>
            <h2 id="closed-title">We&apos;re closed,<br /><em>but not for long.</em></h2>
            {store.changesAt ? <p>{businessName} opens <strong>{opensAtLabel}</strong> — that&apos;s in {opensIn}. Build your order now and schedule it for any time we&apos;re open; we&apos;ll start it then.</p> : <p>Opening hours have not been set yet. Please call {phone} to order.</p>}
            <div className="hours-preview">{hours.map((entry) => <div key={entry.weekday} className={entry.weekday === zonedParts(now, timeZone).weekday ? "today" : ""}><span>{entry.label}</span><b>{formatMinuteTime(entry.openMinute)} – {formatMinuteTime(entry.closeMinute)}</b></div>)}</div>
            <button className="primary-button" onClick={() => { setClosedNoticeDismissed(true); menuRef.current?.scrollIntoView({ behavior: "smooth" }); }}>Schedule an order <ArrowIcon /></button>
            <a className="text-button" href={`tel:${phone.replace(/[^0-9+]/g, "")}`}>Call {phone}</a>
          </div>
        </div>
      ) : null}

      {selectedProduct && catalog ? (
        selectedProduct.product_type === "pizza" ? <PizzaCustomizer
          product={selectedProduct}
          variations={catalog.variations.filter((variation) => variation.product_id === selectedProduct.id)}
          toppings={catalog.toppings}
          halalNotice={String(operations.halalNotice ?? "Halal meat options use a shared kitchen.")}
          halfToppingUnitsBps={halfToppingUnitsBps}
          onClose={() => setSelectedProduct(null)}
          onAdd={(line) => { addLine(line); setSelectedProduct(null); }}
        /> : <GenericCustomizer
          product={selectedProduct}
          toppings={catalog.toppings}
          halalNotice={String(operations.halalNotice ?? "Halal meat options use a shared kitchen.")}
          halfToppingUnitsBps={halfToppingUnitsBps}
          onClose={() => setSelectedProduct(null)}
          onAdd={(line) => { addLine(line); setSelectedProduct(null); }}
        />
      ) : null}

      {cartOpen ? (
        <CartDrawer
          cart={cart}
          quote={cartQuote}
          loading={cartQuoteLoading}
          fulfilment={fulfilment}
          onClose={() => setCartOpen(false)}
          onRemove={(key) => { setCart((current) => current.filter((line) => line.key !== key)); analytics("remove_from_cart"); }}
          onCheckout={() => { setCartOpen(false); setCheckoutOpen(true); analytics("checkout_started"); }}
        />
      ) : null}

      {checkoutOpen ? (
        <Checkout
          cart={cart}
          fulfilment={fulfilment}
          settings={catalog?.settings ?? {}}
          integrations={catalog?.integrations ?? { clover: false, email: false }}
          store={store}
          hours={hours}
          timeZone={timeZone}
          now={now}
          onClose={() => setCheckoutOpen(false)}
          onRemove={(key) => {
            setCart((current) => {
              const next = current.filter((line) => line.key !== key);
              // An empty bag has nothing to check out. Staying on a review screen
              // with no items and a disabled pay button is a dead end.
              if (!next.length) setCheckoutOpen(false);
              return next;
            });
            analytics("remove_from_cart");
          }}
          onConfirmed={(result) => { setCheckoutOpen(false); setCart([]); setConfirmation(result); if (result.duplicate !== true) analytics("purchase_completed", { orderNumber: result.orderNumber }); }}
        />
      ) : null}

      {confirmation ? (
        <Confirmation result={confirmation} onClose={() => setConfirmation(null)} />
      ) : null}
    </div>
  );
}

// Half-and-half selection, the way pizzapizza.ca does it: pick the topping, then
// place it on the left, the whole pizza, or the right. A half consumes only the
// owner-configured share of the included allowance, so the price follows.
/**
 * The cart.
 *
 * H-23: switching pickup to delivery used to leave ineligible items sitting in
 * the cart, priced as if nothing had changed, until the server rejected the
 * whole order at the last step of checkout. The quote now reports per-line
 * problems by cart position, so an item that cannot be ordered says so *here*,
 * next to a button that removes it, rather than at the payment screen.
 */
function CartDrawer({ cart, quote, loading, fulfilment, onClose, onRemove, onCheckout }: { cart: CartLine[]; quote: Quote | null; loading: boolean; fulfilment: string; onClose: () => void; onRemove: (key: string) => void; onCheckout: () => void }) {
  const dialogRef = useDialogBehavior<HTMLElement>(true, onClose);
  const totals = quote?.totals ?? EMPTY_TOTALS;
  const lineIssue = (index: number) => quote?.issues.find((issue) => issue.index === index) ?? null;
  const orderIssues = quote?.issues.filter((issue) => issue.index === null) ?? [];
  const blocked = Boolean(quote && !quote.ok);
  return <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}><aside ref={dialogRef} className="cart-drawer" role="dialog" aria-modal="true" aria-labelledby="cart-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}><div className="drawer-head"><div><p className="eyebrow dark"><span /> {fulfilment}</p><h2 id="cart-title">Your order</h2></div><button className="modal-close" onClick={onClose} aria-label="Close cart">×</button></div>
    <div className="cart-lines">{cart.length ? cart.map((line, index) => { const issue = lineIssue(index); return <article className={`cart-line${issue ? " cart-line--blocked" : ""}`} key={line.key}><span className="line-number">{String(index + 1).padStart(2, "0")}</span><div><h3>{line.name}</h3>{line.variationName ? <p>{line.variationName}</p> : null}{line.extraCheese ? <small>Extra cheese</small> : null}{line.halal ? <small>Halal meat toppings</small> : null}{line.toppings?.map((entry) => <small key={entry.toppingId}>{entry.name}{placementSuffix(entry.placement)}</small>)}{line.modifiers?.map((modifier) => <small key={modifier.id}>{modifier.label}: {modifier.values.map((value) => `${value.label}${placementSuffix(value.placement ?? "whole")}`).join(", ")}</small>)}{issue ? <p className="cart-line-issue" role="status">{issue.message}</p> : null}<button onClick={() => onRemove(line.key)}>Remove</button></div><strong>{formatMoney(line.unitPriceCents * line.quantity)}</strong></article>; }) : <div className="empty-cart"><PizzaMark large /><h3>Your bag is empty</h3><p>Add something delicious from the live menu.</p></div>}</div>
    <div className="cart-summary">
      <div><span>Subtotal</span><b>{formatMoney(totals.menuSubtotalCents)}</b></div>
      {totals.discountCents > 0 ? <div className="cart-discount"><span>Discount</span><b>−{formatMoney(totals.discountCents)}</b></div> : null}
      {fulfilment === "delivery" ? <div><span>Delivery</span><b>{totals.deliveryFeeCents === 0 ? "Free" : formatMoney(totals.deliveryFeeCents)}</b></div> : null}
      <div><span>HST{quote ? ` ${(quote.taxRateBps / 100).toFixed(0)}%` : ""}</span><b>{formatMoney(totals.taxCents)}</b></div>
      <div className="cart-total"><span>Total{loading ? <small>Updating…</small> : <small>Priced by Pizza 62</small>}</span><b>{formatMoney(totals.totalCents)}</b></div>
      {orderIssues.map((issue) => <p className="cart-blocker" role="status" key={issue.code}>{issue.message}</p>)}
      <button className="primary-button" disabled={!cart.length || blocked} onClick={onCheckout}>Go to checkout <ArrowIcon /></button>
      <p className="secure-note">Every price here is calculated by Pizza 62, not by your browser, so this is what you will be charged.</p>
    </div>
  </aside></div>;
}

function Checkout({ cart, fulfilment, settings, integrations, store, hours, timeZone, now, onClose, onRemove, onConfirmed }: { cart: CartLine[]; fulfilment: "pickup" | "delivery"; settings: Catalog["settings"]; integrations: Catalog["integrations"]; store: StoreStatus; hours: WeeklyHours; timeZone: string; now: number; onClose: () => void; onRemove: (key: string) => void; onConfirmed: (result: Record<string, unknown>) => void }) {
  const dialogRef = useDialogBehavior<HTMLElement>(true, onClose);
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [email, setEmail] = useState("");
  const [line1, setLine1] = useState(""); const [unit, setUnit] = useState(""); const [postalCode, setPostalCode] = useState(""); const [deliveryInstructions, setDeliveryInstructions] = useState("");
  const [tip, setTip] = useState(0); const [customTip, setCustomTip] = useState(""); const [tipMode, setTipMode] = useState<"preset" | "custom">("preset");
  const [couponInput, setCouponInput] = useState(""); const [couponCode, setCouponCode] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [scheduleType, setScheduleType] = useState<"asap" | "scheduled">(store.open ? "asap" : "scheduled"); const [scheduledFor, setScheduledFor] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"pay_at_store" | "online">(fulfilment === "delivery" ? "online" : "pay_at_store");
  const [submitting, setSubmitting] = useState(false); const [error, setError] = useState("");
  // Inline card entry, when Clover is configured for it and the SDK actually
  // loads. `cardFormBlocked` is the fallback signal: blockers stop payment
  // iframes often enough that the hosted page has to stay reachable, so a
  // failure here silently returns the customer to the redirect they had before.
  const [cardForm, setCardForm] = useState<CloverCardFormHandle | null>(null);
  const [cardFormBlocked, setCardFormBlocked] = useState(false);
  const cloverIframe = integrations.cloverIframe;
  const inlineCardAvailable = Boolean(cloverIframe?.enabled && cloverIframe.publicToken) && !cardFormBlocked;
  // C-07: one durable idempotency key per checkout attempt. It survives refreshes,
  // back-navigation, and double-clicks (persisted in localStorage) and is only
  // cleared after the order is accepted, so retries never create a second order.
  const [idempotencyKey] = useState(() => {
    if (typeof window === "undefined") return `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const storageKey = "p62_checkout_idempotency";
    const existing = window.localStorage.getItem(storageKey);
    if (existing) return existing;
    const generated = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    window.localStorage.setItem(storageKey, generated);
    return generated;
  });
  const clearIdempotencyKey = () => {
    if (typeof window !== "undefined") window.localStorage.removeItem("p62_checkout_idempotency");
  };
  const tipPresets = (settings.taxAndTips?.value.tipPresetBps as number[] | undefined) ?? [1000, 1500, 1800];
  const estimate = fulfilment === "delivery" ? settings.ordering?.value.deliveryEstimateMinutes ?? 30 : settings.ordering?.value.pickupEstimateMinutes ?? 15;
  // Only times the kitchen can accept are offered, so a closed store still takes
  // orders and nobody picks a slot the server has to reject.
  const slots = useMemo(
    () => nextOrderSlots({ now, hours, timeZone, leadMinutes: Number(estimate) }),
    [now, hours, timeZone, estimate],
  );
  const slotLabel = (timestamp: number) => new Date(timestamp).toLocaleString("en-CA", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone });

  // The tip as the order API will receive it. A custom amount is entered in
  // dollars and sent in cents; an unparseable entry means no tip rather than a
  // guessed one.
  const customTipCents = Math.round(Number(customTip.replace(/[^0-9.]/g, "")) * 100);
  const tipRequest = tipMode === "custom"
    ? Number.isFinite(customTipCents) && customTipCents > 0
      ? ({ type: "custom", amountCents: customTipCents } as const)
      : ({ type: "none" } as const)
    : tip
      ? ({ type: "percentage", valueBps: tip } as const)
      : ({ type: "none" } as const);

  // H-24: the review screen is priced by the server, on exactly the cart, tip,
  // coupon and time that will be submitted. Whatever it shows is what will be
  // charged — there is no browser-side arithmetic left to disagree with it.
  const { quote, loading: quoting } = useOrderQuote({
    cart,
    fulfilment,
    tip: tipRequest,
    couponCode: couponCode || undefined,
    schedule: { type: scheduleType, scheduledFor: scheduleType === "scheduled" && scheduledFor ? Number(scheduledFor) : undefined },
  });
  const totals = quote?.totals ?? EMPTY_TOTALS;
  const blockingIssues = quote?.issues ?? [];
  const contactComplete = name.trim().length > 1 && phone.trim().length >= 10 && /\S+@\S+\.\S+/.test(email);
  const addressComplete = fulfilment !== "delivery" || (line1.trim().length > 3 && postalCode.trim().length >= 6);

  const submit = async () => {
    setSubmitting(true); setError(""); analytics("payment_attempted", { paymentMethod });
    try {
      // The card is turned into a single-use token before the order is sent, so
      // a card the customer mistyped fails here — with the form still in front of
      // them and nothing created — rather than after an order row exists.
      let paymentToken: string | undefined;
      if (paymentMethod === "online" && cardForm) {
        try {
          paymentToken = await cardForm.tokenize();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "Please check the card details.");
          setSubmitting(false);
          return;
        }
      }
      const response = await fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        idempotencyKey, fulfilment, customer: { name, phone, email }, items: toOrderItems(cart), schedule: { type: scheduleType, scheduledFor: scheduleType === "scheduled" ? Number(scheduledFor) : undefined }, paymentMethod, paymentToken, tip: tipRequest, couponCode: couponCode || undefined, address: fulfilment === "delivery" ? { line1, unit, city: "Hamilton", province: "ON", postalCode, instructions: deliveryInstructions } : undefined,
      }) });
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(result.error ?? result.message ?? "Order was not accepted."));
      // C-07: a terminal duplicate means the order already exists. Clear the key and
      // show the confirmation, otherwise the stale key would resolve every future
      // checkout from this browser to the same duplicate and block ordering for good.
      clearIdempotencyKey();
      if (result.duplicate) { onConfirmed(result); return; }
      if (typeof result.checkoutUrl === "string") {
        // Clover's return URL is configured once per merchant in its dashboard and
        // cannot carry per-order query parameters, the way Stripe's per-session
        // success_url could. So the tracking credentials are stashed here, before
        // the browser leaves for Clover, and recovered at /order/return. The
        // confirmation email remains the durable copy for a customer who comes
        // back on another device or with storage cleared.
        window.localStorage.setItem("p62_pending_order", JSON.stringify({
          orderNumber: result.orderNumber, trackingToken: result.trackingToken,
          feedbackToken: result.feedbackToken, estimateAt: result.estimateAt, startedAt: Date.now(),
        }));
        window.location.assign(result.checkoutUrl);
        return;
      }
      onConfirmed(result);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The order was not accepted."); setSubmitting(false); }
  };
  return <div className="modal-backdrop"><section ref={dialogRef} className="checkout-modal" role="dialog" aria-modal="true" aria-labelledby="checkout-title" tabIndex={-1}><button className="modal-close" onClick={onClose} aria-label="Close">×</button><p className="eyebrow dark"><span /> Secure checkout</p><h2 id="checkout-title">Finish your <em>{fulfilment}</em> order</h2>
    {fulfilment === "delivery" && !integrations.clover ? <div className="setup-alert"><strong>Online delivery payment is ready for its Clover credentials</strong><p>The ordering flow and 30-minute estimate are configured. Add the Clover secrets in the hosting environment to accept delivery payment.</p></div> : null}
    <div className="checkout-grid"><div><fieldset><legend>Contact details</legend><label>Full name<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label><label>Phone<input value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" inputMode="tel" /></label><label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" inputMode="email" /></label></fieldset>
      {fulfilment === "delivery" ? <fieldset><legend>Delivery address</legend><label>Street address<input value={line1} onChange={(event) => setLine1(event.target.value)} autoComplete="street-address" /></label><label>Unit · optional<input value={unit} onChange={(event) => setUnit(event.target.value)} autoComplete="address-line2" /></label><label>Postal code<input value={postalCode} onChange={(event) => setPostalCode(event.target.value)} autoComplete="postal-code" placeholder="L8H 5W7" /></label><label>Delivery instructions<textarea value={deliveryInstructions} onChange={(event) => setDeliveryInstructions(event.target.value)} maxLength={500} /></label></fieldset> : null}
      <fieldset><legend>When?</legend>
        {!store.open ? <div className="closed-inline" role="status"><strong>We&apos;re closed right now</strong><p>You can still place this order — choose a time from the next opening and we&apos;ll have it ready then.</p></div> : null}
        <div className="checkout-options">
          <label className={scheduleType === "asap" ? "selected" : ""} aria-disabled={!store.open}><input type="radio" checked={scheduleType === "asap"} disabled={!store.open} onChange={() => setScheduleType("asap")} />ASAP <small>{store.open ? `About ${String(estimate)} min` : "Unavailable while closed"}</small></label>
          <label className={scheduleType === "scheduled" ? "selected" : ""}><input type="radio" checked={scheduleType === "scheduled"} onChange={() => setScheduleType("scheduled")} />Schedule later <small>Choose an opening time</small></label>
        </div>
        {scheduleType === "scheduled" ? <label>{fulfilment === "delivery" ? "Delivery" : "Pickup"} time
          <select value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)}>
            <option value="">Choose a time…</option>
            {slots.map((slot) => <option key={slot} value={String(slot)}>{slotLabel(slot)}</option>)}
          </select>
        </label> : null}
        {scheduleType === "scheduled" && !slots.length ? <p className="secure-note">No opening times are available in the next week. Please call the restaurant.</p> : null}
      </fieldset>
      <fieldset><legend>Payment</legend>{fulfilment === "pickup" ? <label className="payment-choice"><input type="radio" checked={paymentMethod === "pay_at_store"} onChange={() => setPaymentMethod("pay_at_store")} /><span><b>Pay at store</b><small>Cash, debit, or credit card</small></span></label> : null}<label className={`payment-choice ${integrations.clover ? "" : "disabled"}`}><input type="radio" disabled={!integrations.clover} checked={paymentMethod === "online"} onChange={() => setPaymentMethod("online")} /><span><b>Pay online by card</b><small>{integrations.clover ? (inlineCardAvailable ? "Card or Apple Pay, right here" : "Secure hosted checkout by Clover") : "Add Clover credentials to enable"}</small></span></label></fieldset>
      {paymentMethod === "online" && cloverIframe?.enabled && cloverIframe.publicToken && !cardFormBlocked
        ? <CloverCardForm
            publicToken={cloverIframe.publicToken}
            merchantId={cloverIframe.merchantId}
            sandbox={Boolean(cloverIframe.sandbox)}
            onReady={setCardForm}
            onUnavailable={(reason) => {
              // Logged, not swallowed. The fallback is silent by design — a
              // customer should get a working payment page, not a diagnosis —
              // but a silent fallback is indistinguishable from the hosted
              // checkout simply "taking over", which is exactly how a blocked
              // reCAPTCHA looked from the outside. This is the breadcrumb.
              console.error("[checkout] inline card form unavailable, falling back to Clover:", reason);
              analytics("card_form_unavailable", { reason });
              setCardFormBlocked(true);
              setCardForm(null);
            }}
          />
        : null}</div>
      <aside className="checkout-summary">
        <h3>Order summary</h3>
        {/* Removable here as well as in the bag. The review screen is where a
            customer actually re-reads what they are about to pay for, and being
            sent back to the bag to take one thing out is the point people
            abandon a checkout rather than fix it. */}
        {cart.map((line) => <div key={line.key}><span>{line.quantity} × {line.name}</span><b>{formatMoney(line.unitPriceCents * line.quantity)}</b><button type="button" className="summary-remove" onClick={() => onRemove(line.key)} aria-label={`Remove ${line.name} from your order`}>Remove</button></div>)}

        <hr />
        <p>Promo code</p>
        <div className="coupon-row">
          <input
            value={couponInput}
            onChange={(event) => setCouponInput(event.target.value.toUpperCase())}
            placeholder="Have a code?"
            aria-label="Promo code"
            autoComplete="off"
            spellCheck={false}
          />
          {couponCode ? (
            <button type="button" onClick={() => { setCouponCode(""); setCouponInput(""); }}>Remove</button>
          ) : (
            <button type="button" disabled={!couponInput.trim()} onClick={() => { setCouponCode(couponInput.trim()); analytics("coupon_used", { code: couponInput.trim() }); }}>Apply</button>
          )}
        </div>
        {quote?.coupon ? (
          <p className={quote.coupon.accepted ? "coupon-ok" : "coupon-bad"} role="status">
            {quote.coupon.accepted ? `${quote.coupon.code} applied.` : quote.coupon.message}
          </p>
        ) : null}

        <hr />
        <p>Tip</p>
        <div className="tip-grid">
          <button type="button" className={tipMode === "preset" && tip === 0 ? "active" : ""} onClick={() => { setTipMode("preset"); setTip(0); }}>None</button>
          {tipPresets.map((preset) => <button type="button" className={tipMode === "preset" && tip === preset ? "active" : ""} key={preset} onClick={() => { setTipMode("preset"); setTip(preset); }}>{preset / 100}%</button>)}
          <button type="button" className={tipMode === "custom" ? "active" : ""} onClick={() => setTipMode("custom")}>Other</button>
        </div>
        {tipMode === "custom" ? (
          <label className="custom-tip">Tip amount · C$
            <input inputMode="decimal" value={customTip} onChange={(event) => setCustomTip(event.target.value)} placeholder="0.00" />
          </label>
        ) : null}
        <p className="tip-note">Percentage tips are calculated on the food total after any discount, before HST, and exclude delivery.</p>

        {/*
          H-24: the complete breakdown, every line of it, priced by the server.
          The customer cannot give informed consent to a number they were shown
          only as a single "estimated total".
        */}
        <hr />
        <div className="checkout-totals">
          <div><span>Subtotal</span><b>{formatMoney(totals.menuSubtotalCents)}</b></div>
          {totals.discountCents > 0 ? (
            <div className="checkout-discount">
              <span>Discount{quote?.appliedPromotions.length ? ` · ${quote.appliedPromotions.map((entry) => entry.name).join(", ")}` : ""}</span>
              <b>−{formatMoney(totals.discountCents)}</b>
            </div>
          ) : null}
          {fulfilment === "delivery" ? <div><span>Delivery fee</span><b>{totals.deliveryFeeCents === 0 ? "Free" : formatMoney(totals.deliveryFeeCents)}</b></div> : null}
          <div>
            <span>HST {quote ? `${(quote.taxRateBps / 100).toFixed(0)}%` : ""}{quote?.deliveryFeeTaxable && fulfilment === "delivery" ? <small>on food and delivery</small> : null}</span>
            <b>{formatMoney(totals.taxCents)}</b>
          </div>
          {totals.tipCents > 0 ? <div><span>Tip</span><b>{formatMoney(totals.tipCents)}</b></div> : null}
          <div className="checkout-grand-total">
            <span>Total to pay{quoting ? <small>Updating…</small> : null}</span>
            <b>{formatMoney(totals.totalCents)}</b>
          </div>
        </div>

        {blockingIssues.map((issue) => <p className="cart-blocker" role="status" key={`${issue.code}-${issue.index ?? "order"}`}>{issue.message}</p>)}

        <label className="terms-accept">
          <input type="checkbox" checked={termsAccepted} onChange={(event) => setTermsAccepted(event.target.checked)} />
          <span>
            I agree to the <Link href="/terms" target="_blank">terms</Link> and the{" "}
            <Link href="/cancellation" target="_blank">cancellation &amp; refund policy</Link>, and confirm the order above is correct.
          </span>
        </label>

        {error ? <div className="form-error" role="alert">{error}</div> : null}
        <button
          className="primary-button"
          disabled={
            submitting ||
            quoting ||
            !quote?.ok ||
            !termsAccepted ||
            !contactComplete ||
            !addressComplete ||
            (paymentMethod === "online" && !integrations.clover) ||
            (scheduleType === "scheduled" && !scheduledFor)
          }
          onClick={submit}
        >
          {submitting ? "Confirming…" : paymentMethod === "online" ? `Pay ${formatMoney(totals.totalCents)}` : `Place order · ${formatMoney(totals.totalCents)}`} <ArrowIcon />
        </button>
        {!contactComplete ? <small className="checkout-hint">Add your name, phone and email above to continue.</small> : null}
        {contactComplete && !addressComplete ? <small className="checkout-hint">Add your delivery address above to continue.</small> : null}
        <small>This total is calculated by Pizza 62 and is what you will be charged. {paymentMethod === "online" && inlineCardAvailable
          ? "Card details go straight to Clover and never reach this site."
          : "Card details are entered on Clover\u2019s secure page and never reach this site."}</small>
      </aside></div>
  </section></div>;
}

function Confirmation({ result, onClose }: { result: Record<string, unknown>; onClose: () => void }) {
  const dialogRef = useDialogBehavior<HTMLElement>(true, onClose);
  // C-07: a duplicate submission resolves to an order that already exists. Its
  // tracking/feedback tokens are stored only as hashes, so they cannot be re-issued
  // here — the links are omitted rather than rendered with an "undefined" token.
  const duplicate = result.duplicate === true;
  const orderNumber = String(result.orderNumber ?? "");
  const trackingUrl = result.trackingToken
    ? `/track?order=${encodeURIComponent(orderNumber)}&token=${encodeURIComponent(String(result.trackingToken))}`
    : null;
  // No feedback link here, deliberately. This screen appears seconds after the
  // order is placed — before the pizza is made, let alone eaten — and asking
  // "how did we do?" at that moment reads as a review farm rather than a
  // question. The feedback request is queued at order time and released a set
  // delay after staff mark the order completed; see the outbox's
  // `waiting_completion` state and operations.feedbackDelayMinutes.
  const estimateAt = Number(result.estimateAt);
  return <div className="modal-backdrop"><section ref={dialogRef} className="confirmation-card" role="dialog" aria-modal="true" aria-labelledby="confirmation-title" tabIndex={-1}><div className="confirmation-check">✓</div><p className="eyebrow dark"><span /> Confirmed by Pizza 62</p><h2 id="confirmation-title">{duplicate ? "This order is already in." : "You're all set."}</h2><p>{duplicate ? <>Order <strong>{orderNumber}</strong> was already placed, so we did not charge you twice or send a second order to the kitchen.</> : <>Order <strong>{orderNumber}</strong> is received and marked for payment at the store.</>}</p>{Number.isFinite(estimateAt) && estimateAt > 0 ? <div className="confirmation-estimate"><span>Estimated pickup</span><b>{new Date(estimateAt).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })}</b></div> : null}{trackingUrl ? <Link className="primary-button" href={trackingUrl}>Track your order <ArrowIcon /></Link> : <p className="confirmation-note">Use the tracking link from your original confirmation, or call Pizza 62 with order {orderNumber}.</p>}<button className="text-button" onClick={onClose}>Back to the menu</button></section></div>;
}
