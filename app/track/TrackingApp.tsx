"use client";
import { FormEvent, useEffect, useState } from "react";
import { formatMoney } from "@/lib/domain";
import { UtilityHeader } from "@/app/UtilityHeader";
import { readLinkCredentials } from "@/lib/link-credentials";

type TrackingResult = {
  order: {
    orderNumber: string;
    fulfilment: "pickup" | "delivery";
    status: string;
    paymentStatus: string;
    estimatedFor: number;
    totalCents: number;
    items: Array<{ name: string; variation: string | null; quantity: number; lineTotalCents: number }>;
  };
  store: { name: string; phone: string };
};

/**
 * Reads the credentials out of the link, then takes them out of the URL.
 *
 * The H-15 reasoning, and why the read has to be a one-shot that can be safely
 * repeated, both live in lib/link-credentials.ts. On the server there is no URL
 * to read, and unlike the feedback form this page has somewhere to go without
 * one: it falls back to the empty lookup form, which is what it renders for a
 * customer who arrives here by typing the address anyway.
 */
function initialTrackingParams() {
  if (typeof window === "undefined") return { order: "", token: "" };
  return readLinkCredentials();
}

export default function TrackingApp() {
  const [initial] = useState(initialTrackingParams); const [orderNumber, setOrderNumber] = useState(initial.order); const [token, setToken] = useState(initial.token); const [result, setResult] = useState<TrackingResult | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const lookup = async (event?: FormEvent) => { event?.preventDefault(); setLoading(true); setError(""); try { const response = await fetch(`/api/orders/track?order=${encodeURIComponent(orderNumber)}`, { headers: { "x-tracking-token": token } }); const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Order not found."); setResult(body); } catch (caught) { setResult(null); setError(caught instanceof Error ? caught.message : "Order not found."); } finally { setLoading(false); } };
  useEffect(() => { if (initial.order && initial.token) { window.setTimeout(() => { void fetch(`/api/orders/track?order=${encodeURIComponent(initial.order)}`, { headers: { "x-tracking-token": initial.token } }).then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error); setResult(body); }).catch((caught) => setError(caught instanceof Error ? caught.message : "Order not found.")); }, 0); } }, [initial]);
  const path = result?.order.fulfilment === "delivery" ? ["received", "preparing", "out_for_delivery", "completed"] : ["received", "preparing", "ready_for_pickup", "completed"];
  const currentIndex = result ? path.indexOf(result.order.status) : -1;
  return <div className="utility-page"><a className="skip-link" href="#utility-content">Skip to content</a><UtilityHeader /><main className="utility-content" id="utility-content"><div className="utility-title"><p className="eyebrow dark" style={{ justifyContent: "center" }}><span /> Private order updates</p><h1>Where&apos;s my pizza?</h1><p>Your order number and secure tracking token are both required.<br />A nearby order number can never reveal someone else&apos;s order.</p></div>{!result ? <form className="lookup-card lookup-form" onSubmit={lookup}><label>Order number<input value={orderNumber} onChange={(event) => setOrderNumber(event.target.value.toUpperCase())} placeholder="P62-1048" autoComplete="off" required /></label><label>Secure tracking token<input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Use the full token from your confirmation" autoComplete="off" required /></label><button className="primary-button" disabled={loading}>{loading ? "Checking…" : "Track order"}</button>{error ? <div className="form-error lookup-error" role="alert">{error}</div> : null}</form> : <section className="tracking-card"><div className="tracking-head"><div><p className="eyebrow dark"><span /> {result.order.fulfilment}</p><h2>{result.order.orderNumber}</h2></div><span>{result.order.status.replaceAll("_", " ")}</span></div><div className="tracking-timeline" aria-label="Order progress">{path.map((status, index) => <div className={`tracking-step ${index <= currentIndex && result.order.status !== "cancelled" ? "active" : ""}`} aria-current={index === currentIndex ? "step" : undefined} key={status}>{status.replaceAll("_", " ")}</div>)}</div>{result.order.status === "cancelled" ? <div className="form-error">This order was cancelled. Call the store for help.</div> : <div className="confirmation-estimate"><span>Current estimate</span><b>{new Date(result.order.estimatedFor).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })}</b></div>}<div className="tracking-items">{result.order.items.map((item, index) => <div className="tracking-item" key={`${item.name}-${index}`}><span>{item.quantity} × {item.name}{item.variation ? ` · ${item.variation}` : ""}</span><b>{formatMoney(item.lineTotalCents)}</b></div>)}</div><div className="tracking-total"><span>Total</span><b>{formatMoney(result.order.totalCents)}</b></div><p className="utility-help">Need help? Call <a href={`tel:${result.store.phone.replace(/[^0-9+]/g, "")}`}>{result.store.phone}</a>. Customer cancellation requests are handled by phone.</p><button className="text-button" onClick={() => setResult(null)}>Track another order</button></section>}</main></div>;
}
