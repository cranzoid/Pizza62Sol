"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { BrandLogo } from "@/app/BrandLogo";
import {
  BAKE_SAUCE_OPTIONS,
  CHEESE_OPTIONS,
  CRUST_OPTIONS,
  DEFAULT_CHEESE_OPTION,
  DEFAULT_CRUST_OPTION,
  EXTRA_CHEESE_OPTION,
  HALAL_OPTION,
  formatMoney,
  isWithinWeeklyAvailability,
  modifierUnitsBps,
  normalizeModifierValues,
  orderModifierSections,
  priceCart,
  pricePizza,
  priceToppingUnits,
  nextOrderSlots,
  storeStatus,
  zonedParts,
  type ModifierSection,
  type StoreStatus,
  type WeeklyHours,
  type ToppingPlacement,
  type WeeklyAvailability,
} from "@/lib/domain";

type Category = { id: string; name: string; slug: string; description?: string | null };
type Product = {
  id: string;
  category_id: string;
  name: string;
  description: string;
  product_type: "pizza" | "simple" | "bundle" | "configurable";
  image_url?: string | null;
  base_price_cents: number;
  taxable: number;
  pickup_eligible: number;
  delivery_eligible: number;
  halal_capable: number;
  sold_out: number;
  setup_required: number;
  configuration: Record<string, unknown>;
};
type Variation = {
  id: string;
  product_id: string;
  name: string;
  base_price_cents: number;
  extra_topping_price_cents: number;
  included_topping_units_bps: number;
};
type Topping = {
  id: string;
  name: string;
  is_meat: number;
  has_halal_version: number;
  halal_available: number;
};
type Catalog = {
  categories: Category[];
  products: Product[];
  variations: Variation[];
  toppings: Topping[];
  settings: Record<string, { value: Record<string, unknown>; version: number }>;
  integrations: { stripe: boolean; email: boolean };
};
type ModifierSelection = {
  id: string;
  label: string;
  values: Array<{ value: string; label: string; placement?: ToppingPlacement }>;
};
type SelectedTopping = { toppingId: string; placement: ToppingPlacement; name: string };

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
/** "1", "1.5", "2" — half toppings show as fractions of the included allowance. */
const formatUnits = (units: number) => (Number.isInteger(units) ? String(units) : units.toFixed(1));
type CartLine = {
  key: string;
  productId: string;
  name: string;
  categoryId: string;
  variationId?: string;
  variationName?: string;
  quantity: number;
  unitPriceCents: number;
  taxable: boolean;
  toppings?: SelectedTopping[];
  modifiers?: ModifierSelection[];
  extraCheese?: boolean;
  halal?: boolean;
  specialInstructions?: string;
  freeDelivery?: boolean;
};

const FALLBACK_PHONE = "(905) 547-5777";

