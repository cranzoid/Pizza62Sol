"use client";

/**
 * Full inspection of one order — the read that used to only exist as a
 * printed ticket at the moment an order was rung in.
 *
 * Once an order left the live board its detail was gone: history showed six
 * columns and a total, and nothing else the order actually carried (items,
 * toppings, the delivery address, per-item notes, refunds, the status
 * timeline, who rang it in) was reachable again. This drawer opens on any
 * order id from either order history or a customer's order list, backed by
 * `GET /api/admin/orders?id=`, and renders the same shape the printed ticket
 * and the confirmation email already agree on — item choices arrive from the
 * server pre-resolved to display text (see `lib/order-detail.ts`), so this
 * component never has to carry the topping table around just to show what
 * was ordered.
 */
import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/domain";
import { totalRows } from "@/lib/order-presentation";

type OrderItem = {
  id: string;
  productName: string;
  variationName: string | null;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  flags: string[];
  details: Array<{ label: string; value: string }>;
  instructions: string | null;
};

type OrderEvent = {
  id: string;
  previous_status: string | null;
  next_status: string;
  actor_type: string;
  actor_name: string | null;
  note: string | null;
  created_at: number;
};

type Refund = {
  id: string;
  amount_cents: number;
  reason: string;
  customer_note: string | null;
  internal_note: string | null;
  provider_reference: string | null;
  status: string;
  actor_name: string | null;
  created_at: number;
};

type OrderDetail = {
  id: string;
  order_number: string;
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
  contactRedacted?: boolean;
  fulfilment: string;
  channel: string;
  status: string;
  payment_status: string;
  payment_method: string;
  schedule_type: string;
  scheduled_for: number | null;
  created_at: number;
  address: { line1: string; unit?: string; city: string; postalCode: string } | null;
  instructions: string | null;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  delivery_fee_cents: number;
  tip_cents: number;
  total_cents: number;
  items: OrderItem[];
  events: OrderEvent[];
  refunds: Refund[];
  refundedCents: number;
  takenBy: { name: string | null; at: number } | null;
  feedback: { overall_rating: number; written_feedback: string | null; submitted_at: number; reviewed_at: number | null } | null;
};

const when = (value: unknown) =>
  value
    ? new Date(Number(value)).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })
    : "";

const CHANNEL_LABELS: Record<string, string> = { online: "Website", phone: "Phone", walk_in: "Walk-in" };

