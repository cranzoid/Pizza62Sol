"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { formatMoney, priceCart, pricePizza, type ToppingPlacement } from "@/lib/domain";

type Category = { id: string; name: string; slug: string; description?: string | null };
type Product = {
  id: string;
  category_id: string;
  name: string;
  description: string;
  product_type: "pizza" | "simple" | "bundle";
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
};
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
  toppings?: Array<{ toppingId: string; placement: ToppingPlacement; name: string }>;
  extraCheese?: boolean;
  halal?: boolean;
  specialInstructions?: string;
};

const FALLBACK_PHONE = "(905) 547-5777";

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

  const phone =
    (catalog?.settings.business?.value.phone as string | undefined) ?? FALLBACK_PHONE;
  const ordering = catalog?.settings.ordering?.value ?? {};
  const operations = catalog?.settings.operations?.value ?? {};
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
        deliveryFeeCents: Number(catalog?.settings.delivery?.value.feeCents ?? 350),
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
    setGateMessage("This postal code may be serviceable. We'll verify your full address before payment.");
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
    });
  };

  const openProduct = (product: Product) => {
    analytics("product_viewed", { productId: product.id });
    if (product.product_type === "pizza") setSelectedProduct(product);
    else addSimple(product);
  };

  return (
    <div className="customer-site">
      <a className="skip-link" href="#menu">Skip to menu</a>
      <header className="public-header">
        <a className="brand" href="#top" aria-label="Pizza 62 home">
          <PizzaMark />
          <span className="brand-copy"><strong>Pizza 62</strong><small>Hamilton, Ontario</small></span>
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
            <p className="eyebrow"><span /> Hamilton-made since the first slice</p>
            <h1>Big flavour.<br /><em>Zero fuss.</em></h1>
            <p className="hero-lede">Hot pizza, honest prices, and the kind of local service that remembers your order.</p>
            <div className="hero-method" aria-label="Choose how to get your order">
              <button className={fulfilment === "delivery" ? "active" : ""} onClick={() => chooseFulfilment("delivery")}>
                <span className="method-icon">D</span><span><b>Delivery</b><small>To your door</small></span><ArrowIcon />
              </button>
              <button className={fulfilment === "pickup" ? "active" : ""} onClick={() => chooseFulfilment("pickup")}>
                <span className="method-icon">P</span><span><b>Pickup</b><small>Ready from 15 min</small></span><ArrowIcon />
              </button>
            </div>
            <div className="hero-note"><span className="pulse-dot" /> Ordering status: {ordering.paused ? "temporarily paused" : "accepting orders"}</div>
          </div>
          <div className="hero-art" aria-label="A playful illustration of a fresh Pizza 62 pizza">
            <div className="pizza-scene">
              <div className="pizza-shadow" />
              <div className="pizza-disc">
                <span className="topping pepperoni p1" /><span className="topping pepperoni p2" /><span className="topping pepperoni p3" />
                <span className="topping basil b1" /><span className="topping basil b2" /><span className="topping basil b3" />
                <span className="topping onion o1" /><span className="topping onion o2" />
                <span className="pizza-slice-line l1" /><span className="pizza-slice-line l2" /><span className="pizza-slice-line l3" />
                <PizzaMark large />
              </div>
              <div className="floating-tag floating-tag--top"><small>FROM</small><strong>$8.40</strong><span>medium</span></div>
              <div className="floating-tag floating-tag--bottom"><strong>13%</strong><span>HST, calculated right</span></div>
              <div className="scribble-note">made fresh<br />for Hamilton ↗</div>
            </div>
          </div>
          <div className="hero-marquee" aria-hidden="true"><span>PIZZA • WINGS • DEALS • PICKUP • DELIVERY • HAMILTON •&nbsp;</span><span>PIZZA • WINGS • DEALS • PICKUP • DELIVERY • HAMILTON •</span></div>
        </section>

        <section className="promise-strip" aria-label="Pizza 62 ordering promises">
          <div><b>01</b><span><strong>Built your way</strong><small>Whole, left, or right toppings</small></span></div>
          <div><b>02</b><span><strong>Clear totals</strong><small>No surprise math at checkout</small></span></div>
          <div><b>03</b><span><strong>Local & direct</strong><small>Order straight from Pizza 62</small></span></div>
          <div><b>04</b><span><strong>Track every step</strong><small>Private, secure order updates</small></span></div>
        </section>

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
                  {products.map((product, index) => (
                    <article className={`product-card product-card--${(index % 4) + 1}`} key={product.id}>
                      <div className="product-visual" aria-hidden="true">
                        {product.product_type === "pizza" ? <div className="mini-pizza"><i /><i /><i /><i /></div> : product.product_type === "bundle" ? <div className="deal-type">DEAL<br />{String(index + 1).padStart(2, "0")}</div> : <div className="dip-cup">62</div>}
                        {product.setup_required ? <span className="setup-ribbon">Setup required</span> : null}
                      </div>
                      <div className="product-content">
                        <div className="product-kicker">{product.product_type === "bundle" ? "Family favourite" : product.product_type === "pizza" ? "Make it yours" : "The essentials"}</div>
                        <h4>{product.name}</h4>
                        <p>{product.description}</p>
                        <div className="product-footer"><span><small>{product.product_type === "pizza" ? "from" : ""}</small>{formatMoney(product.base_price_cents)}</span>
                          <button disabled={Boolean(product.setup_required || product.sold_out)} onClick={() => openProduct(product)}>
                            {product.sold_out ? "Sold out" : product.setup_required ? "Owner setup" : product.product_type === "pizza" ? "Customize" : "Add"}<ArrowIcon />
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            );
          })}
        </section>

        <section className="deal-feature" id="deals">
          <div className="deal-stamp">PICKUP<br /><b>ONLY</b></div>
          <div className="deal-copy"><p className="eyebrow"><span /> Pick it up & save</p><h2>Two large.<br /><em>Six toppings.</em></h2><p>Split all six included toppings across both pizzas any way you want.</p></div>
          <div className="deal-price"><span>ONLY</span><strong><small>$</small>27<sup>99</sup></strong><button disabled>Complete owner setup <ArrowIcon /></button></div>
        </section>

        <section className="hours-section" id="hours">
          <div><p className="eyebrow dark"><span /> Hamilton&apos;s neighbourhood pizza</p><h2>Hot, local,<br /><em>ready when you are.</em></h2><p>Pickup at Pizza 62 or choose delivery after your address is verified.</p><a href={`tel:${phone.replace(/[^0-9+]/g, "")}`}>Call {phone} <ArrowIcon /></a></div>
          <div className="hours-card"><div className="hours-card-title"><span>Weekly hours</span><i>Hamilton time</i></div>
            {["Mon — Wed|11 AM – 10 PM", "Thursday|11 AM – 11 PM", "Fri — Sat|11 AM – Midnight", "Sunday|12 PM – 10 PM"].map((entry) => { const [day, time] = entry.split("|"); return <div className="hours-row" key={day}><span>{day}</span><b>{time}</b></div>; })}
            <small>Online orders are accepted until the configured closing time.</small>
          </div>
        </section>
      </main>

      <footer className="public-footer">
        <div className="footer-brand"><PizzaMark /><strong>Pizza 62</strong><p>Hamilton pizza made for real life.</p></div>
        <div><b>Order</b><a href="#menu">Menu</a><a href="#deals">Deals</a><Link href="/track">Track an order</Link></div>
        <div><b>Information</b><a href="#hours">Hours & delivery</a><Link href="/privacy">Privacy</Link><Link href="/accessibility">Accessibility</Link></div>
        <div><b>Restaurant</b><a href={`tel:${phone.replace(/[^0-9+]/g, "")}`}>{phone}</a><Link href="/admin">Staff portal</Link></div>
        <small>© {new Date().getFullYear()} Pizza 62. Prices shown in Canadian dollars.</small>
      </footer>

      {deliveryGate ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setDeliveryGate(false)}>
          <div className="delivery-gate" role="dialog" aria-modal="true" aria-labelledby="delivery-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setDeliveryGate(false)} aria-label="Close">×</button>
            <div className="gate-number">01</div><p className="eyebrow dark"><span /> Quick delivery check</p>
            <h2 id="delivery-title">Are we in your<br /><em>neighbourhood?</em></h2>
            <p>Enter your postal code for an initial screen. The delivery fee is shown later, and your full address is verified before payment.</p>
            <label>Postal code<input autoFocus value={postalCode} onChange={(event) => setPostalCode(event.target.value)} placeholder="L8K 4S2" autoComplete="postal-code" /></label>
            {gateMessage ? <div className={gateMessage.startsWith("This") ? "gate-success" : "gate-error"} role="status">{gateMessage}</div> : null}
            <button className="primary-button" onClick={screenPostalCode}>Check my area <ArrowIcon /></button>
            <button className="text-button" onClick={() => chooseFulfilment("pickup")}>I&apos;ll pick it up instead</button>
          </div>
        </div>
      ) : null}

      {selectedProduct && catalog ? (
        <PizzaCustomizer
          product={selectedProduct}
          variations={catalog.variations.filter((variation) => variation.product_id === selectedProduct.id)}
          toppings={catalog.toppings}
          halfWeight={Number(operations.halfToppingUnitsBps ?? 10_000)}
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
          onClose={() => setCheckoutOpen(false)}
          onConfirmed={(result) => { setCheckoutOpen(false); setCart([]); setConfirmation(result); analytics("purchase_completed", { orderNumber: result.orderNumber }); }}
        />
      ) : null}

      {confirmation ? (
        <Confirmation result={confirmation} onClose={() => setConfirmation(null)} />
      ) : null}
    </div>
  );
}