const DEFAULT_PROMISES = [
  { title: "Built your way", text: "Simple topping selection" },
  { title: "Clear totals", text: "No surprise math at checkout" },
  { title: "Local & direct", text: "Order straight from Pizza 62" },
  { title: "Track every step", text: "Private, secure order updates" },
];

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
  const [fulfilment, setFulfilment] = useState<"pickup" | "delivery">(rememberedFulfilment);
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

  useEffect(() => {
    window.localStorage.setItem("p62_fulfilment", fulfilment);
    window.localStorage.setItem("p62_cart_draft", JSON.stringify(cart));
  }, [fulfilment, cart]);

  const business = catalog?.settings.business?.value ?? {};
  const phone = (business.phone as string | undefined) ?? FALLBACK_PHONE;
  const businessName = String(business.name ?? "Pizza 62");
  const businessAddress = String(business.address ?? "55 Parkdale Ave N, Hamilton, ON L8H 5W7");
  const ordering = catalog?.settings.ordering?.value ?? {};
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
  const store = useMemo(() => storeStatus(now, hours, timeZone), [now, hours, timeZone]);
  const [closedNoticeDismissed, setClosedNoticeDismissed] = useState(false);
  const showClosedNotice = Boolean(catalog) && !store.open && !closedNoticeDismissed;
  const opensIn = store.changesAt ? countdown(store.changesAt - now) : "";
  const opensAtLabel = store.changesAt
    ? new Date(store.changesAt).toLocaleString("en-CA", { weekday: "long", hour: "numeric", minute: "2-digit", timeZone })
    : "";
  const categories = catalog?.categories ?? [];
  const eligibleProducts = (catalog?.products ?? []).filter((product) =>
    fulfilment === "pickup" ? product.pickup_eligible : product.delivery_eligible,
  );

  const totals = useMemo(
    () => {
      const taxTips = catalog?.settings.taxAndTips?.value ?? {};
      return priceCart({
        lines: cart.map((line) => ({
          id: line.key,
          productId: line.productId,
          categoryId: line.categoryId,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          taxable: line.taxable,
          promotionEligible: true,
        })),
        fulfilment,
        deliveryFeeCents: cart.some((line) => line.freeDelivery) ? 0 : Number(catalog?.settings.delivery?.value.feeCents ?? 350),
        taxRateBps: Number(taxTips.taxRateBps ?? 1300),
        deliveryFeeTaxable: Boolean(catalog?.settings.delivery?.value.feeTaxable),
        tip: { type: "none" },
      });
    },
    [cart, fulfilment, catalog],
  );

  const chooseFulfilment = (next: "pickup" | "delivery") => {
    setFulfilment(next);
    setDeliveryGate(next === "delivery");
    setGateMessage("");
    analytics("fulfilment_selected", { fulfilment: next });
    if (next === "pickup") {
      window.setTimeout(() => menuRef.current?.scrollIntoView({ behavior: "smooth" }), 80);
    }
  };

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
              <div className="segmented-control">
                <button className={fulfilment === "pickup" ? "active" : ""} onClick={() => chooseFulfilment("pickup")}>Pickup</button>
                <button className={fulfilment === "delivery" ? "active" : ""} onClick={() => chooseFulfilment("delivery")}>Delivery</button>
              </div>
            </div>
          </div>
          {loadingError ? <div className="error-banner" role="alert">{loadingError}</div> : null}
          {!catalog && !loadingError ? <div className="menu-loading" role="status"><span />Loading the live menu…</div> : null}
          <div className="category-tabs" aria-label="Menu categories">
            {categories.map((category) => <a key={category.id} href={`#category-${category.id}`}>{category.name}</a>)}
          </div>
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
          <a href="#menu">Menu</a>
          <a href="#deals">Deals</a>
          <a href="#hours">Hours</a>
          <Link href="/track">Track order</Link>
        </nav>
        <div className="header-actions">
          <a className="phone-link" href={`tel:${phone.replace(/[^0-9+]/g, "")}`}>{phone}</a>
          <button className="cart-pill" onClick={() => setCartOpen(true)} aria-label={`Open cart with ${cart.length} items`}>
            <span>Bag</span><b>{cart.reduce((sum, line) => sum + line.quantity, 0)}</b>
          </button>
        </div>
      </header>

      <main id="top">
        <section className="hero-section">
          <div className="hero-grain" aria-hidden="true" />
          <div className="hero-copy">
            <p className="eyebrow"><span /> {String(content.heroEyebrow ?? "Hamilton-made since the first slice")}</p>
            <h1>{String(content.heroHeadline ?? "Big flavour.")}<br /><em>{String(content.heroAccent ?? "Zero fuss.")}</em></h1>
            <p className="hero-lede">{String(content.heroDescription ?? "Hot pizza, honest prices, and the kind of local service that remembers your order.")}</p>
            <div className="hero-method" aria-label="Choose how to get your order">
              <button className={fulfilment === "delivery" ? "active" : ""} onClick={() => chooseFulfilment("delivery")}>
                <span className="method-icon">D</span><span><b>Delivery</b><small>About {String(ordering.deliveryEstimateMinutes ?? 30)} min</small></span><ArrowIcon />
              </button>
              <button className={fulfilment === "pickup" ? "active" : ""} onClick={() => chooseFulfilment("pickup")}>
                <span className="method-icon">P</span><span><b>Pickup</b><small>About {String(ordering.pickupEstimateMinutes ?? 15)} min</small></span><ArrowIcon />
              </button>
            </div>
            <div className="hero-note"><span className={`pulse-dot ${store.open ? "" : "pulse-dot--closed"}`} /> {ordering.paused ? "Online ordering is temporarily paused" : store.open ? `Open now${store.changesAt ? ` · until ${new Date(store.changesAt).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone })}` : ""}` : `Closed · opens ${opensAtLabel}${opensIn ? ` (in ${opensIn})` : ""}`}</div>
          </div>
          <div className={`hero-art ${heroImageUrl ? "hero-art--photo" : ""}`} style={heroImageUrl ? { backgroundImage: `url(${heroImageUrl})` } : undefined} aria-label={heroImageUrl ? `${businessName} food photograph` : "A playful illustration of a fresh pizza"}>
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
          <div className="hero-marquee" aria-hidden="true"><span>PIZZA • WINGS • DEALS • PICKUP • DELIVERY • HAMILTON •&nbsp;</span><span>PIZZA • WINGS • DEALS • PICKUP • DELIVERY • HAMILTON •</span></div>
        </section>

        {sectionOrder.map((id) => sectionVisible(id) ? <Fragment key={id}>{siteSections[id]}</Fragment> : null)}
      </main>

      <footer className="public-footer">
        <div className="footer-brand"><BrandLogo src={logoUrl} name={businessName} chip /><p>{String(content.footerTagline ?? "Hamilton pizza made for real life.")}</p></div>
        <div><b>Order</b><a href="#menu">Menu</a><a href="#deals">Deals</a><Link href="/track">Track an order</Link></div>
        <div><b>Information</b><a href="#hours">Hours & delivery</a><Link href="/privacy">Privacy</Link><Link href="/accessibility">Accessibility</Link></div>
        <div><b>Restaurant</b><a href={`tel:${phone.replace(/[^0-9+]/g, "")}`}>{phone}</a>{String(content.socialInstagram ?? "").trim() ? <a href={String(content.socialInstagram)} rel="noreferrer">Instagram</a> : null}{String(content.socialFacebook ?? "").trim() ? <a href={String(content.socialFacebook)} rel="noreferrer">Facebook</a> : null}<Link href="/admin">Staff portal</Link></div>
        <small>© {new Date().getFullYear()} {businessName}. Prices shown in Canadian dollars.</small>
      </footer>

      {deliveryGate ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeliveryGate(false)}>
          <div className="delivery-gate" role="dialog" aria-modal="true" aria-labelledby="delivery-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setDeliveryGate(false)} aria-label="Close">×</button>
            <div className="gate-number">01</div><p className="eyebrow dark"><span /> Quick delivery check</p>
            <h2 id="delivery-title">Are we in your<br /><em>neighbourhood?</em></h2>
            <p>Enter your postal code for an initial Hamilton-area screen. Your full address is collected at checkout; no third-party address provider is used.</p>
            <label>Postal code<input autoFocus value={postalCode} onChange={(event) => setPostalCode(event.target.value)} placeholder="L8K 4S2" autoComplete="postal-code" /></label>
            {gateMessage ? <div className={gateMessage.startsWith("This") ? "gate-success" : "gate-error"} role="status">{gateMessage}</div> : null}
            <button className="primary-button" onClick={screenPostalCode}>Check my area <ArrowIcon /></button>
            <button className="text-button" onClick={() => chooseFulfilment("pickup")}>I&apos;ll pick it up instead</button>
          </div>
        </div>
      ) : null}

      {showClosedNotice ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setClosedNoticeDismissed(true)}>
          <div className="delivery-gate closed-gate" role="dialog" aria-modal="true" aria-labelledby="closed-title" onMouseDown={(event) => event.stopPropagation()}>
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
          totals={totals}
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
          integrations={catalog?.integrations ?? { stripe: false, email: false }}
          store={store}
          hours={hours}
          timeZone={timeZone}
          now={now}
          onClose={() => setCheckoutOpen(false)}
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
function ToppingPicker({
  toppings,
  selected,
  halalOnly,
  onToggle,
  onPlacement,
}: {
  toppings: Topping[];
  selected: SelectedTopping[];
  halalOnly: boolean;
  onToggle: (topping: Topping) => void;
  onPlacement: (toppingId: string, placement: ToppingPlacement) => void;
}) {
  return <div className="topping-grid">{toppings.map((topping) => {
    const entry = selected.find((item) => item.toppingId === topping.id);
    const unavailableForHalal = Boolean(halalOnly && topping.is_meat && !(topping.has_halal_version && topping.halal_available));
    return <div className={`topping-chip ${entry ? "topping-chip--active" : ""}`} key={topping.id}>
      <button className={entry ? "active" : ""} type="button" disabled={unavailableForHalal} onClick={() => onToggle(topping)}>
        <span>{entry ? "✓" : unavailableForHalal ? "×" : "+"}</span>{topping.name}
        {halalOnly && topping.is_meat ? <small>{unavailableForHalal ? "Not halal" : "Halal"}</small> : null}
      </button>
      {entry ? <div className="placement-switch" role="group" aria-label={`${topping.name} placement`}>
        {PLACEMENTS.map(([placement, symbol, label]) => <button
          key={placement}
          type="button"
          className={entry.placement === placement ? "active" : ""}
          aria-pressed={entry.placement === placement}
          onClick={() => onPlacement(topping.id, placement)}
        ><i aria-hidden="true">{symbol}</i>{label}</button>)}
      </div> : null}
    </div>;
  })}</div>;
}

