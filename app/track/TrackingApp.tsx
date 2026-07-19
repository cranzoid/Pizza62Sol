"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

import { FormEvent, useEffect, useState } from "react";
import { formatMoney } from "@/lib/domain";

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

function Header() { return <header className="utility-header"><a className="brand" href="/"><span className="pizza-mark"><span>62</span><i className="pizza-dot pizza-dot--one" /></span><span className="brand-copy"><strong>Pizza 62</strong><small>Hamilton, Ontario</small></span></a><a href="/">Back to menu ↗</a></header>; }

function initialTrackingParams() {
  if (typeof window === "undefined") return { order: "", token: "" };
  const params = new URLSearchParams(window.location.search);
  return { order: params.get("order") ?? "", token: params.get("token") ?? "" };
}

export default function TrackingApp() {
  const [initial] = useState(initialTrackingParams); const [orderNumber, setOrderNumber] = useState(initial.order); const [token, setToken] = useState(initial.token); const [result, setResult] = useState<TrackingResult | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const lookup = async (event?: FormEvent) => { event?.preventDefault(); setLoading(true); setError(""); try { const response = await fetch(`/api/orders/track?order=${encodeURIComponent(orderNumber)}&token=${encodeURIComponent(token)}`); const body = await response.json(); if (!response.ok) throw new Error(body.error ?? "Order not found."); setResult(body); } catch (caught) { setResult(null); setError(caught instanceof Error ? caught.message : "Order not found."); } finally { setLoading(false); } };
  useEffect(() => { if (initial.order && initial.token) { window.setTimeout(() => { void fetch(`/api/orders/track?order=${encodeURIComponent(initial.order)}&token=${encodeURIComponent(initial.token)}`).then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error); setResult(body); }).catch((caught) => setError(caught instanceof Error ? caught.message : "Order not found.")); }, 0); } }, [initial]);
  const path = result?.order.fulfilment === "delivery" ? ["received", "preparing", "out_for_delivery", "completed"] : ["received", "preparing", "ready_for_pickup", "completed"];
  const currentIndex = result ? path.indexOf(result.order.status) : -1;
  return <div className="utility-page"><Header /><main className="utility-content"><div className="utility-title"><p className="eyebrow dark" style={{ justifyContent: "center" }}><span /> Private order updates</p><h1>Where&apos;s my pizza?</h1><p>Your order number and secure tracking token are both required.<br />A nearby order number can never reveal someone else&apos;s order.</p></div>{!result ? <form className="lookup-card lookup-form" onSubmit={lookup}><label>Order number<input value={orderNumber} onChange={(event) => setOrderNumber(event.target.value.toUpperCase())} placeholder="P62-1048" required /></label><label>Secure tracking token<input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Use the full token from your confirmation" required /></label><button className="primary-button" disabled={loading}>{loading ? "Checking…" : "Track order"}</button>{error ? <div className="form-error" style={{ gridColumn: "1 / -1" }} role="alert">{error}</div> : null}</form> : <section className="tracking-card"><div className="tracking-head"><div><p className="eyebrow dark"><span /> {result.order.fulfilment}</p><h2>{result.order.orderNumber}</h2></div><span>{result.order.status.replaceAll("_", " ")}</span></div><div className="tracking-timeline">{path.map((status, index) => <div className={`tracking-step ${index <= currentIndex && result.order.status !== "cancelled" ? "active" : ""}`} key={status}>{status.replaceAll("_", " ")}</div>)}</div>{result.order.status === "cancelled" ? <div className="form-error">This order was cancelled. Call the store for help.</div> : <div className="confirmation-estimate"><span>Current estimate</span><b>{new Date(result.order.estimatedFor).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })}</b></div>}<div className="tracking-items">{result.order.items.map((item, index) => <div className="tracking-item" key={`${item.name}-${index}`}><span>{item.quantity} × {item.name}{item.variation ? ` · ${item.variation}` : ""}</span><b>{formatMoney(item.lineTotalCents)}</b></div>)}</div><div className="tracking-total"><span>Total</span><b>{formatMoney(result.order.totalCents)}</b></div><p style={{ color: "var(--muted)", fontSize: 10, marginTop: 24 }}>Need help? Call <a style={{ textDecoration: "underline", fontWeight: 900 }} href={`tel:${result.store.phone.replace(/[^0-9+]/g, "")}`}>{result.store.phone}</a>. Customer cancellation requests are handled by phone.</p><button className="text-button" onClick={() => setResult(null)}>Track another order</button></section>}</main></div>;
}
