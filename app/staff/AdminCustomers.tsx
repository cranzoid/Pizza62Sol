"use client";

/**
 * The customer directory.
 *
 * There is no populated `customers` table (`orders.customer_id` is never
 * written), so the directory is derived from `orders` on the server — grouped
 * by email, or by phone when no email was given — and returned already
 * aggregated. See `app/api/admin/customers/route.ts` for the grouping rule
 * and why a counter order with neither is excluded rather than shown as an
 * anonymous row.
 *
 * Self-fetching, like `AdminAnalyticsPanel`: this is its own report, not part
 * of the shared dashboard payload every section polls.
 */
import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/lib/domain";
import { OrderDetailDrawer } from "@/app/staff/OrderDetail";

type CustomerRow = {
  customer_key: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  last_order_number: string;
  last_status: string;
  last_channel: string;
  last_fulfilment: string;
  last_order_at: number;
  order_count: number;
  paid_count: number;
  lifetime_cents: number;
  first_seen: number;
};

type CustomerDetail = {
  customerKey: string;
  name: string;
  phone: string;
  email: string;
  orderCount: number;
  paidCount: number;
  lifetimeCents: number;
  firstSeen: number;
  lastOrderAt: number;
  orders: Array<Record<string, unknown>>;
};

const SORTS = [
  ["recent", "Most recent"],
  ["orders", "Most orders"],
  ["spend", "Highest spend"],
] as const;

const CHANNEL_LABELS: Record<string, string> = { online: "Website", phone: "Phone", walk_in: "Walk-in" };

const when = (value: unknown) =>
  value ? new Date(Number(value)).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" }) : "—";

