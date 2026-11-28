"use client";

/**
 * Typing less at the till: suggestions under the phone and address fields, and
 * a returning customer's history one tap away.
 *
 * Both fields stay ordinary text boxes. A suggestion is an offer — tap it and
 * the form fills in, ignore it and keep typing, tap away or press Escape and it
 * goes. Nothing here can stop an order being rung in the way it always was.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { formatMoney } from "@/lib/domain";
import { snapshotDetails, snapshotFlags, type ItemSnapshot } from "@/lib/order-presentation";
import type { CustomerHistory, CustomerSuggestion, PastOrder, SavedAddress } from "@/lib/customer-lookup";

export type AddressSuggestion = {
  line1: string;
  unit: string;
  postalCode: string;
  postalPrefix: string;
  area: string;
  source: "previous" | "maps";
};

/** "905-555-1234" for a 10-digit number; anything else as it was typed. */
export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 10 ? `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` : phone;
}

const dateLabel = (at: number | null) =>
  at ? new Date(at).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Toronto" }) : "";

const timeLabel = (at: number) =>
  new Date(at).toLocaleString("en-CA", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" });

/**
 * Suggestions for what is in a box, fetched as the person types.
 *
 * Waits for a short pause in typing, cancels the request it no longer needs,
 * and keeps only the newest answer, so fast typing never shows a stale list.
 */
function useSuggestions<T>(url: string | null): T[] {
  const [results, setResults] = useState<{ url: string; items: T[] } | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(url, { signal: controller.signal, headers: { accept: "application/json" } })
        .then((response) => (response.ok ? response.json() : { suggestions: [] }))
        .then((payload: { suggestions?: T[] }) => setResults({ url, items: payload.suggestions ?? [] }))
        .catch(() => undefined);
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [url]);
  return url && results?.url === url ? results.items : [];
}

/**
 * A labelled text box with a suggestion list under it.
 *
 * Arrow keys move through the list, Enter takes the highlighted one, Escape
 * closes it. A suggestion is taken on mouse-down rather than click so the box
 * losing focus does not close the list before the tap lands.
 */
export function SuggestField<T>({
  label,
  value,
  onChange,
  url,
  onPick,
  renderItem,
  itemKey,
  inputProps,
  footer,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** Where to ask for suggestions for the current value, or null to offer none. */
  url: string | null;
  onPick: (item: T) => void;
  renderItem: (item: T) => ReactNode;
  itemKey: (item: T) => string;
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>;
  footer?: ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const items = useSuggestions<T>(focused ? url : null);
  const listId = useId();
  const open = focused && items.length > 0 && dismissedFor !== value;
  const active = Math.min(highlight, items.length - 1);
  const pick = (item: T) => { setDismissedFor(null); setFocused(false); onPick(item); };
  return (
    <label className="till-suggest">
      {label}
      <input
        {...inputProps}
        value={value}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onChange={(event) => { onChange(event.target.value); setDismissedFor(null); setHighlight(0); }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === "ArrowDown") { event.preventDefault(); setHighlight((active + 1) % items.length); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setHighlight((active - 1 + items.length) % items.length); }
          else if (event.key === "Enter") { event.preventDefault(); pick(items[active]); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissedFor(value); }
        }}
      />
      {open ? (
        <ul className="till-suggest-list" id={listId} role="listbox">
          {items.map((item, index) => (
            <li
              key={itemKey(item)}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? "active" : ""}
              onMouseDown={(event) => { event.preventDefault(); pick(item); }}
              onMouseEnter={() => setHighlight(index)}
            >
              {renderItem(item)}
            </li>
          ))}
          {footer ? <li className="till-suggest-foot" role="presentation" onMouseDown={(event) => event.preventDefault()}>{footer}</li> : null}
        </ul>
      ) : null}
    </label>
  );
}

/** One suggested customer: number first, because that is what is being matched. */
export function CustomerSuggestionRow({ item }: { item: CustomerSuggestion }) {
  return (
    <>
      <strong>{formatPhone(item.phone)}</strong>
      <span>{item.name || "No name saved"}</span>
      <small>
        {item.contactOnly
          ? "From our customer list · no orders here yet"
          : `${item.orderCount} order${item.orderCount === 1 ? "" : "s"} · last ${dateLabel(item.lastOrderAt)}${item.lastAddress ? ` · ${item.lastAddress}` : ""}`}
      </small>
    </>
  );
}

export function AddressSuggestionRow({ item }: { item: AddressSuggestion }) {
  return (
    <>
      <strong>{item.line1}{item.unit ? `, unit ${item.unit}` : ""}</strong>
      <span>{item.postalCode || (item.postalPrefix ? `${item.postalPrefix} — finish the postal code` : "Add the postal code")}{item.area && item.area !== "Hamilton" ? ` · ${item.area}` : ""}</span>
      <small>{item.source === "previous" ? "Delivered here before" : "Suggested address"}</small>
    </>
  );
}