const PLACEMENTS: Array<[ToppingPlacement, string, string]> = [
  ["left", "◐", "Left"],
  ["whole", "●", "Whole"],
  ["right", "◑", "Right"],
];

function placementSuffix(placement: ToppingPlacement) {
  return placement === "left" ? " · left half" : placement === "right" ? " · right half" : "";
}

function PizzaCustomizer({
  product,
  variations,
  toppings,
  halalNotice,
  halfToppingUnitsBps,
  onClose,
  onAdd,
}: {
  product: Product;
  variations: Variation[];
  toppings: Topping[];
  halalNotice: string;
  halfToppingUnitsBps: number;
  onClose: () => void;
  onAdd: (line: CartLine) => void;
}) {
  const configuration = product.configuration;
  const recipeToppingIds = Array.isArray(configuration.recipeToppingIds)
    ? configuration.recipeToppingIds.map(String)
    : [];
  const [variationId, setVariationId] = useState(variations[0]?.id ?? "");
  const [selected, setSelected] = useState<SelectedTopping[]>(() =>
    recipeToppingIds.map((toppingId) => ({
      toppingId,
      placement: "whole" as ToppingPlacement,
      name: toppings.find((topping) => topping.id === toppingId)?.name ?? toppingId,
    })),
  );
  const cheeseEnabled = configuration.cheeseEnabled !== false;
  const halalEnabled = Boolean(product.halal_capable);
  const crustOptions = stringList(configuration.crustOptions);
  const bakeSauceOptions = stringList(configuration.bakeSauceOptions);
  // Pizzas configured before crust and bake/sauce were split keep one combined group.
  const legacyBaseOptions = !crustOptions.length && !bakeSauceOptions.length ? stringList(configuration.pizzaBaseOptions) : [];
  const [cheese, setCheese] = useState(configuration.presetExtraCheese ? EXTRA_CHEESE_OPTION : DEFAULT_CHEESE_OPTION);
  const [halal, setHalal] = useState(false);
  const [crust, setCrust] = useState(() => (crustOptions.includes(DEFAULT_CRUST_OPTION) ? DEFAULT_CRUST_OPTION : crustOptions[0] ?? ""));
  const [bakeSauce, setBakeSauce] = useState<string[]>([]);
  const [legacyBase, setLegacyBase] = useState<string[]>([]);
  const [instructions, setInstructions] = useState("");
  const variation = variations.find((entry) => entry.id === variationId) ?? variations[0];
  const extraCheese = cheeseEnabled && cheese === EXTRA_CHEESE_OPTION;
  const price = variation
    ? pricePizza({
        basePriceCents: variation.base_price_cents,
        extraToppingPriceCents: variation.extra_topping_price_cents,
        includedToppingUnitsBps: variation.included_topping_units_bps,
        halfToppingUnitsBps,
        toppings: selected,
        extraCheese,
      })
    : null;
  const includedCount = (variation?.included_topping_units_bps ?? 0) / 10_000;
  const selectedUnits = (price?.toppingUnitsBps ?? 0) / 10_000;
  const selectionValid = Boolean(variation && (configuration.fixedRecipe || includedCount === 0 || selected.length >= 1));
  const toggleTopping = (topping: Topping) => setSelected((current) => current.some((entry) => entry.toppingId === topping.id)
    ? current.filter((entry) => entry.toppingId !== topping.id)
    : [...current, { toppingId: topping.id, placement: "whole", name: topping.name }]);
  const setPlacement = (toppingId: string, placement: ToppingPlacement) =>
    setSelected((current) => current.map((entry) => entry.toppingId === toppingId ? { ...entry, placement } : entry));
  const chooseHalal = (next: boolean) => {
    setHalal(next);
    if (next) setSelected((current) => current.filter((entry) => {
      const topping = toppings.find((candidate) => candidate.id === entry.toppingId);
      return !topping?.is_meat || Boolean(topping.has_halal_version && topping.halal_available);
    }));
  };
  // The customer is always asked in the same order: what it is made of, how it is
  // baked, then what goes on it. Steps that are switched off are skipped and the
  // numbering closes up behind them. The owner can put toppings before the crust.
  const steps = [
    "size",
    cheeseEnabled || halalEnabled ? "cheese" : "",
    ...(configuration.toppingsFirst
      ? ["toppings", crustOptions.length ? "crust" : "", bakeSauceOptions.length ? "bake" : "", legacyBaseOptions.length ? "legacy" : ""]
      : [crustOptions.length ? "crust" : "", bakeSauceOptions.length ? "bake" : "", legacyBaseOptions.length ? "legacy" : "", "toppings"]),
  ].filter(Boolean);
  const stepNumber = (name: string) => String(steps.indexOf(name) + 1);
  const sizePanel = <><fieldset><legend><span>{stepNumber("size")}</span> {String(configuration.variationLabel ?? "Choose your size")}</legend><div className="size-options">{variations.map((item) => <label key={item.id} className={item.id === variationId ? "selected" : ""}><input type="radio" name="size" value={item.id} checked={item.id === variationId} onChange={() => setVariationId(item.id)} /><span><b>{item.name}</b><small>{formatMoney(item.base_price_cents)}</small></span></label>)}</div></fieldset></>;
  const cheesePanel = <>{cheeseEnabled || halalEnabled ? <fieldset><legend><span>{stepNumber("cheese")}</span> {cheeseEnabled && halalEnabled ? "Cheese & halal" : cheeseEnabled ? "Cheese" : "Halal"}</legend>
            {cheeseEnabled ? <div className="size-options cheese-options">{CHEESE_OPTIONS.map((option) => <label key={option} className={cheese === option ? "selected" : ""}><input type="radio" name="cheese" checked={cheese === option} onChange={() => setCheese(option)} /><span><b>{option.replace(" Cheese", "")}</b><small>{option === EXTRA_CHEESE_OPTION ? `Counts as one topping${variation ? ` · ${formatMoney(variation.extra_topping_price_cents)}` : ""}` : "No extra charge"}</small></span></label>)}</div> : null}
            {halalEnabled ? <div className="choice-list"><label><input type="checkbox" checked={halal} onChange={(event) => chooseHalal(event.target.checked)} /><span><b>Use halal meat toppings</b><small>{halalNotice}</small></span><em>No surcharge</em></label></div> : null}
          </fieldset> : null}</>;
  const crustPanel = <>{crustOptions.length ? <fieldset><legend><span>{stepNumber("crust")}</span> Crust</legend><div className="topping-grid">{crustOptions.map((option) => <button className={crust === option ? "active" : ""} type="button" key={option} aria-pressed={crust === option} onClick={() => setCrust(option)}><span>{crust === option ? "✓" : "+"}</span>{option}</button>)}</div></fieldset> : null}</>;
  const bakePanel = <>{bakeSauceOptions.length ? <fieldset><legend><span>{stepNumber("bake")}</span> Bake &amp; sauce</legend><div className="topping-grid">{bakeSauceOptions.map((option) => { const active = bakeSauce.includes(option); return <button className={active ? "active" : ""} type="button" key={option} onClick={() => setBakeSauce((current) => active ? current.filter((entry) => entry !== option) : current.length < 2 ? [...current, option] : current)}><span>{active ? "✓" : "+"}</span>{option}</button>; })}</div><div className="allowance-meter"><span>Optional</span><b>Choose up to 2</b></div></fieldset> : null}</>;
  const legacyPanel = <>{legacyBaseOptions.length ? <fieldset><legend><span>{stepNumber("legacy")}</span> Crust, bake &amp; sauce</legend><div className="topping-grid">{legacyBaseOptions.map((option) => { const active = legacyBase.includes(option); return <button className={active ? "active" : ""} type="button" key={option} onClick={() => setLegacyBase((current) => active ? current.filter((entry) => entry !== option) : current.length < 2 ? [...current, option] : current)}><span>{active ? "✓" : "+"}</span>{option}</button>; })}</div></fieldset> : null}</>;
  const toppingsPanel = <><fieldset><legend><span>{stepNumber("toppings")}</span> Choose toppings</legend>
            {Boolean(configuration.fixedRecipe) ? <div className="setup-alert"><strong>Specialty recipe selected for you</strong><p>The highlighted recipe toppings are included. Any topping beyond the recipe is charged at the selected size&apos;s extra-topping rate.</p></div> : <div className="setup-alert"><strong>{includedCount === 1 ? "Your first topping is included" : `Choose up to ${includedCount} included toppings`}</strong><p>Additional toppings are {variation ? `${formatMoney(variation.extra_topping_price_cents)} each` : "priced by size"}. Put a topping on half the pizza and it counts as {halfToppingUnitsBps === 10_000 ? "a full topping" : `${halfToppingUnitsBps / 10_000} of a topping`}.</p></div>}
            <ToppingPicker toppings={toppings} selected={selected} halalOnly={halal} onToggle={toggleTopping} onPlacement={setPlacement} />
            <div className="allowance-meter"><span>{formatUnits(selectedUnits)} selected · {includedCount} included</span><b>{price?.extraToppingTotalCents ? `${formatMoney(price.extraToppingTotalCents)} in extras` : selected.length ? "Included in flyer price" : "Choose at least 1"}</b></div>
          </fieldset></>;
  const modifiers: ModifierSelection[] = [];
  if (crust) modifiers.push({ id: "pizza-crust", label: "Crust", values: [{ value: crust, label: crust }] });
  if (bakeSauce.length) modifiers.push({ id: "pizza-bake-sauce", label: "Bake & sauce", values: bakeSauce.map((value) => ({ value, label: value })) });
  if (legacyBase.length) modifiers.push({ id: "pizza-base", label: "Crust, bake & sauce", values: legacyBase.map((value) => ({ value, label: value })) });
  return (
    <div className="modal-backdrop modal-backdrop--right" role="presentation" onMouseDown={onClose}>
      <section className="customizer" role="dialog" aria-modal="true" aria-labelledby="customizer-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="customizer-head"><div><p className="eyebrow dark"><span /> Customize your order</p><h2 id="customizer-title">{product.name}</h2></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div>
        <div className="customizer-body">
          {sizePanel}{cheesePanel}
          {configuration.toppingsFirst
            ? <>{toppingsPanel}{crustPanel}{bakePanel}{legacyPanel}</>
            : <>{crustPanel}{bakePanel}{legacyPanel}{toppingsPanel}</>}
          <label className="instructions-label">Special instructions <small>Call the restaurant about serious allergies.</small><textarea value={instructions} maxLength={500} onChange={(event) => setInstructions(event.target.value)} placeholder="Example: cut into squares" /></label>
        </div>
        <div className="customizer-footer"><div><small>Your pizza</small><strong>{price ? formatMoney(price.totalCents) : "—"}</strong></div><button className="primary-button" disabled={!selectionValid} onClick={() => variation && price && onAdd({ key: crypto.randomUUID(), productId: product.id, name: product.name, categoryId: product.category_id, variationId: variation.id, variationName: variation.name, quantity: 1, unitPriceCents: price.totalCents, taxable: Boolean(product.taxable), toppings: selected, modifiers, extraCheese, halal, freeDelivery: Boolean(configuration.freeDelivery), specialInstructions: [cheeseEnabled && cheese !== DEFAULT_CHEESE_OPTION ? cheese : "", instructions.trim()].filter(Boolean).join(" · ") })}>Add to order <ArrowIcon /></button></div>
      </section>
    </div>
  );
}

