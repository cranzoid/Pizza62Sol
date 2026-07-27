"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/lib/domain";
import type { Dashboard } from "@/app/staff/StaffPortal";

type OrderRow = Record<string, unknown>;
type FeedbackRow = Record<string, unknown>;

const STATUSES = ["all", "received", "preparing", "ready_for_pickup", "out_for_delivery", "completed", "cancelled"];

const when = (value: unknown) =>
  new Date(Number(value)).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" });

/** Order history, the feedback inbox and coupons — the day-to-day owner records. */
export function AdminRecordsPanel({ dashboard, onSaved }: { dashboard: Dashboard; onSaved: () => Promise<void> }) {
  const [tab, setTab] = useState<"orders" | "feedback" | "promotions">("orders");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    if (tab === "promotions") return;
    const search = new URLSearchParams({ tab, query, status });
    const response = await fetch(`/api/admin/records?${search}`);
    const result = await response.json();
    if (!response.ok) { setMessage(result.error ?? "Records could not be loaded."); return; }
    if (tab === "orders") setOrders(result.orders ?? []);
    else setFeedback(result.feedback ?? []);
    setMessage("");
  }, [tab, query, status]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);
  const review = async (id: string, note: string) => {
    const response = await fetch("/api/admin/records", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "feedback.review", id, note }) });
    if (!response.ok) { setMessage("That could not be saved."); return; }
    setMessage("Marked as handled.");
    await load();
  };

  return <div className="admin-stack admin-controls">
    <div className="viz-toolbar">
      <div className="segmented-range" role="group" aria-label="Records">
        {([["orders", "Order history"], ["feedback", "Feedback"], ["promotions", "Coupons & offers"]] as const)
          .map(([key, label]) => <button key={key} className={tab === key ? "active" : ""} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}
      </div>
      {tab === "orders" ? <div className="record-filters">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Order number, name or phone" aria-label="Search orders" />
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by status">
          {STATUSES.map((entry) => <option key={entry} value={entry}>{entry === "all" ? "Every status" : entry.replaceAll("_", " ")}</option>)}
        </select>
      </div> : null}
    </div>
    {message ? <p className="admin-message" role="status">{message}</p> : null}

    {tab === "orders" ? <section className="staff-panel">
      <div className="staff-panel-head"><h2>Order history</h2><span className="live-chip">{orders.length} shown</span></div>
      <table className="viz-table">
        <thead><tr><th scope="col">Order</th><th scope="col">When</th><th scope="col">Status</th><th scope="col">Payment</th><th scope="col">Total</th></tr></thead>
        <tbody>
          {orders.map((order) => <tr key={String(order.id)}>
            <th scope="row">{String(order.order_number)}<small>{String(order.customer_name)}{order.customer_phone ? ` · ${String(order.customer_phone)}` : ""} · {String(order.fulfilment)}</small></th>
            <td>{when(order.created_at)}{order.schedule_type === "scheduled" ? ` (for ${when(order.scheduled_for)})` : ""}</td>
            <td>{String(order.status).replaceAll("_", " ")}</td>
            <td>{String(order.payment_method).replaceAll("_", " ")} · {String(order.payment_status).replaceAll("_", " ")}</td>
            <td>{formatMoney(Number(order.total_cents))}</td>
          </tr>)}
          {!orders.length ? <tr><td colSpan={5} className="staff-empty">No orders match that search.</td></tr> : null}
        </tbody>
      </table>
    </section> : null}

    {tab === "feedback" ? <section className="staff-panel">
      <div className="staff-panel-head"><h2>What customers said</h2><span className="live-chip">{feedback.filter((row) => !row.reviewed_at).length} unhandled</span></div>
      <div className="setup-list">
        {feedback.map((row) => <FeedbackItem key={String(row.id)} row={row} onReview={review} />)}
        {!feedback.length ? <div className="staff-empty">No feedback yet.</div> : null}
      </div>
    </section> : null}

    {tab === "promotions" ? <PromotionsPanel dashboard={dashboard} onSaved={onSaved} /> : null}
  </div>;
}

