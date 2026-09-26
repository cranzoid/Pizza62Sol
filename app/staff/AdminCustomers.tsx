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
  /** "October 3", from the till or a POS import. Never a year. */
  birthday: string | null;
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
    <CustomerListPanel />
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
            <p>{selected.phone}{selected.phone && selected.email ? " · " : ""}{selected.email}{selected.birthday ? ` · Birthday ${selected.birthday}` : ""}</p>
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

type ContactOverview = {
  summary: { contacts: number; imported: number; birthdays: number; optedOut: number };
  birthdays: Array<{ name: string; email: string | null; phone: string | null; label: string; daysAway: number }>;
  canImport: boolean;
  canExport: boolean;
};

type ImportPreview = {
  columns: Record<string, string>;
  ready: number;
  withEmail: number;
  withBirthday: number;
  sample: Array<{ name: string; email: string | null; phone: string | null; birthday: string | null }>;
  skipped: number;
  skippedRows: Array<{ row: number; reason: string }>;
};

const COLUMN_LABELS: Record<string, string> = {
  name: "Name", firstName: "First name", lastName: "Last name", email: "Email", phone: "Phone",
  birthday: "Birthday", notes: "Notes", lastVisit: "Last visit",
};

/**
 * The customer list beyond order history: bring in the old POS list, take the
 * whole list out, see whose birthday is coming up, and unsubscribe someone who
 * asks in person.
 *
 * An import is always previewed first. The owner sees which columns were
 * understood and every row that will be skipped before anything is written —
 * an import that silently dropped half a file would be found out only when the
 * nudge went to half the customers.
 */
function CustomerListPanel() {
  const [overview, setOverview] = useState<ContactOverview | null>(null);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [optOutEmail, setOptOutEmail] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/contacts");
    const result = await response.json();
    if (response.ok) setOverview(result);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch("/api/admin/contacts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "That did not work.");
      return result;
    } catch (caught) {
      setNote({ tone: "bad", text: caught instanceof Error ? caught.message : "That did not work." });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async (file: File | undefined) => {
    setPreview(null);
    setNote(null);
    if (!file) return;
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    const result = await post({ action: "import.preview", csv: text, fileName: file.name });
    if (result) setPreview(result);
  };

  const commit = async () => {
    const result = await post({ action: "import.commit", csv, fileName });
    if (!result) return;
    setPreview(null);
    setCsv("");
    setNote({ tone: "ok", text: `Imported ${fileName}: ${result.created} new customer${result.created === 1 ? "" : "s"}, ${result.updated} already on file${result.skipped ? `, ${result.skipped} skipped` : ""}.` });
    await load();
  };

  if (!overview) return null;
  return <section className="staff-panel">
    <div className="staff-panel-head">
      <h2>Customer list</h2>
      <span className="live-chip">{overview.summary.imported} imported · {overview.summary.birthdays} birthdays · {overview.summary.optedOut} unsubscribed</span>
    </div>
    <p className="editor-hint">Bring in the customer list from the old POS so they hear about the giveaway too. Export it from the POS as a CSV — any file with an email or phone column works. Nothing is written until you confirm the preview, and importing never re-subscribes anyone who unsubscribed.</p>
    <div className="record-filters">
      {overview.canImport ? <label className="staff-button">
        Import from POS (CSV)
        <input type="file" accept=".csv,text/csv" hidden onChange={(event) => { void chooseFile(event.target.files?.[0]); event.target.value = ""; }} />
      </label> : null}
      {overview.canExport ? <button className="staff-button" onClick={() => window.location.assign("/api/admin/contacts?format=csv")}>Export full customer list</button> : null}
    </div>
    {note ? <p className={note.tone === "bad" ? "form-error" : "admin-message"} role="status">{note.text}</p> : null}

    {preview ? <div className="import-preview">
      <h3>{fileName}: {preview.ready} customer{preview.ready === 1 ? "" : "s"} ready to import</h3>
      <p>{preview.withEmail} with an email (these can be nudged) · {preview.withBirthday} with a birthday{preview.skipped ? ` · ${preview.skipped} row${preview.skipped === 1 ? "" : "s"} will be skipped` : ""}</p>
      <p className="secure-note">Columns understood: {Object.entries(preview.columns).map(([key, title]) => `${COLUMN_LABELS[key] ?? key} ← “${title}”`).join(" · ")}</p>
      <div className="table-scroll" role="region" aria-label="Import preview" tabIndex={0}><table className="viz-table">
        <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Phone</th><th scope="col">Birthday</th></tr></thead>
        <tbody>{preview.sample.map((row, index) => <tr key={index}><th scope="row">{row.name || "—"}</th><td>{row.email ?? "—"}</td><td>{row.phone ?? "—"}</td><td>{row.birthday ?? "—"}</td></tr>)}</tbody>
      </table></div>
      {preview.skippedRows.length ? <details><summary>Rows that will be skipped</summary><ul>{preview.skippedRows.map((row) => <li key={row.row}>Row {row.row}: {row.reason}</li>)}</ul></details> : null}
      <div className="pager">
        <button className="staff-button" disabled={busy || !preview.ready} onClick={() => void commit()}>{busy ? "Importing…" : `Import ${preview.ready} customers`}</button>
        <button className="staff-button" onClick={() => { setPreview(null); setCsv(""); }}>Cancel</button>
      </div>
    </div> : null}

    <div className="staff-grid">
      <div>
        <h3>Birthdays in the next month</h3>
        {overview.birthdays.length ? <ul className="birthday-list">{overview.birthdays.map((row, index) => <li key={index}><b>{row.label}</b> {row.name || row.email || row.phone}<small>{row.daysAway === 0 ? "Today!" : row.daysAway === 1 ? "Tomorrow" : `In ${row.daysAway} days`}{row.phone ? ` · ${row.phone}` : ""}</small></li>)}</ul> : <p className="secure-note">None yet. The till asks for a birthday on pickup orders.</p>}
      </div>
      <div>
        <h3>Unsubscribe someone</h3>
        <p className="secure-note">For a customer who asks in person or by phone to stop getting our emails. Receipts still go to them.</p>
        <div className="record-filters">
          <input value={optOutEmail} onChange={(event) => setOptOutEmail(event.target.value)} placeholder="their@email.com" aria-label="Email to unsubscribe" inputMode="email" />
          <button className="staff-button" disabled={busy || !optOutEmail.trim()} onClick={async () => {
            const result = await post({ action: "optOut", email: optOutEmail });
            if (result) { setNote({ tone: "ok", text: `${optOutEmail.trim()} will not get any more marketing emails.` }); setOptOutEmail(""); await load(); }
          }}>Unsubscribe</button>
        </div>
      </div>
    </div>
  </section>;
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return <article className="stat-card"><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}