function PizzaCustomizer({
  product,
  variations,
  toppings,
  halfWeight,
  onClose,
  onAdd,
}: {
  product: Product;
  variations: Variation[];
  toppings: Topping[];
  halfWeight: number;
  onClose: () => void;
  onAdd: (line: CartLine) => void;
}) {
  const [variationId, setVariationId] = useState(variations[0]?.id ?? "");
  const [placement, setPlacement] = useState<ToppingPlacement>("whole");
  const [selected, setSelected] = useState<Array<{ toppingId: string; placement: ToppingPlacement; name: string }>>([]);
  const [extraCheese, setExtraCheese] = useState(false);
  const [halal, setHalal] = useState(false);
  const [instructions, setInstructions] = useState("");
  const variation = variations.find((entry) => entry.id === variationId) ?? variations[0];
  const price = variation
    ? pricePizza({
        basePriceCents: variation.base_price_cents,
        extraToppingPriceCents: variation.extra_topping_price_cents,
        includedToppingUnitsBps: variation.included_topping_units_bps,
        halfToppingUnitsBps: halfWeight,
        toppings: selected,
        extraCheese,
      })
    : null;
  const toggleTopping = (topping: Topping) => {
    setSelected((current) => {
      const existing = current.find((entry) => entry.toppingId === topping.id && entry.placement === placement);
      if (existing) return current.filter((entry) => entry !== existing);
      const withoutWholeConflict = current.filter((entry) =>
        entry.toppingId !== topping.id || (placement !== "whole" && entry.placement !== "whole"),
      );
      return [...withoutWholeConflict, { toppingId: topping.id, placement, name: topping.name }];
    });
  };
  return (
    <div className="modal-backdrop modal-backdrop--right" role="presentation" onMouseDown={onClose}>
      <section className="customizer" role="dialog" aria-modal="true" aria-labelledby="customizer-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="customizer-head"><div><p className="eyebrow dark"><span /> Build it your way</p><h2 id="customizer-title">{product.name}</h2></div><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div>
        <div className="customizer-body">
          <fieldset><legend><span>1</span> Choose your size</legend><div className="size-options">{variations.map((item) => <label key={item.id} className={item.id === variationId ? "selected" : ""}><input type="radio" name="size" value={item.id} checked={item.id === variationId} onChange={() => setVariationId(item.id)} /><span><b>{item.name}</b><small>{formatMoney(item.base_price_cents)}</small></span></label>)}</div></fieldset>
          <fieldset><legend><span>2</span> Cheese & halal</legend><div className="choice-list"><label><input type="checkbox" checked={extraCheese} onChange={(event) => setExtraCheese(event.target.checked)} /><span><b>Extra cheese</b><small>Counts as one topping</small></span><em>{variation ? `+${formatMoney(variation.extra_topping_price_cents)}` : ""}</em></label><label><input type="checkbox" checked={halal} onChange={(event) => setHalal(event.target.checked)} /><span><b>Halal selection</b><small>Uses configured halal meat versions where available</small></span><em>No surcharge</em></label></div></fieldset>
          <fieldset><legend><span>3</span> Choose toppings</legend><div className="placement-tabs"><button className={placement === "whole" ? "active" : ""} onClick={() => setPlacement("whole")} type="button">Whole</button><button className={placement === "left" ? "active" : ""} onClick={() => setPlacement("left")} type="button">Left half</button><button className={placement === "right" ? "active" : ""} onClick={() => setPlacement("right")} type="button">Right half</button></div>
            {toppings.length ? <div className="topping-grid">{toppings.map((topping) => { const active = selected.some((entry) => entry.toppingId === topping.id && entry.placement === placement); return <button className={active ? "active" : ""} type="button" key={topping.id} onClick={() => toggleTopping(topping)}><span>{active ? "✓" : "+"}</span>{topping.name}{halal && topping.is_meat && topping.has_halal_version && topping.halal_available ? <small>Halal</small> : null}</button>; })}</div> : <div className="setup-empty"><strong>Toppings await owner setup</strong><p>The pricing and placement engine is ready. No unconfirmed topping list has been published.</p></div>}
            <div className="allowance-meter"><span>{price ? price.toppingUnitsBps / 10_000 : 0} topping units selected</span><b>{price?.extraToppingTotalCents ? `${formatMoney(price.extraToppingTotalCents)} in extras` : "No extras"}</b></div>
          </fieldset>
          <label className="instructions-label">Special instructions <small>We&apos;ll do our best, but allergy and separation claims require restaurant confirmation.</small><textarea value={instructions} maxLength={500} onChange={(event) => setInstructions(event.target.value)} placeholder="Anything the kitchen should know?" /></label>
        </div>
        <div className="customizer-footer"><div><small>Your pizza</small><strong>{price ? formatMoney(price.totalCents) : "—"}</strong></div><button className="primary-button" disabled={!variation} onClick={() => variation && price && onAdd({ key: crypto.randomUUID(), productId: product.id, name: product.name, categoryId: product.category_id, variationId: variation.id, variationName: variation.name, quantity: 1, unitPriceCents: price.totalCents, taxable: Boolean(product.taxable), toppings: selected, extraCheese, halal, specialInstructions: instructions.trim() })}>Add to order <ArrowIcon /></button></div>
      </section>
    </div>
  );
}