function FeedbackItem({ row, onReview }: { row: FeedbackRow; onReview: (id: string, note: string) => Promise<void> }) {
  const [note, setNote] = useState(String(row.internal_note ?? ""));
  const rating = Number(row.overall_rating);
  return <div className="setup-item">
    <b>{rating}</b>
    <div>
      <strong>{"★".repeat(rating)}{"☆".repeat(Math.max(0, 5 - rating))} · {row.order_number ? String(row.order_number) : "order removed"}</strong>
      <p>{row.written_feedback ? String(row.written_feedback) : "No comment left."} — {when(row.submitted_at)}</p>
      {row.reviewed_at ? <p>Handled {when(row.reviewed_at)}{row.internal_note ? ` · ${String(row.internal_note)}` : ""}</p> : <div className="manual-punch">
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="What you did about it" aria-label="Internal note" />
        <button className="staff-button" onClick={() => void onReview(String(row.id), note)}>Mark handled</button>
      </div>}
    </div>
  </div>;
}

function PromotionsPanel({ dashboard, onSaved }: { dashboard: Dashboard; onSaved: () => Promise<void> }) {
  const [message, setMessage] = useState("");
  const save = async (body: Record<string, unknown>, success: string) => {
    setMessage("");
    const response = await fetch("/api/admin/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "promotion.upsert", ...body }) });
    const result = await response.json();
    if (!response.ok) { setMessage(result.error ?? "That could not be saved."); return; }
    setMessage(success);
    await onSaved();
  };
  return <section className="staff-panel">
    <div className="staff-panel-head"><h2>Coupons &amp; offers</h2><span className="live-chip">{dashboard.promotions.filter((row) => row.active).length} live</span></div>
    <p className="editor-hint">A coupon applies at checkout when the customer types its code. Leave the code empty for an offer that applies automatically.</p>
    <div className="product-admin-cards">
      {dashboard.promotions.map((promotion) => <PromotionEditor key={String(promotion.id)} promotion={promotion} onSave={(body) => save(body, `${String(promotion.name)} saved.`)} />)}
      <PromotionEditor onSave={(body) => save(body, "Offer created.")} />
    </div>
    {message ? <p className="admin-message" role="status">{message}</p> : null}
  </section>;
}

function PromotionEditor({ promotion, onSave }: { promotion?: Record<string, unknown>; onSave: (body: Record<string, unknown>) => void }) {
  const isNew = !promotion;
  const [name, setName] = useState(String(promotion?.name ?? ""));
  const [code, setCode] = useState(String(promotion?.code ?? ""));
  const [type, setType] = useState(String(promotion?.type ?? "percentage"));
  const [amount, setAmount] = useState(() => {
    const value = Number(promotion?.amount ?? 0);
    return String(promotion?.type === "percentage" ? value / 100 : value / 100);
  });
  const [active, setActive] = useState(Boolean(promotion?.active));
  const [combinable, setCombinable] = useState(promotion ? Boolean(promotion.combinable) : true);
  const amountCents = type === "percentage" ? Math.round(Number(amount) * 100) : Math.round(Number(amount) * 100);
  return <details className="product-admin-card" open={isNew}>
    <summary><span><strong>{name || "New offer"}</strong><small>{type === "percentage" ? `${amount}% off` : type === "fixed" ? `${amount} off` : "Free delivery"}{code ? ` · code ${code}` : " · automatic"}</small></span><span>{active ? "Live" : "Off"}</span></summary>
    <div className="product-editor">
      <div className="settings-form">
        <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>Code<input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="Leave empty for automatic" /></label>
        <label>Type<select value={type} onChange={(event) => setType(event.target.value)}><option value="percentage">Percentage off</option><option value="fixed">Amount off</option><option value="free_delivery">Free delivery</option></select></label>
        {type !== "free_delivery" ? <label>{type === "percentage" ? "Percent" : "Amount · C$"}<input type="number" step="0.01" min="0" value={amount} onChange={(event) => setAmount(event.target.value)} /></label> : null}
        <label className="admin-check"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /><span>Live</span></label>
        <label className="admin-check"><input type="checkbox" checked={combinable} onChange={(event) => setCombinable(event.target.checked)} /><span>Can combine with other offers</span></label>
      </div>
      <button className="staff-button" disabled={name.trim().length < 2} onClick={() => onSave({ id: promotion?.id, name, code: code || null, type, amount: type === "free_delivery" ? 0 : amountCents, active, combinable, priority: Number(promotion?.priority ?? 0) })}>{isNew ? "Create offer" : "Save offer"}</button>
    </div>
  </details>;
}