export function AdminCustomersPanel() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<(typeof SORTS)[number][0]>("recent");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [summary, setSummary] = useState({ customers: 0, repeatCustomers: 0, totalOrders: 0, totalCents: 0 });
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [message, setMessage] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<CustomerDetail | null>(null);
  const [openOrderId, setOpenOrderId] = useState<string | null>(null);

  const filterParams = useCallback(() => {
    const search = new URLSearchParams({ query, sort });
    if (from) search.set("from", from);
    if (to) search.set("to", to);
    return search;
  }, [query, sort, from, to]);

  const load = useCallback(async () => {
    const search = filterParams();
    search.set("page", String(page));
    const response = await fetch(`/api/admin/customers?${search}`);
    const result = await response.json();
    if (!response.ok) { setMessage(result.error ?? "Customers could not be loaded."); return; }
    setCustomers(result.customers ?? []);
    setSummary(result.summary ?? { customers: 0, repeatCustomers: 0, totalOrders: 0, totalCents: 0 });
    setTotal(result.total ?? 0);
    setPageSize(result.pageSize ?? 50);
    setMessage("");
  }, [filterParams, page]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  const changeFilter = <T,>(set: (value: T) => void) => (value: T) => { set(value); setPage(0); };

  const exportCsv = () => {
    const search = filterParams();
    search.set("format", "csv");
    window.location.assign(`/api/admin/customers?${search}`);
  };

  useEffect(() => {
    // Nothing to reset here: the panel below renders null whenever
    // selectedKey is absent, so a stale customer lingering in state until the
    // next fetch resolves is never actually shown.
    if (!selectedKey) return;
    let cancelled = false;
    void (async () => {
      const response = await fetch(`/api/admin/customers?key=${encodeURIComponent(selectedKey)}`);
      const result = await response.json();
      if (cancelled) return;
      if (!response.ok) { setMessage(result.error ?? "That customer could not be loaded."); setSelectedKey(null); return; }
      setSelected(result.customer);
    })();
    return () => { cancelled = true; };
  }, [selectedKey]);

  const avgOrders = summary.customers ? (summary.totalOrders / summary.customers).toFixed(1) : "0";
  const avgSpend = summary.customers ? Math.round(summary.totalCents / summary.customers) : 0;

  return <div className="admin-stack">
    <section className="stats-grid">
      <Stat label="Customers" value={String(summary.customers)} note="Distinct email or phone" />
      <Stat label="Repeat customers" value={String(summary.repeatCustomers)} note="More than one order" />
      <Stat label="Orders per customer" value={avgOrders} note="Average, this range" />
      <Stat label="Average lifetime spend" value={formatMoney(avgSpend)} note="Per customer, this range" />
    </section>

    <div className="viz-toolbar">
      <div className="record-filters">
        <input value={query} onChange={(event) => changeFilter(setQuery)(event.target.value)} placeholder="Name, phone or email" aria-label="Search customers" />
        <select value={sort} onChange={(event) => changeFilter(setSort)(event.target.value as typeof sort)} aria-label="Sort customers">
          {SORTS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <input type="date" value={from} onChange={(event) => changeFilter(setFrom)(event.target.value)} aria-label="From date" />
        <input type="date" value={to} onChange={(event) => changeFilter(setTo)(event.target.value)} aria-label="To date" />
        <button className="staff-button" onClick={exportCsv} disabled={!total}>Export CSV</button>
      </div>
    </div>
    {message ? <p className="admin-message" role="status">{message}</p> : null}

    <section className="staff-panel">
      <div className="staff-panel-head">
        <h2>Customers</h2>
        <span className="live-chip">{total} customer{total === 1 ? "" : "s"}</span>
      </div>
      <div className="table-scroll" role="region" aria-label="Customer directory" tabIndex={0}><table className="viz-table">
        <thead><tr><th scope="col">Customer</th><th scope="col">First seen</th><th scope="col">Orders</th><th scope="col">Lifetime spend</th><th scope="col">Last order</th></tr></thead>
        <tbody>
          {customers.map((customer) => <tr key={customer.customer_key} className="customer-row" onClick={() => setSelectedKey(customer.customer_key)}>
            <th scope="row">{customer.customer_name}<small>{customer.customer_phone}{customer.customer_phone && customer.customer_email ? " · " : ""}{customer.customer_email}</small></th>
            <td>{when(customer.first_seen)}</td>
            <td>{customer.order_count}<small>{customer.paid_count} paid</small></td>
            <td>{formatMoney(customer.lifetime_cents)}</td>
            <td>{customer.last_order_number}<small>{when(customer.last_order_at)} · {String(customer.last_status).replaceAll("_", " ")}</small></td>
          </tr>)}
          {!customers.length ? <tr><td colSpan={5} className="staff-empty">No customers match that search.</td></tr> : null}
        </tbody>
      </table></div>
      {total > pageSize ? <div className="pager">
        <button className="staff-button" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>Previous</button>
        <span>Page {page + 1} of {Math.ceil(total / pageSize)}</span>
        <button className="staff-button" disabled={(page + 1) * pageSize >= total} onClick={() => setPage((current) => current + 1)}>Next</button>
      </div> : null}
    </section>

    {selectedKey ? <section className="staff-panel">
      {selected ? <>
        <div className="customer-panel-head">
          <div>
            <h2>{selected.name}</h2>
            <p>{selected.phone}{selected.phone && selected.email ? " · " : ""}{selected.email}</p>
          </div>
          <button className="staff-button" onClick={() => setSelectedKey(null)}>Back to all customers</button>
        </div>
        <div className="customer-panel-stats">
          <span><b>{selected.orderCount}</b>Orders</span>
          <span><b>{selected.paidCount}</b>Paid</span>
          <span><b>{formatMoney(selected.lifetimeCents)}</b>Lifetime spend</span>
          <span><b>{when(selected.firstSeen)}</b>First seen</span>
        </div>
        <div className="table-scroll" role="region" aria-label="This customer's orders" tabIndex={0}><table className="viz-table">
          <thead><tr><th scope="col">Order</th><th scope="col">When</th><th scope="col">Where from</th><th scope="col">Status</th><th scope="col">Total</th></tr></thead>
          <tbody>
            {selected.orders.map((order) => <tr key={String(order.id)} className="order-history-row" onClick={() => setOpenOrderId(String(order.id))}>
              <th scope="row">{String(order.order_number)}</th>
              <td>{when(order.created_at)}</td>
              <td>{CHANNEL_LABELS[String(order.channel)] ?? String(order.channel)}<small>{String(order.fulfilment)}</small></td>
              <td>{String(order.status).replaceAll("_", " ")}</td>
              <td>{formatMoney(Number(order.total_cents))}</td>
            </tr>)}
          </tbody>
        </table></div>
      </> : <p className="staff-empty">Loading customer…</p>}
    </section> : null}

    <OrderDetailDrawer orderId={openOrderId} onClose={() => setOpenOrderId(null)} />
  </div>;
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return <article className="stat-card"><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}