const WING_FLAVOUR_FALLBACK = ["Mild", "Medium", "Hot", "Suicide", "Honey Garlic", "BBQ", "Cajun", "Lemon Pepper", "None"];
const DRINK_FALLBACK = ["Pepsi", "Diet Pepsi", "Coke", "Diet Coke", "Coke Zero", "Gingerale", "Crush Orange", "Brisk Ice Tea", "Sprite", "Dr. Peppers", "Fanta Grape"];
const LEGACY_BASE_FALLBACK = ["Thin Crust", "Thick Crust", "Lightly Done", "Well Done", "Easy on the Sauce", "Extra Sauce"];

// Deals build each pizza with the same choices, in the same order, as a pizza
// ordered on its own — cheese and halal, crust, bake & sauce, then toppings — and
// group them under a heading per pizza so a two-pizza deal reads as two pizzas.
function GenericCustomizer({ product, toppings, halalNotice, halfToppingUnitsBps, onClose, onAdd }: { product: Product; toppings: Topping[]; halalNotice: string; halfToppingUnitsBps: number; onClose: () => void; onAdd: (line: CartLine) => void }) {
  const sections = useMemo(
    () => orderModifierSections(
      (Array.isArray(product.configuration.sections) ? product.configuration.sections : []) as ModifierSection[],
      Boolean(product.configuration.toppingsFirst),
    ),
    [product.configuration],
  );
  const [selected, setSelected] = useState<Record<string, ModifierSelection["values"]>>(() => {
    const initial: Record<string, ModifierSelection["values"]> = {};
    for (const section of sections) {
      if (section.source === "cheese") initial[section.id] = [{ value: DEFAULT_CHEESE_OPTION, label: DEFAULT_CHEESE_OPTION }];
      if (section.source === "crust") {
        const options = section.options?.length ? section.options : [...CRUST_OPTIONS];
        const value = options.includes(DEFAULT_CRUST_OPTION) ? DEFAULT_CRUST_OPTION : options[0];
        if (value) initial[section.id] = [{ value, label: value }];
      }
    }
    return initial;
  });
  const [instructions, setInstructions] = useState("");
  const optionsFor = (section: ModifierSection): Array<{ value: string; label: string }> => {
    if (section.source === "toppings") return toppings.map((entry) => ({ value: entry.id, label: entry.name }));
    const configured = section.options?.length ? section.options : (
      section.source === "wing_flavours" ? WING_FLAVOUR_FALLBACK
        : section.source === "drinks" ? DRINK_FALLBACK
          : section.source === "cheese" ? [...CHEESE_OPTIONS]
            : section.source === "crust" ? [...CRUST_OPTIONS]
              : section.source === "bake_sauce" ? [...BAKE_SAUCE_OPTIONS]
                : section.source === "halal" ? [HALAL_OPTION]
                  : LEGACY_BASE_FALLBACK
    );
    return configured.map((entry) => ({ value: entry, label: entry }));
  };
  const valuesOf = (sectionId: string) => selected[sectionId] ?? [];
  const toggle = (section: ModifierSection, option: { value: string; label: string }) => setSelected((current) => {
    const values = current[section.id] ?? [];
    if (values.some((entry) => entry.value === option.value)) {
      return { ...current, [section.id]: values.filter((entry) => entry.value !== option.value) };
    }
    const next = { value: option.value, label: option.label, placement: section.source === "toppings" ? ("whole" as ToppingPlacement) : undefined };
    if (section.max === 1) return { ...current, [section.id]: [next] };
    if (values.length >= section.max) return current;
    return { ...current, [section.id]: [...values, next] };
  });
  const setPlacement = (sectionId: string, value: string, placement: ToppingPlacement) => setSelected((current) => ({
    ...current,
    [sectionId]: (current[sectionId] ?? []).map((entry) => entry.value === value ? { ...entry, placement } : entry),
  }));
  const halalFor = (section: ModifierSection) =>
    sections.some((candidate) => candidate.source === "halal" && candidate.group === section.group && valuesOf(candidate.id).length > 0);
  const unitsFor = (section: ModifierSection) =>
    modifierUnitsBps(normalizeModifierValues(valuesOf(section.id).map((entry) => ({ value: entry.value, placement: entry.placement }))), halfToppingUnitsBps);
  const valid = sections.every((section) => valuesOf(section.id).length >= section.min);
  let extras = 0;
  const sharedUnits = new Map<string, number>();
  for (const section of sections) {
    const values = valuesOf(section.id);
    extras += values.reduce((sum, entry) => sum + (section.optionPrices?.[entry.value] ?? 0), 0);
    if (section.source === "toppings") {
      const units = unitsFor(section);
      if (section.sharedGroup) sharedUnits.set(section.sharedGroup, (sharedUnits.get(section.sharedGroup) ?? 0) + units);
      else extras += priceToppingUnits(units, (section.included ?? 0) * 10_000, section.extraPriceCents ?? 0);
    } else {
      extras += Math.max(0, values.length - (section.included ?? section.max)) * (section.extraPriceCents ?? 0);
    }
  }
  for (const [group, units] of sharedUnits) {
    const grouped = sections.filter((section) => section.sharedGroup === group);
    extras += priceToppingUnits(units, (grouped[0]?.sharedIncluded ?? 0) * 10_000, grouped[0]?.extraPriceCents ?? 0);
  }
  const modifiers: ModifierSelection[] = sections
    .map((section) => ({ id: section.id, label: section.group ? `${section.group} · ${section.label}` : section.label, values: valuesOf(section.id) }))
    .filter((section) => section.values.length);
  // Step numbers and per-pizza headings are derived up front so nothing is mutated
  // while rendering.
  const layout = sections.map((section, index) => ({
    section,
    step: index + 1,
    groupHeading: section.group && section.group !== sections[index - 1]?.group ? section.group : null,
  }));
  return (
    <div className="modal-backdrop modal-backdrop--right" role="presentation" onMouseDown={onClose}>
      <section className="customizer" role="dialog" aria-modal="true" aria-labelledby="bundle-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="customizer-head"><div><p className="eyebrow dark"><span /> Complete your choices</p><h2 id="bundle-title">{product.name}</h2></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div>
        <div className="customizer-body">
          {layout.map(({ section, step, groupHeading }) => {
            const values = valuesOf(section.id);
            const included = section.sharedGroup ? section.sharedIncluded ?? 0 : section.included ?? 0;
            const isToppings = section.source === "toppings";
            const units = isToppings ? unitsFor(section) / 10_000 : values.length;
            const sectionExtras = isToppings && !section.sharedGroup
              ? priceToppingUnits(units * 10_000, included * 10_000, section.extraPriceCents ?? 0)
              : values.reduce((sum, entry) => sum + (section.optionPrices?.[entry.value] ?? 0), 0);
            return <div key={section.id}>
              {groupHeading ? <h3 className="section-group">{groupHeading}</h3> : null}
              <fieldset>
                <legend><span>{step}</span> {section.label}</legend>
                {isToppings ? <div className="setup-alert"><strong>{section.sharedGroup ? `${included} toppings shared across this deal` : `${included} toppings included in this price`}</strong><p>Each additional topping is {formatMoney(section.extraPriceCents ?? 0)}. A topping on half counts as {halfToppingUnitsBps === 10_000 ? "a full topping" : `${halfToppingUnitsBps / 10_000} of a topping`}.</p></div>
                  : section.source === "halal" ? <div className="setup-alert"><strong>Halal meat toppings</strong><p>{halalNotice}</p></div>
                    : section.extraPriceCents ? <div className="setup-alert"><strong>Optional add-on</strong><p>This choice adds {formatMoney(section.extraPriceCents)}.</p></div> : null}
                {isToppings
                  ? <ToppingPicker
                      toppings={toppings}
                      selected={values.map((entry) => ({ toppingId: entry.value, placement: entry.placement ?? "whole", name: entry.label }))}
                      halalOnly={halalFor(section)}
                      onToggle={(topping) => toggle(section, { value: topping.id, label: topping.name })}
                      onPlacement={(toppingId, placement) => setPlacement(section.id, toppingId, placement)}
                    />
                  : <div className="topping-grid">{optionsFor(section).map((option) => { const active = values.some((entry) => entry.value === option.value); const price = section.optionPrices?.[option.value]; return <button className={active ? "active" : ""} type="button" key={option.value} aria-pressed={active} onClick={() => toggle(section, option)}><span>{active ? "✓" : "+"}</span>{option.label}{price ? <small>+{formatMoney(price)}</small> : null}</button>; })}</div>}
                <div className="allowance-meter"><span>{isToppings ? `${formatUnits(units)} selected` : `${values.length} selected`}</span><b>{sectionExtras ? `${formatMoney(sectionExtras)} in extras` : section.min && values.length < section.min ? `Choose at least ${section.min}` : included ? `${included} included` : `Up to ${section.max}`}</b></div>
              </fieldset>
            </div>;
          })}
          <label className="instructions-label">Special instructions <small>Use this for requests the selectors do not cover.</small><textarea value={instructions} maxLength={500} onChange={(event) => setInstructions(event.target.value)} /></label>
        </div>
        <div className="customizer-footer"><div><small>Your item</small><strong>{formatMoney(product.base_price_cents + extras)}</strong></div><button className="primary-button" disabled={!valid} onClick={() => onAdd({ key: crypto.randomUUID(), productId: product.id, name: product.name, categoryId: product.category_id, quantity: 1, unitPriceCents: product.base_price_cents + extras, taxable: Boolean(product.taxable), modifiers, freeDelivery: Boolean(product.configuration.freeDelivery), specialInstructions: instructions.trim() })}>Add to order <ArrowIcon /></button></div>
      </section>
    </div>
  );
}

