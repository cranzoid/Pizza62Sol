"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/lib/domain";
import type { Dashboard } from "@/app/staff/StaffPortal";
import { OrderDetailDrawer } from "@/app/staff/OrderDetail";

type OrderRow = Record<string, unknown>;
type FeedbackRow = Record<string, unknown>;

// H-20a: "awaiting_payment" was missing, so an order stuck mid-checkout could
// not be filtered for here and appeared in no operational view at all.
const STATUSES = ["all", "awaiting_payment", "received", "preparing", "ready_for_pickup", "out_for_delivery", "completed", "cancelled"];

const when = (value: unknown) =>
  new Date(Number(value)).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" });

/** Order history, the feedback inbox and coupons — the day-to-day owner records. */
type Breakdown = { channel: string; fulfilment: string; count: number; totalCents: number };

/** The label the owner would use, not the database value. */
const CHANNEL_LABELS: Record<string, string> = {
  online: "Website",
  phone: "Phone",
  walk_in: "Walk-in",
};

export function AdminRecordsPanel({ dashboard, onSaved }: { dashboard: Dashboard; onSaved: () => Promise<void> }) {
  const [tab, setTab] = useState<"orders" | "feedback" | "promotions">("orders");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [channel, setChannel] = useState("all");
  const [fulfilment, setFulfilment] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [summary, setSummary] = useState({ total: 0, totalCents: 0, paidCents: 0, pageSize: 100 });
  const [breakdown, setBreakdown] = useState<Breakdown[]>([]);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [message, setMessage] = useState("");
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);

  /** One place the filters are turned into a query, so the table and the export
      can never disagree about what is being looked at. */
  const filterParams = useCallback(() => {
    const search = new URLSearchParams({ tab, query, status });
    if (channel !== "all") search.set("channel", channel);
    if (fulfilment !== "all") search.set("fulfilment", fulfilment);
    if (from) search.set("from", from);
    if (to) search.set("to", to);
    return search;
  }, [tab, query, status, channel, fulfilment, from, to]);

  const load = useCallback(async () => {
    if (tab === "promotions") return;
    const search = filterParams();
    search.set("page", String(page));
    const response = await fetch(`/api/admin/records?${search}`);
    const result = await response.json();
    if (!response.ok) { setMessage(result.error ?? "Records could not be loaded."); return; }
    if (tab === "orders") {
      setOrders(result.orders ?? []);
      setSummary({ total: result.total ?? 0, totalCents: result.totalCents ?? 0, paidCents: result.paidCents ?? 0, pageSize: result.pageSize ?? 100 });
      setBreakdown(result.breakdown ?? []);
    } else setFeedback(result.feedback ?? []);
    setMessage("");
  }, [tab, page, filterParams]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);
  /**
   * Changing a filter resets the page.
   *
   * Done in the setter rather than an effect: staying on page 4 of a result set
   * that now has one page shows an empty table and reads as a bug, and doing the
   * reset in an effect is a synchronous setState that cascades a render.
   */
  const changeFilter = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPage(0);
  };

  const exportCsv = () => {
    const search = filterParams();
    search.set("format", "csv");
    // A normal navigation rather than fetch + blob: the browser handles the
    // download, the filename and the save dialog, and nothing is held in memory.
    window.location.assign(`/api/admin/records?${search}`);
  };
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
        <input value={query} onChange={(event) => changeFilter(setQuery)(event.target.value)} placeholder="Order number, name or phone" aria-label="Search orders" />
        <select value={status} onChange={(event) => changeFilter(setStatus)(event.target.value)} aria-label="Filter by status">
          {STATUSES.map((entry) => <option key={entry} value={entry}>{entry === "all" ? "Every status" : entry.replaceAll("_", " ")}</option>)}
        </select>
        <select value={channel} onChange={(event) => changeFilter(setChannel)(event.target.value)} aria-label="Filter by where the order came from">
          <option value="all">Everywhere</option>
          <option value="online">Website</option>
          <option value="phone">Phone</option>
          <option value="walk_in">Walk-in</option>
        </select>
        <select value={fulfilment} onChange={(event) => changeFilter(setFulfilment)(event.target.value)} aria-label="Filter by pickup or delivery">
          <option value="all">Pickup &amp; delivery</option>
          <option value="pickup">Pickup</option>
          <option value="delivery">Delivery</option>
        </select>
        <input type="date" value={from} onChange={(event) => changeFilter(setFrom)(event.target.value)} aria-label="From date" />
        <input type="date" value={to} onChange={(event) => changeFilter(setTo)(event.target.value)} aria-label="To date" />
        <button className="staff-button" onClick={exportCsv} disabled={!summary.total}>Export CSV</button>
      </div> : null}
    </div>
    {message ? <p className="admin-message" role="status">{message}</p> : null}

    {tab === "orders" ? <section className="staff-panel">
      <div className="staff-panel-head">
        <h2>Order history</h2>
        <span className="live-chip">{summary.total} order{summary.total === 1 ? "" : "s"} · {formatMoney(summary.paidCents)} taken</span>
      </div>

      {/* The owner's actual question — "how many were in store" — answered for
          the whole filtered range rather than the visible page. */}
      {breakdown.length ? <div className="channel-split">
        {["online", "phone", "walk_in"].map((key) => {
          const rows = breakdown.filter((entry) => entry.channel === key);
          if (!rows.length) return null;
          const count = rows.reduce((sum, entry) => sum + entry.count, 0);
          const cents = rows.reduce((sum, entry) => sum + entry.totalCents, 0);
          const pickup = rows.find((entry) => entry.fulfilment === "pickup")?.count ?? 0;
          const delivery = rows.find((entry) => entry.fulfilment === "delivery")?.count ?? 0;
          return <div className="channel-split-item" key={key}>
            <strong>{CHANNEL_LABELS[key] ?? key}</strong>
            <b>{count}</b>
            <small>{formatMoney(cents)} · {pickup} pickup · {delivery} delivery</small>
          </div>;
        })}
      </div> : null}

      <div className="table-scroll" role="region" aria-label="Order history" tabIndex={0}><table className="viz-table">
        <thead><tr><th scope="col">Order</th><th scope="col">When</th><th scope="col">Where from</th><th scope="col">Status</th><th scope="col">Payment</th><th scope="col">Total</th></tr></thead>
        <tbody>
          {orders.map((order) => <tr key={String(order.id)} className="order-history-row" onClick={() => setOpenOrderId(String(order.id))}>
            <th scope="row">{String(order.order_number)}<small>{String(order.customer_name)}{order.customer_phone ? ` · ${String(order.customer_phone)}` : ""}</small></th>
            <td>{when(order.created_at)}{order.schedule_type === "scheduled" ? ` (for ${when(order.scheduled_for)})` : ""}</td>
            <td>{CHANNEL_LABELS[String(order.channel)] ?? String(order.channel)}<small>{String(order.fulfilment)}</small></td>
            <td>{String(order.status).replaceAll("_", " ")}</td>
            <td>{String(order.payment_method).replaceAll("_", " ")} · {String(order.payment_status).replaceAll("_", " ")}</td>
            <td>{formatMoney(Number(order.total_cents))}
              {/* A refund happens after the fact, so it belongs here rather than
                  on the live board where orders are still being cooked. Its own
                  click is isolated so opening it does not also open the order
                  detail drawer underneath it. */}
              {["paid", "pending_at_store", "refunded", "partially_refunded"].includes(String(order.payment_status))
                ? <span onClick={(event) => event.stopPropagation()}><RefundControl order={order} onRecorded={load} /></span>
                : null}
            </td>
          </tr>)}
          {!orders.length ? <tr><td colSpan={6} className="staff-empty">No orders match that search.</td></tr> : null}
        </tbody>
      </table></div>

      {summary.total > summary.pageSize ? <div className="pager">
        <button className="staff-button" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>Previous</button>
        <span>Page {page + 1} of {Math.ceil(summary.total / summary.pageSize)}</span>
        <button className="staff-button" disabled={(page + 1) * summary.pageSize >= summary.total} onClick={() => setPage((current) => current + 1)}>Next</button>
      </div> : null}
    </section> : null}

    {tab === "feedback" ? <section className="staff-panel">
      <div className="staff-panel-head"><h2>What customers said</h2><span className="live-chip">{feedback.filter((row) => !row.reviewed_at).length} unhandled</span></div>
      <div className="setup-list">
        {feedback.map((row) => <FeedbackItem key={String(row.id)} row={row} onReview={review} />)}
        {!feedback.length ? <div className="staff-empty">No feedback yet.</div> : null}
      </div>
    </section> : null}

    {tab === "promotions" ? <PromotionsPanel dashboard={dashboard} onSaved={onSaved} /> : null}
    <OrderDetailDrawer orderId={openOrderId} onClose={() => setOpenOrderId(null)} />
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
  // Eligibility. Dates are edited as local dates and stored as epoch ms.
  const asDate = (value: unknown) => (value ? new Date(Number(value)).toISOString().slice(0, 10) : "");
  const [startsAt, setStartsAt] = useState(asDate(promotion?.starts_at));
  const [endsAt, setEndsAt] = useState(asDate(promotion?.ends_at));
  const [minSpend, setMinSpend] = useState(String(Number(promotion?.min_subtotal_cents ?? 0) / 100));
  const [promoFulfilment, setPromoFulfilment] = useState(String(promotion?.fulfilment ?? "any"));
  const [usageLimit, setUsageLimit] = useState(promotion?.usage_limit != null ? String(promotion.usage_limit) : "");
  const [perCustomerLimit, setPerCustomerLimit] = useState(promotion?.per_customer_limit != null ? String(promotion.per_customer_limit) : "");
  const used = Number(promotion?.usage_count ?? 0);
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
        <label>Runs from<input type="date" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label>
        <label>Runs until<input type="date" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label>
        <label>Minimum spend · C$<input type="number" step="0.01" min="0" value={minSpend} onChange={(event) => setMinSpend(event.target.value)} /></label>
        <label>Applies to<select value={promoFulfilment} onChange={(event) => setPromoFulfilment(event.target.value)}>
          <option value="any">Pickup &amp; delivery</option>
          <option value="pickup">Pickup only</option>
          <option value="delivery">Delivery only</option>
        </select></label>
        <label>Total uses · blank for unlimited<input type="number" min="1" value={usageLimit} onChange={(event) => setUsageLimit(event.target.value)} /></label>
        <label>Uses per customer · blank for unlimited<input type="number" min="1" value={perCustomerLimit} onChange={(event) => setPerCustomerLimit(event.target.value)} /></label>
      </div>
      {!isNew ? <p className="editor-hint">Used {used} time{used === 1 ? "" : "s"}{promotion?.usage_limit ? ` of ${String(promotion.usage_limit)}` : ""}.</p> : null}
      <button className="staff-button" disabled={name.trim().length < 2} onClick={() => onSave({
        id: promotion?.id, name, code: code || null, type,
        amount: type === "free_delivery" ? 0 : amountCents,
        active, combinable, priority: Number(promotion?.priority ?? 0),
        // Midday rather than midnight so a date does not slip a day either way
        // when it crosses the UTC boundary on the server.
        startsAt: startsAt ? new Date(`${startsAt}T12:00:00`).getTime() : null,
        endsAt: endsAt ? new Date(`${endsAt}T12:00:00`).getTime() : null,
        minSubtotalCents: Math.round(Number(minSpend || 0) * 100),
        fulfilment: promoFulfilment,
        usageLimit: usageLimit ? Number(usageLimit) : null,
        perCustomerLimit: perCustomerLimit ? Number(perCustomerLimit) : null,
      })}>{isNew ? "Create offer" : "Save offer"}</button>
    </div>
  </details>;
}


