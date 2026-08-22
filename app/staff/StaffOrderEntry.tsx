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
 * Items with required choices (build-your-own pizzas, deals) are deliberately
 * not offered here. They need the full customizer, and a half-built one on a
 * till screen produces orders the kitchen cannot read. Those go through the
 * website or get called through as they do today; this covers the counter's
 * actual traffic — slices, wings, drinks, fixed-recipe pizzas.
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
import type { Dashboard } from "@/app/staff/StaffPortal";

type Line = { key: string; productId: string; variationId?: string; name: string; note: string; quantity: number };

type Quote = {
  ok: boolean;
  totals: { menuSubtotalCents: number; discountCents: number; taxCents: number; deliveryFeeCents: number; totalCents: number };
  issues: Array<{ index: number | null; message: string }>;
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
  const [lines, setLines] = useState<Line[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [search, setSearch] = useState("");

  /**
   * What can be rung in without a customizer.
   *
   * A product needing choices is excluded rather than added with its defaults —
   * a deal rung in with no pizza sizes chosen is an order the kitchen has to
   * phone the counter about.
   */
  const sellable = dashboard.products.filter((product) => {
    if (!product.active || product.sold_out || product.setup_required) return false;
    // Some items are counter-only. Offering one on a delivery ticket produces an
    // order the server rejects after it has already been keyed in.
    if (!(fulfilment === "delivery" ? product.delivery_eligible : product.pickup_eligible)) return false;
    const configuration = product.configuration ?? {};
    const sections = Array.isArray(configuration.sections) ? configuration.sections : [];
    const needsChoices = sections.some((section) => Number((section as { min?: number }).min ?? 0) > 0);
    if (needsChoices) return false;
    // A pizza is sellable here only if it has a set recipe: its size is a
    // variation, which the buttons below offer, and its toppings are decided.
    if (product.product_type === "pizza") return Boolean(configuration.fixedRecipe);
    return true;
  });

  const matching = search.trim()
    ? sellable.filter((product) => product.name.toLowerCase().includes(search.trim().toLowerCase()))
    : sellable;

  const body = useCallback(
    (extra: Record<string, unknown> = {}) => ({
      channel,
      fulfilment,
      customer: { name: name.trim() || "Counter", phone: phone.trim(), email: email.trim() },
      items: lines.map((line) => ({
        productId: line.productId,
        variationId: line.variationId,
        quantity: line.quantity,
      })),
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

  const add = (productId: string, productName: string, variationId?: string, variationName?: string) => {
    setMessage(null);
    setLines((current) => {
      // Same product and size adds a quantity rather than a second line — a till
      // that shows "1 × Poutine" four times is harder to check against the bag.
      const existing = current.find((line) => line.productId === productId && line.variationId === variationId);
      if (existing) {
        return current.map((line) => (line === existing ? { ...line, quantity: line.quantity + 1 } : line));
      }
      return [
        ...current,
        {
          key: crypto.randomUUID(),
          productId,
          variationId,
          name: productName,
          note: variationName ?? "",
          quantity: 1,
        },
      ];
    });
  };

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

  const place = async () => {
    setSubmitting(true);
    setMessage(null);
    const response = await fetch("/api/admin/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body({ idempotencyKey: `staff-${crypto.randomUUID()}-${crypto.randomUUID()}` })),
    });
    const result = (await response.json()) as { orderNumber?: string; error?: string };
    setSubmitting(false);
    if (!response.ok) {
      setMessage({ tone: "bad", text: result.error ?? "That order could not be created." });
      return;
    }
    setMessage({ tone: "ok", text: `${result.orderNumber} is in. It is on the kitchen board now.` });
    setLines([]);
    setName("");
    setPhone("");
    setEmail("");
    setLine1("");
    setUnit("");
    setPostalCode("");
    setDeliveryInstructions("");
    setQuote(null);
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
              if (variations.length) {
                return variations.map((variation) => (
                  <button className="till-button" key={variation.id} onClick={() => add(product.id, product.name, variation.id, variation.name)}>
                    <strong>{product.name}</strong>
                    <span>{variation.name}</span>
                    <b>{formatMoney(variation.base_price_cents)}</b>
                  </button>
                ));
              }
              return (
                <button className="till-button" key={product.id} onClick={() => add(product.id, product.name)}>
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
                  {line.note ? <small>{line.note}</small> : null}
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

          <button className="primary-button" disabled={!lines.length || submitting || (quote !== null && !quote.ok)} onClick={() => void place()}>
            {submitting ? "Sending to the kitchen…" : `${fulfilment === "delivery" ? "Send for delivery" : "Take payment"} · ${formatMoney(totals.totalCents)}`}
          </button>
          <small className="secure-note">{fulfilment === "delivery" ? "Marked as payment on delivery. The driver takes cash or the card machine at the door." : "Marked paid at the store. Ring it through the card machine or take cash as usual."}</small>
          {message ? <p className={message.tone === "bad" ? "form-error" : "admin-message"} role="status">{message.text}</p> : null}
        </aside>
      </div>
    </div>
  );
}