function CartDrawer({ cart, totals, fulfilment, onClose, onRemove, onCheckout }: { cart: CartLine[]; totals: ReturnType<typeof priceCart>; fulfilment: string; onClose: () => void; onRemove: (key: string) => void; onCheckout: () => void }) {
  return <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}><aside className="cart-drawer" aria-label="Your order" onMouseDown={(event) => event.stopPropagation()}><div className="drawer-head"><div><p className="eyebrow dark"><span /> {fulfilment}</p><h2>Your order</h2></div><button className="modal-close" onClick={onClose} aria-label="Close cart">×</button></div>
    <div className="cart-lines">{cart.length ? cart.map((line, index) => <article className="cart-line" key={line.key}><span className="line-number">{String(index + 1).padStart(2, "0")}</span><div><h3>{line.name}</h3>{line.variationName ? <p>{line.variationName}</p> : null}{line.extraCheese ? <small>Extra cheese</small> : null}{line.halal ? <small>Halal meat toppings</small> : null}{line.toppings?.map((entry) => <small key={entry.toppingId}>{entry.name}{placementSuffix(entry.placement)}</small>)}{line.modifiers?.map((modifier) => <small key={modifier.id}>{modifier.label}: {modifier.values.map((value) => `${value.label}${placementSuffix(value.placement ?? "whole")}`).join(", ")}</small>)}<button onClick={() => onRemove(line.key)}>Remove</button></div><strong>{formatMoney(line.unitPriceCents * line.quantity)}</strong></article>) : <div className="empty-cart"><PizzaMark large /><h3>Your bag is empty</h3><p>Add something delicious from the live menu.</p></div>}</div>
    <div className="cart-summary"><div><span>Menu subtotal</span><b>{formatMoney(totals.menuSubtotalCents)}</b></div><div><span>Estimated HST</span><b>{formatMoney(totals.taxCents)}</b></div>{fulfilment === "delivery" ? <div><span>Delivery</span><b>{formatMoney(totals.deliveryFeeCents)}</b></div> : null}<div className="cart-total"><span>Estimated total<small>Revalidated at checkout</small></span><b>{formatMoney(totals.totalCents)}</b></div><button className="primary-button" disabled={!cart.length} onClick={onCheckout}>Go to checkout <ArrowIcon /></button><p className="secure-note">Prices, availability, taxes and eligibility are checked again by Pizza 62 before an order is accepted.</p></div>
  </aside></div>;
}

