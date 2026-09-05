"use client";

/**
 * Full inspection of one order — everything the restaurant knows about it, on
 * one screen.
 *
 * Once an order left the live board its detail was gone: history showed six
 * columns and a total, and nothing else the order actually carried (items,
 * toppings, the delivery address, per-item notes, refunds, the status
 * timeline, who rang it in) was reachable again. This drawer opens on any
 * order id from either order history or a customer's order list, backed by
 * `GET /api/admin/orders?id=`, and renders the same shape the printed ticket
 * and the confirmation email already agree on — item choices arrive from the
 * server pre-resolved to display text (see `lib/order-detail.ts`), so this
 * component never has to carry the topping table around just to show what was
 * ordered.
 *
 * **Where the order came from is now part of the record.** The restaurant is
 * paying Meta and Google for clicks, and the question that spend has to answer
 * is not "how much traffic" but "which orders". Every website order carries the
 * campaign that brought the customer (see `lib/attribution.ts`), and it is read
 * here beside the money it produced — one order, one screen, with the marketing
 * facts next to the takings rather than in a separate analytics tool that
 * cannot name a single order.
 *
 * The layout is deliberately front-loaded: the four things someone opening an
 * order almost always wants (when it was placed, when it is wanted for, what it
 * came to, and whether anyone has acknowledged it) are a grid at the top, and
 * the long-form sections follow in the order they are asked about.
 */
import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/domain";
import { totalRows } from "@/lib/order-presentation";
import { orderSourceLabel, touchRows, touchesDiffer, type OrderAttribution } from "@/lib/attribution";

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

type Payment = {
  id: string;
  provider: string;
  provider_reference: string | null;
  method: string;
  status: string;
  amount_cents: number;
  currency: string;
  failure_reason: string | null;
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
  estimated_for: number | null;
  acknowledged_at: number | null;
  created_at: number;
  address: { line1: string; unit?: string; city: string; postalCode: string } | null;
  instructions: string | null;
  attribution: OrderAttribution | null;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  delivery_fee_cents: number;
  tip_cents: number;
  total_cents: number;
  items: OrderItem[];
  events: OrderEvent[];
  payments: Payment[];
  refunds: Refund[];
  refundedCents: number;
  takenBy: { name: string | null; at: number } | null;
  feedback: { overall_rating: number; written_feedback: string | null; submitted_at: number; reviewed_at: number | null } | null;
};

const when = (value: unknown) =>
  value
    ? new Date(Number(value)).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })
    : "";

const time = (value: unknown) =>
  value ? new Date(Number(value)).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" }) : "";

const words = (value: unknown) => String(value ?? "").replaceAll("_", " ");

const CHANNEL_LABELS: Record<string, string> = { online: "Website", phone: "Phone", walk_in: "Walk-in" };

/**
 * Green for an order still moving, grey for one that is finished, red for one
 * that is not going to happen. Status words alone all look alike in a list.
 */
const STATUS_TONE: Record<string, string> = {
  awaiting_payment: "warn",
  received: "live",
  preparing: "live",
  ready_for_pickup: "live",
  out_for_delivery: "live",
  completed: "done",
  cancelled: "bad",
};

const PAYMENT_TONE: Record<string, string> = {
  paid: "done",
  pending_at_store: "warn",
  awaiting_checkout: "warn",
  failed: "bad",
  expired: "bad",
  cancelled: "bad",
  refunded: "bad",
  partially_refunded: "warn",
};