/**
 * Recording a refund against an order.
 *
 * The wording here is doing real work. This does **not** move money — Clover
 * publishes no refund API, so the refund is issued in their dashboard and
 * recorded here afterwards. A screen that implied otherwise would leave a
 * customer out of pocket while the books said they had been paid back, which is
 * worse than having no refund screen at all.
 */
function RefundControl({ order, onRecorded }: { order: OrderRow; onRecorded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(Number(order.total_cents ?? 0) / 100));
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [existing, setExisting] = useState<Array<Record<string, unknown>>>([]);
  const [refunded, setRefunded] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const isCard = String(order.payment_method) === "online";

  const loadRefunds = useCallback(async () => {
    const response = await fetch(`/api/admin/refunds?orderId=${encodeURIComponent(String(order.id))}`);
    if (!response.ok) return;
    const result = (await response.json()) as { refunds: Array<Record<string, unknown>>; refundedCents: number };
    setExisting(result.refunds ?? []);
    setRefunded(result.refundedCents ?? 0);
  }, [order.id]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/admin/refunds?orderId=${encodeURIComponent(String(order.id))}`);
      if (cancelled || !response.ok) return;
      const result = (await response.json()) as { refunds: Array<Record<string, unknown>>; refundedCents: number };
      setExisting(result.refunds ?? []);
      setRefunded(result.refundedCents ?? 0);
    })();
    return () => { cancelled = true; };
  }, [open, order.id]);

  const record = async () => {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/admin/refunds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "refund.record",
        orderId: order.id,
        amountCents: Math.round(Number(amount) * 100),
        reason,
        providerReference: reference,
      }),
    });
    const result = (await response.json()) as { error?: string };
    setBusy(false);
    if (!response.ok) { setMessage(result.error ?? "That could not be recorded."); return; }
    setMessage("Recorded.");
    setReason(""); setReference("");
    await loadRefunds();
    await onRecorded();
  };

  const voidRefund = async (refundId: string) => {
    setBusy(true);
    await fetch("/api/admin/refunds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "refund.void", refundId, reason: "Entered in error" }),
    });
    setBusy(false);
    await loadRefunds();
    await onRecorded();
  };

  if (!open) {
    return <button className="text-button refund-open" onClick={() => setOpen(true)}>
      {refunded > 0 || String(order.payment_status).includes("refund") ? "Refunds" : "Refund"}
    </button>;
  }

  return <div className="refund-panel">
    <strong>Record a refund</strong>
    <p className="editor-hint">
      {isCard
        ? "Issue the refund in the Clover dashboard first, then paste its reference here. This screen records it — it does not move any money."
        : "This records a cash refund for your books. Hand the money back at the counter."}
    </p>
    {refunded > 0 ? <p className="editor-hint">{formatMoney(refunded)} already refunded of {formatMoney(Number(order.total_cents))}.</p> : null}
    <label>Amount · C$<input type="number" step="0.01" min="0" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
    <label>Reason<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Wrong order sent" /></label>
    {isCard ? <label>Clover reference<input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="From the Clover dashboard" /></label> : null}
    <div className="refund-actions">
      <button className="staff-button" disabled={busy || reason.trim().length < 2} onClick={() => void record()}>Record</button>
      <button className="text-button" onClick={() => { setOpen(false); setMessage(""); }}>Close</button>
    </div>
    {existing.length ? <div className="refund-history">
      {existing.map((refund) => <div key={String(refund.id)}>
        <span className={String(refund.status) === "voided" ? "refund-voided" : ""}>
          {formatMoney(Number(refund.amount_cents))} · {String(refund.reason)}
          {refund.actor_name ? ` · ${String(refund.actor_name)}` : ""}
          {String(refund.status) === "voided" ? " · voided" : ""}
        </span>
        {String(refund.status) === "recorded"
          ? <button className="text-button danger-text" disabled={busy} onClick={() => void voidRefund(String(refund.id))}>Void</button>
          : null}
      </div>)}
    </div> : null}
    {message ? <p className="admin-message" role="status">{message}</p> : null}
  </div>;
}