function Checkout({ cart, fulfilment, settings, integrations, store, hours, timeZone, now, onClose, onConfirmed }: { cart: CartLine[]; fulfilment: "pickup" | "delivery"; settings: Catalog["settings"]; integrations: Catalog["integrations"]; store: StoreStatus; hours: WeeklyHours; timeZone: string; now: number; onClose: () => void; onConfirmed: (result: Record<string, unknown>) => void }) {
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [email, setEmail] = useState("");
  const [line1, setLine1] = useState(""); const [unit, setUnit] = useState(""); const [postalCode, setPostalCode] = useState(""); const [deliveryInstructions, setDeliveryInstructions] = useState("");
  const [tip, setTip] = useState(0); const [scheduleType, setScheduleType] = useState<"asap" | "scheduled">(store.open ? "asap" : "scheduled"); const [scheduledFor, setScheduledFor] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"pay_at_store" | "online">(fulfilment === "delivery" ? "online" : "pay_at_store");
  const [submitting, setSubmitting] = useState(false); const [error, setError] = useState("");
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
  const submit = async () => {
    setSubmitting(true); setError(""); analytics("payment_attempted", { paymentMethod });
    try {
      const response = await fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        idempotencyKey, fulfilment, customer: { name, phone, email }, items: cart.map((line) => ({ productId: line.productId, variationId: line.variationId, quantity: line.quantity, toppings: line.toppings?.map(({ toppingId, placement }) => ({ toppingId, placement })), modifiers: line.modifiers?.map((modifier) => ({ id: modifier.id, values: modifier.values.map((value) => value.placement ? { value: value.value, placement: value.placement } : value.value) })), extraCheese: line.extraCheese, halal: line.halal, specialInstructions: line.specialInstructions })), schedule: { type: scheduleType, scheduledFor: scheduleType === "scheduled" ? Number(scheduledFor) : undefined }, paymentMethod, tip: tip ? { type: "percentage", valueBps: tip } : { type: "none" }, address: fulfilment === "delivery" ? { line1, unit, city: "Hamilton", province: "ON", postalCode, instructions: deliveryInstructions } : undefined,
      }) });
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(String(result.error ?? result.message ?? "Order was not accepted."));
      // C-07: a terminal duplicate means the order already exists. Clear the key and
      // show the confirmation, otherwise the stale key would resolve every future
      // checkout from this browser to the same duplicate and block ordering for good.
      clearIdempotencyKey();
      if (result.duplicate) { onConfirmed(result); return; }
      if (typeof result.checkoutUrl === "string") { window.location.assign(result.checkoutUrl); return; }
      onConfirmed(result);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The order was not accepted."); setSubmitting(false); }
  };
  return <div className="modal-backdrop"><section className="checkout-modal" role="dialog" aria-modal="true" aria-labelledby="checkout-title"><button className="modal-close" onClick={onClose} aria-label="Close">×</button><p className="eyebrow dark"><span /> Secure checkout</p><h2 id="checkout-title">Finish your <em>{fulfilment}</em> order</h2>
    {fulfilment === "delivery" && !integrations.stripe ? <div className="setup-alert"><strong>Online delivery payment is ready for its Stripe key</strong><p>The ordering flow and 30-minute estimate are configured. Add the Stripe secrets in the hosting environment to accept delivery payment.</p></div> : null}
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
      <fieldset><legend>Payment</legend>{fulfilment === "pickup" ? <label className="payment-choice"><input type="radio" checked={paymentMethod === "pay_at_store"} onChange={() => setPaymentMethod("pay_at_store")} /><span><b>Pay at store</b><small>Cash, debit, or credit card</small></span></label> : null}<label className={`payment-choice ${integrations.stripe ? "" : "disabled"}`}><input type="radio" disabled={!integrations.stripe} checked={paymentMethod === "online"} onChange={() => setPaymentMethod("online")} /><span><b>Pay online with Stripe</b><small>{integrations.stripe ? "Secure hosted checkout" : "Add Stripe keys to enable"}</small></span></label></fieldset></div>
      <aside className="checkout-summary"><h3>Order summary</h3>{cart.map((line) => <div key={line.key}><span>{line.quantity} × {line.name}</span><b>{formatMoney(line.unitPriceCents * line.quantity)}</b></div>)}<hr /><p>Tip</p><div className="tip-grid"><button type="button" className={tip === 0 ? "active" : ""} onClick={() => setTip(0)}>None</button>{tipPresets.map((preset) => <button type="button" className={tip === preset ? "active" : ""} key={preset} onClick={() => setTip(preset)}>{preset / 100}%</button>)}</div><p className="tip-note">Percentage tips use the discounted menu subtotal before HST and exclude delivery.</p>{error ? <div className="form-error" role="alert">{error}</div> : null}<button className="primary-button" disabled={submitting || (paymentMethod === "online" && !integrations.stripe) || (scheduleType === "scheduled" && !scheduledFor)} onClick={submit}>{submitting ? "Confirming…" : paymentMethod === "online" ? "Continue to Stripe" : "Place pickup order"} <ArrowIcon /></button><small>Prices and choices are checked again by Pizza 62 before the order is accepted. Online card details stay with Stripe.</small></aside></div>
  </section></div>;
}