function Fact({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return <div className="od-fact">
    <span>{label}</span>
    <b>{value}</b>
    {note ? <small>{note}</small> : null}
  </div>;
}

function Section({ title, aside, children }: { title: string; aside?: string | null; children: React.ReactNode }) {
  return <section className="od-section">
    <div className="od-section-head"><h3>{title}</h3>{aside ? <span>{aside}</span> : null}</div>
    {children}
  </section>;
}

/**
 * Where this order came from.
 *
 * A staff-entered order is answered by saying so rather than by an empty panel:
 * a phone order has no campaign, and rendering "Direct" for it would put it in
 * the same bucket as a website visitor who typed the address in.
 *
 * When first and last contact differ, both are shown. The pair is the honest
 * answer — an ad that introduced the customer in February and a direct visit
 * that placed the order in March are two different facts, and collapsing them
 * either flatters the campaign or erases it.
 */
function MarketingSection({ order }: { order: OrderDetail }) {
  const staffEntered = order.channel === "phone" || order.channel === "walk_in";
  const attribution = order.attribution;
  const last = attribution?.last ?? attribution?.first ?? null;
  const showFirst = touchesDiffer(attribution);
  return <Section title="Where it came from" aside={CHANNEL_LABELS[order.channel] ?? order.channel}>
    <p className="od-source">{orderSourceLabel(attribution, order.channel)}</p>
    {staffEntered ? (
      <p className="od-muted">Taken by the restaurant, so there is no campaign to attribute.</p>
    ) : !last ? (
      <p className="od-muted">
        No campaign parameters were on the link this customer arrived by. That is a direct visit, a bookmark,
        or a browser that did not keep them — not a tracking failure.
      </p>
    ) : (
      <>
        <dl className="od-pairs">
          {touchRows(last).map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
        </dl>
        {showFirst ? <>
          <p className="od-subhead">First contact · {orderSourceLabel({ last: attribution?.first }, order.channel)}</p>
          <dl className="od-pairs od-pairs--quiet">
            {touchRows(attribution?.first).map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}
          </dl>
        </> : null}
      </>
    )}
  </Section>;
}

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

  const wantedFor = order
    ? order.schedule_type === "scheduled" && order.scheduled_for
      ? when(order.scheduled_for)
      : `ASAP${order.estimated_for ? ` · promised ${time(order.estimated_for)}` : ""}`
    : "";
  const paidLabel = order ? `${words(order.payment_method)} · ${words(order.payment_status)}` : "";

  return <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
    <aside className="order-drawer" role="dialog" aria-modal="true" aria-labelledby="order-drawer-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="drawer-head">
        <div>
          <small>{order ? `${CHANNEL_LABELS[order.channel] ?? order.channel} · ${order.fulfilment}` : "Order detail"}</small>
          <h2 id="order-drawer-title">{order ? order.order_number.replace("P62-", "#") : "…"}</h2>
        </div>
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="order-drawer-body">
        {loading ? <p className="staff-empty">Loading order…</p> : null}
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        {order ? <>
          <div className="od-tags">
            <span className={`od-pill od-pill--${STATUS_TONE[order.status] ?? "live"}`}>{words(order.status)}</span>
            <span className={`od-pill od-pill--${PAYMENT_TONE[order.payment_status] ?? "warn"}`}>{words(order.payment_status)}</span>
            {order.refundedCents > 0 ? <span className="od-pill od-pill--bad">{formatMoney(order.refundedCents)} refunded</span> : null}
            <span className="od-pill od-pill--quiet">{orderSourceLabel(order.attribution, order.channel)}</span>
          </div>

          {/* The four questions someone opens an order to answer. */}
          <div className="od-facts">
            <Fact label="Placed" value={when(order.created_at)} />
            <Fact label={order.fulfilment === "delivery" ? "Deliver" : "Pickup"} value={wantedFor} />
            <Fact label="Order total" value={formatMoney(order.total_cents)} note={paidLabel} />
            <Fact
              label="Acknowledged"
              value={order.acknowledged_at ? time(order.acknowledged_at) : "Not yet"}
              note={order.takenBy ? `Taken by ${order.takenBy.name ?? "a staff member"}` : null}
            />
          </div>

          <Section title="Customer">
            <p className="od-name">{order.customer_name}</p>
            <div className="od-contact">
              {order.customer_phone ? <a href={`tel:${order.customer_phone.replace(/[^0-9+]/g, "")}`}>{order.customer_phone}</a> : null}
              {order.customer_email ? <a href={`mailto:${order.customer_email}`}>{order.customer_email}</a> : null}
            </div>
            {order.contactRedacted ? <p className="od-muted">Contact hidden — you do not have permission to view customer contact.</p> : null}
          </Section>

          <Section title={order.fulfilment === "delivery" ? "Deliver to" : "Collection"}>
            {order.address ? <>
              <p className="od-address">{order.address.line1}{order.address.unit ? `, Unit ${order.address.unit}` : ""}<br />{order.address.city} {order.address.postalCode}</p>
            </> : <p className="od-address">Collected at the counter.</p>}
            {/* `orders.instructions` is the buzzer note on a delivery and the
                order note on a pickup — the same column, so it is shown with
                whichever of the two this order is rather than adrift below. */}
            {order.instructions ? <p className="od-note">{order.instructions}</p> : null}
          </Section>

          <Section title="Items" aside={`${order.items.reduce((count, item) => count + item.quantity, 0)} item${order.items.reduce((count, item) => count + item.quantity, 0) === 1 ? "" : "s"}`}>
            <div className="od-items">
              {order.items.map((item) => <div className="od-item" key={item.id}>
                <span className="od-qty">{item.quantity}</span>
                <div>
                  <b>{item.productName}{item.variationName ? ` · ${item.variationName}` : ""}</b>
                  {item.flags.length ? <div className="od-flags">{item.flags.map((flag) => <span key={flag}>{flag}</span>)}</div> : null}
                  {item.details.map((detail) => <div className="od-detail" key={detail.label}><b>{detail.label}:</b> {detail.value}</div>)}
                  {item.instructions ? <div className="od-note">Note: {item.instructions}</div> : null}
                </div>
                <b className="od-money">{formatMoney(item.lineTotalCents)}</b>
              </div>)}
            </div>
          </Section>

          <Section title="Money" aside={paidLabel}>
            <div className="od-totals">
              {totalRows(order).map((row) => <div className={row.strong ? "od-total-strong" : ""} key={row.label}><span>{row.label}</span><span>{row.value}</span></div>)}
            </div>
            {/* The provider reference is the only value that ties a line on a
                Clover settlement report back to this order number. */}
            {order.payments.length ? <div className="od-rows">
              {order.payments.map((payment) => <div className="od-row" key={payment.id}>
                <span>{formatMoney(payment.amount_cents)} · {payment.provider} {words(payment.status)}</span>
                <small>{payment.provider_reference ?? "no provider reference"} · {when(payment.created_at)}{payment.failure_reason ? ` · ${payment.failure_reason}` : ""}</small>
              </div>)}
            </div> : null}
            {order.refunds.length ? <div className="od-rows od-rows--bad">
              {order.refunds.map((refund) => <div className="od-row" key={refund.id}>
                <span>{formatMoney(refund.amount_cents)} {refund.status === "voided" ? "(voided)" : "refunded"}</span>
                <small>{refund.reason} · {refund.actor_name ?? "staff"} · {when(refund.created_at)}</small>
                {refund.customer_note ? <small>{refund.customer_note}</small> : null}
              </div>)}
            </div> : null}
          </Section>

          <MarketingSection order={order} />

          {order.feedback ? <Section title="Feedback" aside={order.feedback.reviewed_at ? "Reviewed" : "Not yet reviewed"}>
            <p className="od-stars">{"★".repeat(order.feedback.overall_rating)}{"☆".repeat(5 - order.feedback.overall_rating)}</p>
            {order.feedback.written_feedback ? <p className="od-quote">{order.feedback.written_feedback}</p> : null}
            <p className="od-muted">{when(order.feedback.submitted_at)}</p>
          </Section> : null}

          <Section title="Timeline">
            <div className="od-rows">
              {order.events.map((event) => <div className="od-row" key={event.id}>
                <span>{words(event.next_status)}</span>
                <small>{event.actor_type === "staff" ? (event.actor_name ?? "Staff") : event.actor_type} · {when(event.created_at)}{event.note ? ` · ${event.note}` : ""}</small>
              </div>)}
            </div>
          </Section>
        </> : null}
      </div>
    </aside>
  </div>;
}
