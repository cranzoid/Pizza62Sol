"use client";

/**
 * Taking an order at the counter or on the phone.
 *
 * Written for someone standing at a till with a customer waiting, which sets
 * every decision here: the menu is a grid of buttons rather than a catalogue,
 * quantities adjust in place, and the total is always on screen. Nothing is
 * hidden behind a step.
 *
 * The total comes from the server on every change, from the same pricing path
 * the website uses. That is the point of the whole feature — a counter order
 * priced by a second implementation is how a restaurant ends up with two sets of
 * books, and it is also how the HST on the day's takings stops adding up.
 *
 * **The whole menu can be rung in.** Anything needing a choice made about it —
 * a pizza and its three toppings, a two-pizza deal, a pound of wings, the pops
 * that come with a combo — used to be excluded here, on the grounds that a
 * half-built customizer written for a till screen produces orders the kitchen
 * cannot read. That was true of writing a second one. It is not a reason to
 * write none: the counter takes the phone calls, and the phone is where the
 * complicated orders arrive. So the till mounts the *same* customizer the
 * website does (`app/menu/ItemCustomizer.tsx`), which means a pizza rung in here
 * is built from the same steps, priced by the same code, and reaches the kitchen
 * in the same shape as one ordered online. What was excluded was never the
 * counter's rare traffic; it was most of the menu.
 *
 * **A phone order can be a delivery.** It was pickup-only, which meant the one
 * thing the phone is actually used for — "can you bring it round" — had to be
 * written on paper and kept out of the system entirely, taking the address, the
 * delivery fee and the HST on it with it. The address goes through exactly the
 * same validation as a website order: same Hamilton/postal-code check, same
 * radius test against the store origin, same fee. An address the website would
 * refuse is refused here too, and the counter is told why.
 */

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/lib/domain";
import { buildPassPrntDrawerUri, buildPassPrntUri, shouldUsePassPrnt } from "@/lib/passprnt";
import {
  GenericCustomizer,
  PizzaCustomizer,
  needsCustomizing,
  placementSuffix,
  toOrderItems,
  type BuiltItem,
  type CustomizerProduct,
} from "@/app/menu/ItemCustomizer";
import type { Dashboard } from "@/app/staff/StaffPortal";

/**
 * Two identical items are one line with a quantity of two; two pizzas built
 * differently are two lines.
 *
 * Merging on the product alone was safe while nothing here could be customized.
 * It is not any more: a pepperoni and a Hawaiian are both "Large Pizza", and
 * collapsing them would send one of the two to the kitchen as a copy of the
 * other. So the whole build is the identity — every choice, in a stable order,
 * because `{cheese, crust}` and `{crust, cheese}` are the same pizza and must
 * stringify the same way.
 */