function Confirmation({ result, onClose }: { result: Record<string, unknown>; onClose: () => void }) {
  // C-07: a duplicate submission resolves to an order that already exists. Its
  // tracking/feedback tokens are stored only as hashes, so they cannot be re-issued
  // here — the links are omitted rather than rendered with an "undefined" token.
  const duplicate = result.duplicate === true;
  const orderNumber = String(result.orderNumber ?? "");
  const trackingUrl = result.trackingToken
    ? `/track?order=${encodeURIComponent(orderNumber)}&token=${encodeURIComponent(String(result.trackingToken))}`
    : null;
  const feedbackUrl = result.feedbackToken
    ? `/feedback?order=${encodeURIComponent(orderNumber)}&token=${encodeURIComponent(String(result.feedbackToken))}`
    : null;
  const estimateAt = Number(result.estimateAt);
  return <div className="modal-backdrop"><section className="confirmation-card" role="dialog" aria-modal="true"><div className="confirmation-check">✓</div><p className="eyebrow dark"><span /> Confirmed by Pizza 62</p><h2>{duplicate ? "This order is already in." : "You're all set."}</h2><p>{duplicate ? <>Order <strong>{orderNumber}</strong> was already placed, so we did not charge you twice or send a second order to the kitchen.</> : <>Order <strong>{orderNumber}</strong> is received and marked for payment at the store.</>}</p>{Number.isFinite(estimateAt) && estimateAt > 0 ? <div className="confirmation-estimate"><span>Estimated pickup</span><b>{new Date(estimateAt).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })}</b></div> : null}{trackingUrl ? <Link className="primary-button" href={trackingUrl}>Track your order <ArrowIcon /></Link> : <p className="confirmation-note">Use the tracking link from your original confirmation, or call Pizza 62 with order {orderNumber}.</p>}{feedbackUrl ? <Link className="text-button" href={feedbackUrl}>Open secure feedback link</Link> : null}<button className="text-button" onClick={onClose}>Back to the menu</button></section></div>;
}