function CartDrawer({ cart, totals, fulfilment, onClose, onRemove, onCheckout }: { cart: CartLine[]; totals: ReturnType<typeof priceCart>; fulfilment: string; onClose: () => void; onRemove: (key: string) => void; onCheckout: () => void }) {
  return <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}><aside className="cart-drawer" aria-label="Your order" onMouseDown={(event) => event.stopPropagation()}><div className="drawer-head"><div><p className="eyebrow dark"><span /> {fulfilment}</p><h2>Your order</h2></div><button className="modal-close" onClick={onClose} aria-label="Close cart">×</button></div>
    <div className="cart-lines">{cart.length ? cart.map((line, index) => <article className="cart-line" key={line.key}><span className="line-number">{String(index + 1).padStart(2, "0")}</span><div><h3>{line.name}</h3>{line.variationName ? <p>{line.variationName}</p> : null}{line.extraCheese ? <small>Extra cheese</small> : null}{line.halal ? <small>Halal selection</small> : null}{line.toppings?.map((entry) => <small key={`${entry.toppingId}-${entry.placement}`}>{entry.name} · {entry.placement}</small>)}<button onClick={() => onRemove(line.key)}>Remove</button></div><strong>{formatMoney(line.unitPriceCents * line.quantity)}</strong></article>) : <div className="empty-cart"><PizzaMark large /><h3>Your bag is empty</h3><p>Add something delicious from the live menu.</p></div>}</div>
    <div className="cart-summary"><div><span>Menu subtotal</span><b>{formatMoney(totals.menuSubtotalCents)}</b></div><div><span>Estimated HST</span><b>{formatMoney(totals.taxCents)}</b></div>{fulfilment === "delivery" ? <div><span>Delivery</span><b>{formatMoney(totals.deliveryFeeCents)}</b></div> : null}<div className="cart-total"><span>Estimated total<small>Revalidated at checkout</small></span><b>{formatMoney(totals.totalCents)}</b></div><button className="primary-button" disabled={!cart.length} onClick={onCheckout}>Go to checkout <ArrowIcon /></button><p className="secure-note">Prices, availability, taxes and eligibility are checked again by Pizza 62 before an order is accepted.</p></div>
  </aside></div>;
}