function PastOrderCard({ order, toppingNames, onReorder }: { order: PastOrder; toppingNames: Map<string, string>; onReorder: () => void }) {
  const cancelled = order.status === "cancelled";
  return (
    <article className={`till-history-order${cancelled ? " till-history-order--cancelled" : ""}`}>
      <header>
        <b>{order.order_number.replace("P62-", "#")}</b>
        <span>{timeLabel(order.created_at)} · {order.fulfilment === "delivery" ? "Delivery" : "Pickup"}{cancelled ? " · Cancelled" : ""}</span>
        <em>{formatMoney(order.total_cents)}</em>
      </header>
      <ul>
        {order.items.map((item, index) => {
          const snapshot = (item.snapshot ?? {}) as ItemSnapshot;
          const extras = [...snapshotFlags(snapshot), ...snapshotDetails(snapshot, toppingNames).map((detail) => `${detail.label}: ${detail.value}`)];
          return (
            <li key={index}>
              <strong>{Number(item.quantity ?? 1)} × {String(item.productName ?? "Item")}{item.variationName ? ` (${String(item.variationName)})` : ""}</strong>
              {extras.length ? <small>{extras.join(" · ")}</small> : null}
              {item.instructions ? <small>Note: {String(item.instructions)}</small> : null}
            </li>
          );
        })}
      </ul>
      {order.fulfilment === "delivery" && order.address?.line1 ? (
        <p className="pos-hint">To {order.address.line1}{order.address.unit ? `, unit ${order.address.unit}` : ""}, {order.address.postalCode}{order.instructions ? ` · ${order.instructions}` : ""}</p>
      ) : null}
      <button type="button" className="pos-primary till-history-reorder" onClick={onReorder}>Order this again</button>
    </article>
  );
}

/**
 * What the till knows about a returning customer, shown over the order screen.
 *
 * Two ways out besides closing: take their details (name, number, email and
 * last delivery address), or take a past order as it was — items and all — and
 * add to it from there.
 */
export function CustomerHistorySheet({
  phone,
  toppingNames,
  onClose,
  onUseDetails,
  onUseAddress,
  onReorder,
}: {
  phone: string;
  toppingNames: Map<string, string>;
  onClose: () => void;
  onUseDetails: (customer: CustomerHistory) => void;
  onUseAddress: (customer: CustomerHistory, address: SavedAddress) => void;
  onReorder: (customer: CustomerHistory, order: PastOrder) => void;
}) {
  const [state, setState] = useState<{ phone: string; customer: CustomerHistory | null; error: string | null } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/customer-lookup?customer=${encodeURIComponent(phone)}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as { customer?: CustomerHistory; error?: string };
        setState({ phone, customer: payload.customer ?? null, error: response.ok ? null : payload.error ?? "That customer could not be loaded." });
      })
      .catch((error: unknown) => {
        if ((error as Error).name !== "AbortError") setState({ phone, customer: null, error: "That customer could not be loaded. Check the connection and try again." });
      });
    return () => controller.abort();
  }, [phone]);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const loaded = state?.phone === phone ? state : null;
  const customer = loaded?.customer ?? null;
  return (
    <div className="pos-sheet-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="pos-sheet pos-sheet--wide till-history" role="dialog" aria-modal="true" aria-labelledby="till-history-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="pos-sheet-head">
          <h2 id="till-history-title">{customer?.name || formatPhone(phone)}</h2>
          <button ref={closeRef} type="button" className="pos-sheet-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {!loaded ? <p className="pos-hint">Looking up {formatPhone(phone)}…</p> : null}
        {loaded?.error ? <p className="pos-hint">{loaded.error}</p> : null}
        {customer ? (
          <>
            <p className="till-history-summary">
              {customer.name ? <>{formatPhone(customer.phone)} · </> : null}
              {customer.orderCount
                ? `${customer.orderCount} order${customer.orderCount === 1 ? "" : "s"} since ${dateLabel(customer.firstOrderAt)}`
                : "On our customer list — no orders here yet"}
              {customer.email ? ` · ${customer.email}` : ""}
            </p>
            <button type="button" className="pos-secondary" onClick={() => onUseDetails(customer)}>
              Use their details{customer.addresses[0] ? " and last address" : ""}
            </button>
            {customer.addresses.length ? (
              <div className="till-history-addresses">
                <h3>Delivered to</h3>
                {customer.addresses.map((address) => (
                  <button type="button" key={`${address.line1}|${address.unit}|${address.postalCode}`} onClick={() => onUseAddress(customer, address)}>
                    <span>
                      <strong>{address.line1}{address.unit ? `, unit ${address.unit}` : ""}</strong>
                      <small>{address.postalCode}{address.instructions ? ` · ${address.instructions}` : ""} · last {dateLabel(address.lastUsedAt)}</small>
                    </span>
                    <em>Deliver here</em>
                  </button>
                ))}
              </div>
            ) : null}
            {customer.orders.length ? (
              <div className="till-history-orders">
                <h3>Recent orders</h3>
                {customer.orders.map((order) => (
                  <PastOrderCard key={order.id} order={order} toppingNames={toppingNames} onReorder={() => onReorder(customer, order)} />
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  );
}