function buildSignature(item: BuiltItem): string {
  return JSON.stringify([
    item.productId,
    item.variationId ?? "",
    [...(item.toppings ?? [])].map((entry) => `${entry.toppingId}:${entry.placement}`).sort(),
    [...(item.modifiers ?? [])]
      .map((modifier) => `${modifier.id}=${[...modifier.values].map((value) => `${value.value}:${value.placement ?? "whole"}`).sort().join("|")}`)
      .sort(),
    [...(item.omitToppings ?? [])].sort(),
    Boolean(item.extraCheese),
    Boolean(item.halal),
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
  if (item.halal) parts.push("Halal meat");
  if (item.extraCheese) parts.push("Extra cheese");
  for (const topping of item.toppings ?? []) parts.push(`${topping.name}${placementSuffix(topping.placement)}`);
  for (const toppingId of item.omitToppings ?? []) parts.push(`No ${toppingNames.get(toppingId) ?? toppingId}`);
  for (const modifier of item.modifiers ?? []) {
    parts.push(`${modifier.label}: ${modifier.values.map((value) => `${value.label}${placementSuffix(value.placement ?? "whole")}`).join(", ")}`);
  }
  if (item.specialInstructions) parts.push(item.specialInstructions);
  return parts;
}

type Quote = {
  ok: boolean;
  totals: { menuSubtotalCents: number; discountCents: number; taxCents: number; deliveryFeeCents: number; totalCents: number };
  issues: Array<{ index: number | null; message: string }>;
};

type PlacedOrder = {
  duplicate?: boolean;
  orderNumber?: string;
  printOrder?: Record<string, unknown> | null;
  error?: string;
};

export function StaffOrderEntry({ dashboard, onPlaced }: { dashboard: Dashboard; onPlaced: () => Promise<void> }) {
  const [channel, setChannel] = useState<"walk_in" | "phone">("walk_in");
  const [fulfilment, setFulfilment] = useState<"pickup" | "delivery">("pickup");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [line1, setLine1] = useState("");
  const [unit, setUnit] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [deliveryInstructions, setDeliveryInstructions] = useState("");
  const [lines, setLines] = useState<BuiltItem[]>([]);
  // The product whose customizer is open, if any.
  const [building, setBuilding] = useState<CustomizerProduct | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [lastPrintOrder, setLastPrintOrder] = useState<Record<string, unknown> | null>(null);
  const [search, setSearch] = useState("");

  /**
   * What is on the menu right now, for this kind of order.
   *
   * The only exclusions left are the ones the server would enforce anyway:
   * hidden, sold out, waiting on owner setup, or not offered for the fulfilment
   * the counter has selected. Offering a pickup-only special on a delivery
   * ticket produces an order that is rejected after it has been keyed in with a
   * customer on the phone.
   */
  const sellable = dashboard.products.filter((product) => {
    if (!product.active || product.sold_out || product.setup_required) return false;
    return Boolean(fulfilment === "delivery" ? product.delivery_eligible : product.pickup_eligible);
  });

  // Read straight off the same settings row the storefront reads, so a pizza
  // built at the counter is charged for a half topping exactly as one built at
  // home is.
  const operations = (dashboard.settings.operations?.value ?? {}) as Record<string, unknown>;
  const halalNotice = String(operations.halalNotice ?? "Halal meat options use a shared kitchen.");
  const halfToppingUnitsBps = Number(operations.halfToppingUnitsBps ?? 10_000);
  const activeToppings = dashboard.toppings.filter((topping) => topping.active);
  const toppingNames = new Map(dashboard.toppings.map((topping) => [topping.id, topping.name]));
  const buildingVariations = building
    ? dashboard.variations.filter((variation) => variation.product_id === building.id && variation.active)
    : [];

  const matching = search.trim()
    ? sellable.filter((product) => product.name.toLowerCase().includes(search.trim().toLowerCase()))
    : sellable;

  const body = useCallback(
    (extra: Record<string, unknown> = {}) => ({
      channel,
      fulfilment,
      customer: { name: name.trim() || "Counter", phone: phone.trim(), email: email.trim() },
      // Encoded by the same function the website uses, so "extra cheese, no
      // mushrooms, sauce on the side" survives the trip from a phone call
      // exactly as it does from a browser.
      items: toOrderItems(lines),
      schedule: { type: "asap" as const },
      paymentMethod: "pay_at_store" as const,
      tip: { type: "none" as const },
      // City and province are fixed rather than asked for: the delivery area is
      // a radius around one Hamilton store, so any other answer is an address
      // the radius check would reject anyway, and two more fields to mistype
      // while a customer is on the phone.
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
    [channel, fulfilment, name, phone, email, line1, unit, postalCode, deliveryInstructions, lines],
  );

  // Re-priced by the server on every change. Sequenced so a slow earlier reply
  // cannot overwrite a newer total while someone is adding items quickly.
  const serialized = JSON.stringify(body({ quoteOnly: true }));
  useEffect(() => {
    if (!lines.length) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const response = await fetch("/api/admin/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: serialized,
        });
        const result = (await response.json()) as Quote;
        if (!cancelled && response.ok) setQuote(result);
      })();
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [serialized, lines.length]);

  const totals = quote?.totals ?? { menuSubtotalCents: 0, discountCents: 0, taxCents: 0, deliveryFeeCents: 0, totalCents: 0 };

  /**
   * Puts a built item on the receipt.
   *
   * An identical build adds a quantity rather than a second line — a till that
   * shows "1 × Poutine" four times is harder to check against the bag — but two
   * pizzas built differently stay apart, because they are different pizzas.
   */
  const add = (item: BuiltItem) => {
    setMessage(null);
    setBuilding(null);
    setLines((current) => {
      const signature = buildSignature(item);
      const existing = current.find((line) => buildSignature(line) === signature);
      if (existing) {
        return current.map((line) => (line === existing ? { ...line, quantity: line.quantity + item.quantity } : line));
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
        .map((line) => (line.key === key ? { ...line, quantity: line.quantity + delta } : line))
        .filter((line) => line.quantity > 0),
    );

  // Its own control rather than "press − until it disappears". Taking a wrong
  // item off a six-quantity line meant six taps, and a till that makes undoing a
  // mistake slower than making it is a till people work around.
  const removeLine = (key: string) => setLines((current) => current.filter((line) => line.key !== key));

  const passPrntCallback = () => {
    const callback = new URL(window.location.href);
    callback.searchParams.delete("passprnt_code");
    callback.searchParams.delete("passprnt_message");
    return callback.toString();
  };

  const printPlacedOrder = (order: Record<string, unknown>, printedAt: number): boolean => {
    if (!shouldUsePassPrnt(window.navigator.userAgent)) return false;
    // Counter entry does not distinguish cash from card, so automatic printing
    // must never kick the drawer. Opening it is always a separate staff tap.
    window.location.assign(buildPassPrntUri({
      order,
      toppingNames,
      printedAt,
      callbackUrl: passPrntCallback(),
    }));
    return true;
  };

  // The till is where the cash actually changes hands, so the drawer belongs on
  // this screen too rather than only on the Live orders board. Kept inside the
  // click handler: Android allows the PassPRNT handoff only on a direct gesture.
  const openCashDrawer = () => {
    if (!shouldUsePassPrnt(window.navigator.userAgent)) return;
    window.location.assign(buildPassPrntDrawerUri({ callbackUrl: passPrntCallback() }));
  };

  const place = async (printRequestedAt: number) => {
    setSubmitting(true);
    setMessage(null);
    const response = await fetch("/api/admin/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body({ idempotencyKey: `staff-${crypto.randomUUID()}-${crypto.randomUUID()}` })),
    });
    const result = (await response.json()) as PlacedOrder;
    setSubmitting(false);
    if (!response.ok) {
      setMessage({ tone: "bad", text: result.error ?? "That order could not be created." });
      return;
    }
    const printable = !result.duplicate && result.printOrder ? result.printOrder : null;
    const willPrint = Boolean(printable && shouldUsePassPrnt(window.navigator.userAgent));
    setLastPrintOrder(printable);
    setMessage({
      tone: "ok",
      text: willPrint
        ? `${result.orderNumber} is in. Sending its ticket to the printer…`
        : `${result.orderNumber} is in. It is on the kitchen board now.`,
    });
    setLines([]);
    setName("");
    setPhone("");
    setEmail("");
    setLine1("");
    setUnit("");
    setPostalCode("");
    setDeliveryInstructions("");
    setQuote(null);
    // Launch before refreshing. Android permits the external-app handoff only
    // while this still belongs to the staff member's placement tap; an extra
    // dashboard round trip can lose it.
    if (printable) printPlacedOrder(printable, printRequestedAt);
    await onPlaced();
  };

  return (
    <div className="admin-stack admin-controls">
      <section className="staff-panel">
        <div className="staff-panel-head">
          <h2>Take an order</h2>
          <div className="segmented-range" role="group" aria-label="Where the order came from">
            <button className={channel === "walk_in" ? "active" : ""} aria-pressed={channel === "walk_in"} onClick={() => setChannel("walk_in")}>Walk-in</button>
            <button className={channel === "phone" ? "active" : ""} aria-pressed={channel === "phone"} onClick={() => setChannel("phone")}>Phone</button>
          </div>
        </div>
        <p className="editor-hint">
          Rung in here, an order is priced and taxed exactly like a website order and goes straight to the kitchen
          board. Only a name is needed — add an email if the customer wants a confirmation and the updates that
          follow it. A delivery needs a phone number and an address inside the delivery area.
        </p>
        <div className="segmented-range till-fulfilment" role="group" aria-label="Pickup or delivery">
          <button className={fulfilment === "pickup" ? "active" : ""} aria-pressed={fulfilment === "pickup"} onClick={() => setFulfilment("pickup")}>Pickup</button>
          <button className={fulfilment === "delivery" ? "active" : ""} aria-pressed={fulfilment === "delivery"} onClick={() => setFulfilment("delivery")}>Delivery</button>
        </div>
        <div className="settings-form">
          <label>Name for the order<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Counter" /></label>
          <label>{fulfilment === "delivery" ? "Phone · for the driver" : "Phone · optional"}<input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" /></label>
          <label>Email · optional<input value={email} onChange={(event) => setEmail(event.target.value)} inputMode="email" /></label>
        </div>
        {/* The delivery fee, the radius check and the minimum all key off this,
            and all three are enforced on the server — the same code path a
            website delivery goes through. Nothing here is trusted. */}
        {fulfilment === "delivery" ? (
          <>
            <div className="settings-form">
              <label>Street address<input value={line1} onChange={(event) => setLine1(event.target.value)} placeholder="123 King St E" autoComplete="off" /></label>
              <label>Unit · optional<input value={unit} onChange={(event) => setUnit(event.target.value)} autoComplete="off" /></label>
              <label>Postal code<input value={postalCode} onChange={(event) => setPostalCode(event.target.value.toUpperCase())} placeholder="L8N 1B2" autoComplete="off" spellCheck={false} /></label>
              <label>Buzzer or directions · optional<input value={deliveryInstructions} onChange={(event) => setDeliveryInstructions(event.target.value)} autoComplete="off" /></label>
            </div>
            <p className="editor-hint">Hamilton, ON only — that is the whole delivery area, so the city is filled in for you. The address is checked against the delivery radius when the order is placed.</p>
          </>
        ) : null}
      </section>

      <div className="staff-grid">
        <section className="staff-panel">
          <div className="staff-panel-head"><h2>Menu</h2><span className="live-chip">{matching.length} items</span></div>
          <input className="till-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search the menu" aria-label="Search the menu" />
          <div className="till-grid">
            {matching.map((product) => {
              const variations = dashboard.variations.filter((variation) => variation.product_id === product.id && variation.active);
              // Anything with choices to make is one button that opens the
              // customizer — including a pizza, whose sizes are choices made
              // *inside* it. Listing a size per button would put the counter
              // one tap from a pizza with no toppings on it.
              if (needsCustomizing(product)) {
                const from = variations.length
                  ? Math.min(...variations.map((variation) => variation.base_price_cents))
                  : product.base_price_cents;
                return (
                  <button className="till-button till-button--choices" key={product.id} onClick={() => setBuilding(product)}>
                    <strong>{product.name}</strong>
                    <span>Choices…</span>
                    <b>{variations.length > 1 ? `from ${formatMoney(from)}` : formatMoney(from)}</b>
                  </button>
                );
              }
              if (variations.length) {
                return variations.map((variation) => (
                  <button className="till-button" key={variation.id} onClick={() => addPlain(product, variation)}>
                    <strong>{product.name}</strong>
                    <span>{variation.name}</span>
                    <b>{formatMoney(variation.base_price_cents)}</b>
                  </button>
                ));
              }
              return (
                <button className="till-button" key={product.id} onClick={() => addPlain(product)}>
                  <strong>{product.name}</strong>
                  <b>{formatMoney(product.base_price_cents)}</b>
                </button>
              );
            })}
            {!matching.length ? <div className="staff-empty">Nothing matches that.</div> : null}
          </div>
        </section>

        <aside className="staff-panel">
          <div className="staff-panel-head"><h2>This order</h2><span className="live-chip">{lines.reduce((sum, line) => sum + line.quantity, 0)} items</span></div>
          <div className="till-lines">
            {lines.map((line) => (
              <div className="till-line" key={line.key}>
                <div>
                  <strong>{line.name}</strong>
                  {/* Everything chosen, spelled out. Someone reading the order
                      back over the phone reads this, and a "no onions" that only
                      exists inside the payload is a "no onions" that gets made
                      with onions. */}
                  {describeChoices(line, toppingNames).map((choice, index) => <small key={`${index}-${choice}`}>{choice}</small>)}
                  <em className="till-line-price">{formatMoney(line.unitPriceCents)} each</em>
                </div>
                <div className="till-quantity">
                  <button onClick={() => setQuantity(line.key, -1)} aria-label={`One fewer ${line.name}`}>−</button>
                  <span>{line.quantity}</span>
                  <button onClick={() => setQuantity(line.key, 1)} aria-label={`One more ${line.name}`}>+</button>
                  <button className="till-remove" onClick={() => removeLine(line.key)} aria-label={`Remove ${line.name} from this order`}>Remove</button>
                </div>
              </div>
            ))}
            {!lines.length ? <div className="staff-empty">Tap the menu to start.</div> : null}
          </div>

          <div className="checkout-totals">
            <div><span>Subtotal</span><b>{formatMoney(totals.menuSubtotalCents)}</b></div>
            {totals.discountCents > 0 ? <div className="checkout-discount"><span>Discount</span><b>−{formatMoney(totals.discountCents)}</b></div> : null}
            {totals.deliveryFeeCents > 0 ? <div><span>Delivery</span><b>{formatMoney(totals.deliveryFeeCents)}</b></div> : null}
            <div><span>HST</span><b>{formatMoney(totals.taxCents)}</b></div>
            <div className="checkout-grand-total"><span>Total</span><b>{formatMoney(totals.totalCents)}</b></div>
          </div>

          {quote?.issues.map((issue, index) => (
            <p className="cart-blocker" role="status" key={`${index}-${issue.message}`}>{issue.message}</p>
          ))}

          <button className="primary-button" disabled={!lines.length || submitting || (quote !== null && !quote.ok)} onClick={() => void place(Date.now())}>
            {submitting ? "Sending to the kitchen…" : `${fulfilment === "delivery" ? "Send & print" : "Take payment & print"} · ${formatMoney(totals.totalCents)}`}
          </button>
          <small className="secure-note">{fulfilment === "delivery" ? "Marked as payment on delivery. The driver takes cash or the card machine at the door." : "Marked paid at the store. Ring it through the card machine or take cash as usual."}</small>
          {message ? <p className={message.tone === "bad" ? "form-error" : "admin-message"} role="status">{message.text}</p> : null}
          {lastPrintOrder ? <button className="staff-button" onClick={() => printPlacedOrder(lastPrintOrder, Date.now())}>Print last ticket again</button> : null}
          <button className="staff-button" onClick={openCashDrawer}>Open cash drawer</button>
        </aside>
      </div>

      {/* The same customizer the website mounts, over the till. `key` is the
          product id so switching straight from one product to another starts a
          fresh build rather than reusing the last one's state. */}
      {building ? (
        building.product_type === "pizza" ? (
          <PizzaCustomizer
            key={building.id}
            product={building}
            variations={buildingVariations}
            toppings={activeToppings}
            halalNotice={halalNotice}
            halfToppingUnitsBps={halfToppingUnitsBps}
            onClose={() => setBuilding(null)}
            onAdd={add}
          />
        ) : (
          <GenericCustomizer
            key={building.id}
            product={building}
            toppings={activeToppings}
            halalNotice={halalNotice}
            halfToppingUnitsBps={halfToppingUnitsBps}
            onClose={() => setBuilding(null)}
            onAdd={add}
          />
        )
      ) : null}
    </div>
  );
}