function Checkout({ cart, fulfilment, settings, onClose, onConfirmed }: { cart: CartLine[]; fulfilment: "pickup" | "delivery"; settings: Catalog["settings"]; onClose: () => void; onConfirmed: (result: Record<string, unknown>) => void }) {
  const [name, setName] = useState(""); const [phone, setPhone] = useState(""); const [email, setEmail] = useState("");
  const [tip, setTip] = useState(0); const [scheduleType, setScheduleType] = useState<"asap" | "scheduled">("asap"); const [scheduledFor, setScheduledFor] = useState("");
  const [submitting, setSubmitting] = useState(false); const [error, setError] = useState("");
  const tipPresets = (settings.taxAndTips?.value.tipPresetBps as number[] | undefined) ?? [1000, 1500, 1800];
  const submit = async () => {
    setSubmitting(true); setError(""); analytics("payment_attempted", { paymentMethod: "pay_at_store" });
    try {
      const response = await fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(), fulfilment, customer: { name, phone, email }, items: cart.map((line) => ({ productId: line.productId, variationId: line.variationId, quantity: line.quantity, toppings: line.toppings?.map(({ toppingId, placement }) => ({ toppingId, placement })), extraCheese: line.extraCheese, halal: line.halal, specialInstructions: line.specialInstructions })), schedule: { type: scheduleType, scheduledFor: scheduleType === "scheduled" ? new Date(scheduledFor).getTime() : undefined }, paymentMethod: "pay_at_store", tip: tip ? { type: "percentage", valueBps: tip } : { type: "none" },
      }) });
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok || result.duplicate) throw new Error(String(result.error ?? result.message ?? "Order was not accepted."));
      onConfirmed(result);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The order was not accepted."); setSubmitting(false); }
  };
  return <div className="modal-backdrop"><section className="checkout-modal" role="dialog" aria-modal="true" aria-labelledby="checkout-title"><button className="modal-close" onClick={onClose} aria-label="Close">×</button><p className="eyebrow dark"><span /> Secure checkout</p><h2 id="checkout-title">Finish your <em>{fulfilment}</em> order</h2>
    {fulfilment === "delivery" ? <div className="setup-alert"><strong>Delivery setup is not complete</strong><p>The owner must configure the restaurant origin, address validation, a delivery estimate, and online payments. No delivery order or payment can be falsely confirmed.</p></div> : null}
    <div className="checkout-grid"><div><fieldset><legend>Contact details</legend><label>Full name<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" /></label><label>Phone<input value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" inputMode="tel" /></label><label>Email<input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" inputMode="email" /></label></fieldset>
      <fieldset><legend>When?</legend><div className="checkout-options"><label className={scheduleType === "asap" ? "selected" : ""}><input type="radio" checked={scheduleType === "asap"} onChange={() => setScheduleType("asap")} />ASAP <small>About {String(settings.ordering?.value.pickupEstimateMinutes ?? 15)} min</small></label><label className={scheduleType === "scheduled" ? "selected" : ""}><input type="radio" checked={scheduleType === "scheduled"} onChange={() => setScheduleType("scheduled")} />Schedule later</label></div>{scheduleType === "scheduled" ? <label>Pickup time<input type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} /></label> : null}</fieldset>
      <fieldset><legend>Payment</legend><label className="payment-choice"><input type="radio" checked readOnly /><span><b>Pay at store</b><small>Cash, debit, or credit card</small></span></label><label className="payment-choice disabled"><input type="radio" disabled /><span><b>Pay online</b><small>Available after payment provider setup</small></span></label></fieldset></div>
      <aside className="checkout-summary"><h3>Order summary</h3>{cart.map((line) => <div key={line.key}><span>{line.quantity} × {line.name}</span><b>{formatMoney(line.unitPriceCents * line.quantity)}</b></div>)}<hr /><p>Tip</p><div className="tip-grid"><button className={tip === 0 ? "active" : ""} onClick={() => setTip(0)}>None</button>{tipPresets.map((preset) => <button className={tip === preset ? "active" : ""} key={preset} onClick={() => setTip(preset)}>{preset / 100}%</button>)}</div><p className="tip-note">Percentage tips use the discounted menu subtotal before HST and exclude delivery.</p>{error ? <div className="form-error" role="alert">{error}</div> : null}<button className="primary-button" disabled={submitting || fulfilment === "delivery"} onClick={submit}>{submitting ? "Confirming…" : "Place pickup order"} <ArrowIcon /></button><small>By placing this order, you ask Pizza 62 to prepare it. A successful screen appears only after the server confirms acceptance.</small></aside></div>
  </section></div>;
}

function Confirmation({ result, onClose }: { result: Record<string, unknown>; onClose: () => void }) {
  const trackingUrl = `/track?order=${encodeURIComponent(String(result.orderNumber))}&token=${encodeURIComponent(String(result.trackingToken))}`;
  const feedbackUrl = `/feedback?order=${encodeURIComponent(String(result.orderNumber))}&token=${encodeURIComponent(String(result.feedbackToken))}`;
  return <div className="modal-backdrop"><section className="confirmation-card" role="dialog" aria-modal="true"><div className="confirmation-check">✓</div><p className="eyebrow dark"><span /> Confirmed by Pizza 62</p><h2>You&apos;re all set.</h2><p>Order <strong>{String(result.orderNumber)}</strong> is received and marked for payment at the store.</p><div className="confirmation-estimate"><span>Estimated pickup</span><b>{new Date(Number(result.estimateAt)).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })}</b></div><Link className="primary-button" href={trackingUrl}>Track your order <ArrowIcon /></Link><Link className="text-button" href={feedbackUrl}>Open secure feedback link</Link><button className="text-button" onClick={onClose}>Back to the menu</button></section></div>;
}