export function OrderDetailDrawer({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Nothing to reset here: the component renders null below whenever
    // orderId is absent, so an old order lingering in state until the next
    // fetch resolves is never actually shown.
    if (!orderId) return;
    let cancelled = false;
    // Deferred like the rest of the portal's fetches (see StaffPortal's
    // dashboard load): the state updates then land in a callback rather than
    // synchronously in the effect body.
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      fetch(`/api/admin/orders?id=${encodeURIComponent(orderId)}`)
        .then(async (response) => {
          const result = await response.json();
          if (cancelled) return;
          if (!response.ok) { setError(result.error ?? "That order could not be loaded."); return; }
          setOrder(result.order);
        })
        .catch(() => { if (!cancelled) setError("That order could not be loaded."); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [orderId]);

  if (!orderId) return null;

  return <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
    <aside className="order-drawer" role="dialog" aria-modal="true" aria-labelledby="order-drawer-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="drawer-head">
        <div>
          <small>Order detail</small>
          <h2 id="order-drawer-title">{order ? order.order_number.replace("P62-", "#") : "…"}</h2>
        </div>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="order-drawer-body">
        {loading ? <p className="staff-empty">Loading order…</p> : null}
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        {order ? <>
          <div className="order-drawer-summary">
            <span className="status-pill">{order.status.replaceAll("_", " ")}</span>
            <span>{CHANNEL_LABELS[order.channel] ?? order.channel} · {order.fulfilment}</span>
            <span>{order.schedule_type === "scheduled" && order.scheduled_for ? `Scheduled ${when(order.scheduled_for)}` : `Placed ${when(order.created_at)}`}</span>
          </div>

          <section className="order-drawer-section">
            <h3>Customer</h3>
            <p><strong>{order.customer_name}</strong></p>
            {order.customer_phone ? <p>{order.customer_phone}</p> : null}
            {order.customer_email ? <p>{order.customer_email}</p> : null}
            {order.contactRedacted ? <p className="order-drawer-muted">Contact hidden — you do not have permission to view customer contact.</p> : null}
            {order.takenBy ? <p className="order-drawer-muted">Taken by {order.takenBy.name ?? "a staff member"} · {when(order.takenBy.at)}</p> : null}
          </section>

          {order.address ? <section className="order-drawer-section">
            <h3>Deliver to</h3>
            <p>{order.address.line1}{order.address.unit ? `, Unit ${order.address.unit}` : ""}</p>
            <p>{order.address.city} {order.address.postalCode}</p>
            {order.instructions ? <p className="order-drawer-muted">{order.instructions}</p> : null}
          </section> : order.instructions ? <section className="order-drawer-section">
            <h3>Order note</h3>
            <p>{order.instructions}</p>
          </section> : null}

          <section className="order-drawer-section">
            <h3>Items</h3>
            <div className="order-drawer-items">
              {order.items.map((item) => <div className="order-drawer-item" key={item.id}>
                <div className="order-drawer-item-head">
                  <span>{item.quantity}&times; {item.productName}{item.variationName ? ` · ${item.variationName}` : ""}</span>
                  <span>{formatMoney(item.lineTotalCents)}</span>
                </div>
                {item.flags.map((flag) => <div className="order-drawer-flag" key={flag}>{flag.toUpperCase()}</div>)}
                {item.details.map((detail) => <div className="order-drawer-detail" key={detail.label}><b>{detail.label}:</b> {detail.value}</div>)}
                {item.instructions ? <div className="order-drawer-muted">Note: {item.instructions}</div> : null}
              </div>)}
            </div>
          </section>

          <section className="order-drawer-section">
            <h3>Payment</h3>
            <div className="order-drawer-money">
              {totalRows(order).map((row) => <div className={row.strong ? "order-drawer-money-total" : ""} key={row.label}><span>{row.label}</span><span>{row.value}</span></div>)}
            </div>
            <p className="order-drawer-muted">{order.payment_method.replaceAll("_", " ")} · {order.payment_status.replaceAll("_", " ")}</p>
            {order.refunds.length ? <div className="order-drawer-refunds">
              {order.refunds.map((refund) => <div className="order-drawer-refund" key={refund.id}>
                <span>{formatMoney(refund.amount_cents)} {refund.status === "voided" ? "(voided)" : "refunded"}</span>
                <small>{refund.reason} · {refund.actor_name ?? "staff"} · {when(refund.created_at)}</small>
              </div>)}
              <p className="order-drawer-muted">{formatMoney(order.refundedCents)} refunded total</p>
            </div> : null}
          </section>

          {order.feedback ? <section className="order-drawer-section">
            <h3>Feedback</h3>
            <p>{"★".repeat(order.feedback.overall_rating)}{"☆".repeat(5 - order.feedback.overall_rating)}</p>
            {order.feedback.written_feedback ? <p>{order.feedback.written_feedback}</p> : null}
            <p className="order-drawer-muted">{order.feedback.reviewed_at ? "Reviewed" : "Not yet reviewed"} · {when(order.feedback.submitted_at)}</p>
          </section> : null}

          <section className="order-drawer-section">
            <h3>Timeline</h3>
            <div className="order-drawer-timeline">
              {order.events.map((event) => <div className="order-drawer-event" key={event.id}>
                <span>{event.next_status.replaceAll("_", " ")}</span>
                <small>{event.actor_type === "staff" ? (event.actor_name ?? "Staff") : event.actor_type} · {when(event.created_at)}{event.note ? ` · ${event.note}` : ""}</small>
              </div>)}
            </div>
          </section>
        </> : null}
      </div>
    </aside>
  </div>;
}
