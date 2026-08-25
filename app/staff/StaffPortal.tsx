"use client";

import { FormEvent, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { BrandLogo } from "@/app/BrandLogo";
import { formatMoney } from "@/lib/domain";
import { snapshotDetails, snapshotFlags, totalRows, type ItemSnapshot } from "@/lib/order-presentation";
import { buildPassPrntDrawerUri, buildPassPrntUri, shouldUsePassPrnt } from "@/lib/passprnt";
import { capturePassPrntResult } from "@/lib/passprnt-result";
import { AdminMenuPanel, AdminSettingsPanel, AdminTeamPanel, AdminWebsitePanel } from "@/app/staff/AdminControls";
import { AdminAnalyticsPanel } from "@/app/staff/AdminAnalytics";
import { EmployeeTimeClock } from "@/app/staff/TimeClock";
import { ManagerTimeClock } from "@/app/staff/TimeClockManager";
import { AdminRecordsPanel } from "@/app/staff/AdminRecords";
import { AdminCustomersPanel } from "@/app/staff/AdminCustomers";
import { AdminIntegrationsPanel } from "@/app/staff/AdminIntegrations";
import { StaffOrderEntry } from "@/app/staff/StaffOrderEntry";

type User = { id: string; email: string; name: string; role: string; permissions: string[] };
export type Dashboard = {
  user: User;
  orders: Array<Record<string, unknown>>;
  // H-20a: checkouts that were started and never completed. A separate list from
  // `orders` on purpose - they are not confirmed and must not reach the kitchen.
  awaitingPayment: Array<Record<string, unknown>>;
  metrics: Record<string, unknown>;
  availabilityWarnings: { count?: number };
  clockedIn: Array<Record<string, unknown>>;
  lowRatings: Array<Record<string, unknown>>;
  settings: Record<string, { value: Record<string, unknown>; version: number; updatedAt: number }>;
  products: Array<{ id: string; category_id: string; name: string; description: string; product_type: "pizza" | "simple" | "bundle" | "configurable"; image_url: string | null; base_price_cents: number; active: number; sold_out: number; pickup_eligible: number; delivery_eligible: number; taxable: number; halal_capable: number; setup_required: number; kitchen_label: string; configuration: Record<string, unknown>; display_order: number }>;
  toppings: Array<{ id: string; name: string; kitchen_label: string; is_meat: number; has_halal_version: number; halal_available: number; active: number }>;
  categories: Array<{ id: string; name: string; slug: string; description: string | null; active: number; display_order: number }>;
  variations: Array<{ id: string; product_id: string; name: string; base_price_cents: number; extra_topping_price_cents: number; included_topping_units_bps: number; active: number; display_order: number }>;
  staff: Array<{ id: string; email: string; name: string; role: string; permissions: string[]; active: number; last_login_at: number | null; created_at: number }>;
  promotions: Array<Record<string, unknown>>;
  closures: Array<{ id: string; startsAt: number; endsAt: number; scope: "both" | "pickup" | "delivery"; reason: string; customerMessage: string | null }>;
  integrations: { cloverCheckout: boolean; cloverWebhook: boolean; emailApiKey: boolean; emailProvider: string | null };
};

const permissionLabels = [
  ["view_orders", "View orders"], ["acknowledge_orders", "Acknowledge orders"],
  ["change_order_status", "Change order status"], ["view_customer_contact", "Customer contact"],
  ["change_preparation_time", "Preparation time"], ["pause_online_ordering", "Pause ordering"],
  ["mark_products_unavailable", "Product availability"], ["cancel_orders", "Cancel orders"],
  ["issue_refunds", "Issue refunds"], ["manage_menu", "Manage menu"],
  ["manage_promotions", "Manage promotions"], ["manage_employees", "Manage employees"],
  ["edit_time_records", "Edit time records"], ["approve_correction_requests", "Approve corrections"],
  ["approve_time_off_requests", "Approve time off"], ["view_analytics", "View analytics"],
  ["export_payroll", "Export payroll"], ["manage_settings", "Manage settings"],
] as const;

const SECTION_TITLES: Record<string, string> = {
  orders: "Live orders",
  till: "Take an order",
  analytics: "Analytics",
  records: "History & offers",
  customers: "Customers",
  website: "Website",
  settings: "Settings",
  integrations: "Integrations",
  menu: "Menu setup",
  team: "Team",
  timeclock: "Time clock",
};

function StaffBrand({ label = "Operations" }: { label?: string }) {
  return <div className="staff-brand"><BrandLogo name="Pizza 62" chip /><small>{label}</small></div>;
}

export default function StaffPortal({ mode }: { mode: "admin" | "kitchen" | "employee" }) {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    fetch("/api/auth/me")
      .then(async (response) => response.ok ? response.json() : null)
      .then((result) => setUser(result?.user ?? null))
      .finally(() => setChecking(false));
  }, []);
  if (checking) return <div className="login-shell login-shell--checking"><div className="login-panel"><div className="login-card login-card--checking" role="status">Checking secure staff access…</div></div></div>;
  if (!user) return <StaffLogin mode={mode} onUser={setUser} />;
  if (mode === "employee") return <EmployeeTimeClock user={user} onLogout={() => setUser(null)} />;
  return <OperationsPortal mode={mode} user={user} onLogout={() => setUser(null)} />;
}

function StaffLogin({ mode, onUser }: { mode: string; onUser: (user: User) => void }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [bootstrap, setBootstrap] = useState(false); const [name, setName] = useState(""); const [secret, setSecret] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch(bootstrap ? "/api/auth/bootstrap" : "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(bootstrap ? { name, email, password, setupSecret: secret } : { email, password }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "Sign-in failed."); onUser(result.user);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Sign-in failed."); setBusy(false); }
  };
  return <div className="login-shell"><section className="login-art"><StaffBrand /><div><h1>Hot orders.<br />Cool heads.</h1><p>A focused operations hub for the Pizza 62 team—from the first alert to the final clock-out.</p></div><small>Private staff access · Every sensitive action is permission checked</small></section><section className="login-panel"><form className="login-card" onSubmit={submit}><StaffBrand /><h2>{bootstrap ? "Create owner access" : `${mode === "employee" ? "Team" : "Staff"} sign in`}</h2><p>{bootstrap ? "This one-time setup requires the secure secret configured in the hosting environment." : "Use your individual Pizza 62 email and password."}</p>{bootstrap ? <label>Owner name<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></label> : null}<label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label><label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={bootstrap ? "new-password" : "current-password"} required /></label>{bootstrap ? <label>Owner setup secret<input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" required /></label> : null}{error ? <div className="form-error" role="alert">{error}</div> : null}<button className="staff-button" disabled={busy}>{busy ? "Please wait…" : bootstrap ? "Create owner" : "Sign in"}</button><div className="bootstrap-note"><strong>{bootstrap ? "Already set up?" : "First-time owner setup"}</strong><p>{bootstrap ? "Return to normal sign in." : "An environment secret is required and no default password exists."}</p><button type="button" className="text-button" onClick={() => { setBootstrap(!bootstrap); setError(""); }}>{bootstrap ? "Back to sign in" : "Set up the first owner"}</button></div><Link className="login-back-link" href="/">← Back to the customer site</Link></form></section></div>;
}

function OperationsPortal({ mode, user, onLogout }: { mode: "admin" | "kitchen"; user: User; onLogout: () => void }) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null); const [error, setError] = useState(""); const [section, setSection] = useState(mode === "kitchen" ? "orders" : "overview"); const [sound, setSound] = useState(false); const audioRef = useRef<AudioContext | null>(null);
  const load = useCallback(async () => {
    const response = await fetch("/api/admin/dashboard");
    if (response.status === 401) { onLogout(); return; }
    const result = await response.json();
    if (!response.ok) { setError(result.error ?? "Dashboard unavailable."); return; }
    setDashboard(result); setError("");
  }, [onLogout]);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(load, mode === "kitchen" ? 10_000 : 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load, mode]);
  const unacknowledged = dashboard?.orders.filter((order) => !order.acknowledged_at) ?? [];
  useEffect(() => {
    if (!sound || !unacknowledged.length) return;
    const timer = window.setInterval(() => {
      const context = audioRef.current; if (!context) return;
      const oscillator = context.createOscillator(); const gain = context.createGain();
      oscillator.frequency.value = 720; gain.gain.value = .05; oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + .16);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [sound, unacknowledged.length]);
  const enableSound = () => { audioRef.current ??= new AudioContext(); setSound((value) => !value); };
  const action = async (body: Record<string, unknown>) => {
    setError(""); const response = await fetch("/api/admin/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const result = await response.json(); if (!response.ok) setError(result.error ?? "Action failed."); else void load();
  };
  const logout = async () => { await fetch("/api/auth/logout", { method: "POST" }); onLogout(); };
  // Same gate as the API: the directory's whole reason to exist is contact
  // information, so it is hidden at the door rather than shown with every row
  // redacted — see app/api/admin/customers/route.ts.
  const canViewCustomers = user.role === "owner" || user.permissions.includes("view_customer_contact");
  return <div className="staff-shell"><aside className="staff-sidebar"><StaffBrand /><nav className="staff-nav" aria-label="Operations sections">{mode === "admin" ? <><button aria-pressed={section === "overview"} className={section === "overview" ? "active" : ""} onClick={() => setSection("overview")}><span>Overview</span></button><button aria-pressed={section === "orders"} className={section === "orders" ? "active" : ""} onClick={() => setSection("orders")}><span>Live orders</span></button><button aria-pressed={section === "till"} className={section === "till" ? "active" : ""} onClick={() => setSection("till")}><span>Take an order</span></button><button aria-pressed={section === "analytics"} className={section === "analytics" ? "active" : ""} onClick={() => setSection("analytics")}><span>Analytics</span></button><button aria-pressed={section === "records"} className={section === "records" ? "active" : ""} onClick={() => setSection("records")}><span>History &amp; offers</span></button>{canViewCustomers ? <button aria-pressed={section === "customers"} className={section === "customers" ? "active" : ""} onClick={() => setSection("customers")}><span>Customers</span></button> : null}<button aria-pressed={section === "website"} className={section === "website" ? "active" : ""} onClick={() => setSection("website")}><span>Website</span></button><button aria-pressed={section === "settings"} className={section === "settings" ? "active" : ""} onClick={() => setSection("settings")}><span>Settings</span></button><button aria-pressed={section === "integrations"} className={section === "integrations" ? "active" : ""} onClick={() => setSection("integrations")}><span>Integrations</span></button><button aria-pressed={section === "menu"} className={section === "menu" ? "active" : ""} onClick={() => setSection("menu")}><span>Menu setup</span></button><button aria-pressed={section === "team"} className={section === "team" ? "active" : ""} onClick={() => setSection("team")}><span>Team</span></button><button aria-pressed={section === "timeclock"} className={section === "timeclock" ? "active" : ""} onClick={() => setSection("timeclock")}><span>Time clock</span></button><a href="/employee"><span>My clock</span></a></> : <><button aria-pressed="true" className="active"><span>Kitchen board</span></button><a href="/admin"><span>Admin</span></a></>}</nav><div className="staff-sidebar-footer"><strong>{user.name}</strong><small>{user.role}</small><button onClick={logout}>Sign out</button></div></aside><main className="staff-main"><div className="staff-topbar"><div><h1>{mode === "kitchen" ? "Kitchen command" : section === "overview" ? "Good service starts here" : SECTION_TITLES[section] ?? section}</h1><p>{new Date().toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Toronto" })} · Hamilton time</p></div><div className="sound-control"><span className="live-chip"><i /> Live</span>{mode === "kitchen" ? <button onClick={enableSound}>{sound ? "Sound on" : "Enable alerts"}</button> : null}<button className="mobile-signout" onClick={logout}>Sign out</button></div></div>{error ? <div className="form-error" role="alert">{error}</div> : null}{unacknowledged.length ? <div className="new-order-alert">{unacknowledged.length} new order{unacknowledged.length === 1 ? "" : "s"} waiting for acknowledgement</div> : null}
    {!dashboard ? <div className="staff-panel" role="status">Loading live operations…</div> : section === "overview" ? <AdminOverview dashboard={dashboard} action={action} /> : section === "orders" ? <>{mode === "kitchen" ? null : <AwaitingPaymentPanel dashboard={dashboard} />}<OrdersPanel dashboard={dashboard} action={action} kitchen={mode === "kitchen"} /></> : section === "till" ? <StaffOrderEntry dashboard={dashboard} onPlaced={load} /> : section === "records" ? <AdminRecordsPanel dashboard={dashboard} onSaved={load} /> : section === "customers" && canViewCustomers ? <AdminCustomersPanel /> : section === "timeclock" ? <ManagerTimeClock /> : section === "analytics" ? <AdminAnalyticsPanel /> : section === "website" ? <AdminWebsitePanel dashboard={dashboard} onSaved={load} /> : section === "settings" ? <AdminSettingsPanel dashboard={dashboard} onSaved={load} /> : section === "integrations" ? <AdminIntegrationsPanel /> : section === "menu" ? <AdminMenuPanel dashboard={dashboard} onSaved={load} /> : <AdminTeamPanel dashboard={dashboard} onSaved={load} />}
  </main></div>;
}

function AdminOverview({ dashboard, action }: { dashboard: Dashboard; action: (body: Record<string, unknown>) => Promise<void> }) {
  const metrics = dashboard.metrics; const ordering = dashboard.settings.ordering?.value ?? {};
  return <><div className={ordering.paused ? "danger-banner" : "danger-banner"}><span><strong>{ordering.paused ? "Online ordering is paused" : "Online ordering is live"}</strong> · Pickup {String(ordering.pickupEstimateMinutes ?? 15)} min · Delivery {String(ordering.deliveryEstimateMinutes ?? 30)} min</span><button onClick={() => action({ action: "ordering.pause", paused: !ordering.paused, reason: "Changed from operations overview" })}>{ordering.paused ? "Resume ordering" : "Pause ordering"}</button></div><section className="stats-grid"><Stat label="Sales · today" value={formatMoney(Number(metrics.sales_cents ?? 0))} note="Paid orders · Toronto day" /><Stat label="Orders · today" value={String(metrics.order_count ?? 0)} note="Paid · Toronto day" /><Stat label="Average order" value={formatMoney(Math.round(Number(metrics.average_cents ?? 0)))} note="Paid orders today" /><Stat label="Team on clock" value={String(dashboard.clockedIn.length)} note="Live clock status" /></section><AwaitingPaymentPanel dashboard={dashboard} /><div className="staff-grid"><OrdersPanel dashboard={dashboard} action={action} compact /><aside className="staff-panel"><div className="staff-panel-head"><h2>Launch status</h2></div><div className="setup-list"><SetupItem title="Actual menu loaded" text={`${dashboard.products.filter((product) => product.active).length} current menu items are available to manage.`} /><SetupItem title="Clover" text={dashboard.integrations.cloverCheckout && dashboard.integrations.cloverWebhook ? "Payment and webhook secrets are configured." : "Add CLOVER_MERCHANT_ID, CLOVER_API_TOKEN and CLOVER_WEBHOOK_SECRET before online payment."} /><SetupItem title="Email" text={dashboard.integrations.emailApiKey ? `${dashboard.integrations.emailProvider ?? "Email"} credentials are configured.` : "Add EMAIL_PROVIDER and EMAIL_API_KEY when you choose a provider."} /><SetupItem title="Owner setup" text={`${dashboard.availabilityWarnings.count ?? 0} active items are sold out or need attention.`} /></div></aside></div></>;
}
function Stat({ label, value, note }: { label: string; value: string; note: string }) { return <article className="stat-card"><span>{label}</span><strong>{value}</strong><small>{note}</small></article>; }
function SetupItem({ title, text }: { title: string; text: string }) { return <div className="setup-item"><b>!</b><div><strong>{title}</strong><p>{text}</p></div></div>; }

// C-05: kitchen ticket — every fulfilment-critical detail so an order can be made
// and handed off from the card alone: items, size/variation, toppings with half
// placement, extra cheese, halal, deal/wing modifier selections, per-item and order
// notes, delivery address, and payment state. Contact fields honour C-03 (the API
// only sends phone/email when the viewer has view_customer_contact).
/**
 * The kitchen ticket as it goes to paper.
 *
 * Desktop browsers use `window.print()` against the receipt stylesheet. The
 * restaurant's actual till is an Android tablet, so its button serializes the
 * same information into Star PassPRNT instead; PassPRNT is the on-LAN bridge to
 * the TSP143IIILAN and its attached cash drawer.
 *
 * It is a separate component from the on-screen `KitchenTicket` rather than the
 * same one restyled, because the two are answering different questions. On
 * screen the ticket sits inside a card that already shows the order number,
 * customer and time, so it only lists items. On paper it is alone: it has to
 * carry its own header, or the person holding it cannot tell which order it is.
 *
 * Rendered through a portal to `document.body` so the print stylesheet can hide
 * every sibling with one rule. Without that it would be buried inside the app's
 * root element and hiding its ancestors would hide it too.
 */
function PrintableTicket({ order, toppingNames, printedAt }: { order: Record<string, unknown>; toppingNames: Map<string, string>; printedAt: number }) {
  const items = (order.items as Array<Record<string, unknown>> | undefined) ?? [];
  const address = order.address as Record<string, string> | null;
  const scheduled = order.schedule_type === "scheduled" && order.scheduled_for ? Number(order.scheduled_for) : null;
  const time = (value: number) =>
    new Date(value).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" });
  const paid = String(order.payment_status ?? "") === "paid";

  return <div className="print-root">
    <div className="pt-head">
      {/* The largest thing on the ticket. Everything else is detail; this is
          what someone matches against a bag at the counter. */}
      <div className="pt-number">{String(order.order_number ?? "").replace("P62-", "#")}</div>
      <div className="pt-type">{String(order.fulfilment ?? "").toUpperCase()}</div>
    </div>
    <div className="pt-when">
      {scheduled ? `SCHEDULED ${time(scheduled)}` : `ASAP — in by ${time(Number(order.created_at))}`}
    </div>
    <div className="pt-rule" />
    <div className="pt-customer">
      <strong>{String(order.customer_name ?? "")}</strong>
      {order.customer_phone ? <div>{String(order.customer_phone)}</div> : null}
      {/* Where it came from, so a counter query about "the phone order" can be
          matched to paper without going back to a screen. */}
      <div className="pt-origin">
        {String(order.channel ?? "online") === "online" ? "WEBSITE" : String(order.channel).replaceAll("_", " ").toUpperCase()}
        {" · "}
        {String(order.payment_method ?? "").replaceAll("_", " ").toUpperCase()}
      </div>
    </div>
    <div className="pt-rule" />
    {items.map((item, index) => {
      const snapshot = (item.snapshot as ItemSnapshot) ?? {};
      // The same resolver the confirmation email uses, so paper and inbox
      // describe the order in exactly the same words. A ticket that reads
      // differently from what the customer was sent is how a correct order
      // becomes a dispute nobody can settle.
      const flags = snapshotFlags(snapshot);
      const details = snapshotDetails(snapshot, toppingNames);
      return <div className="pt-item" key={String(item.id ?? index)}>
        <div className="pt-item-head">
          <span className="pt-qty">{String(item.quantity)}&times;</span>
          <span>{String(item.productName)}{item.variationName ? ` · ${String(item.variationName)}` : ""}</span>
        </div>
        {/* Halal, extra cheese and anything the customer asked us to leave off.
            Called out rather than left to blend into the option list — H-03: an
            omission the kitchen cannot see will not happen, which would make
            enforcing the recipe server-side pointless. */}
        {flags.map((flag) => <div className="pt-flag" key={flag}>** {flag.toUpperCase()} **</div>)}
        {/* Every choice, labelled. Toppings arrive grouped by placement
            (“LEFT HALF: …”) rather than suffixed per name, because a half-and-half
            read off a list of suffixes at 9pm is a half-and-half made wrong. */}
        {details.map((detail) => <div className="pt-sub" key={detail.label}>
          <b>{detail.label.toUpperCase()}:</b> {detail.value}
        </div>)}
        {item.instructions ? <div className="pt-note">NOTE: {String(item.instructions)}</div> : null}
      </div>;
    })}
    <div className="pt-rule" />
    {address ? <div className="pt-address">
      <strong>DELIVER TO</strong>
      <div>{address.line1}{address.unit ? `, Unit ${address.unit}` : ""}</div>
      <div>{address.city} {address.postalCode}</div>
      {/* `orders.instructions` is where the buzzer note is kept — the address
          JSON is normalised down to what the radius check needs — so it is
          printed here, with the address, rather than adrift at the bottom. */}
      {order.instructions ? <div className="pt-note">{String(order.instructions)}</div> : null}
    </div> : <>{order.instructions ? <div className="pt-note">ORDER NOTE: {String(order.instructions)}</div> : null}</>}
    <div className="pt-rule" />
    {/* The full breakdown, not just the total. Someone reconciling the till at
        close needs the same numbers the customer was charged, and a ticket that
        shows only a grand total cannot answer “was the delivery fee taken?” */}
    <div className="pt-money">
      {totalRows({
        subtotal_cents: Number(order.subtotal_cents ?? 0),
        discount_cents: Number(order.discount_cents ?? 0),
        tax_cents: Number(order.tax_cents ?? 0),
        delivery_fee_cents: Number(order.delivery_fee_cents ?? 0),
        tip_cents: Number(order.tip_cents ?? 0),
        total_cents: Number(order.total_cents ?? 0),
      }).filter((row) => !row.strong).map((row) => <div className="pt-money-row" key={row.label}>
        <span>{row.label}</span><span>{row.value}</span>
      </div>)}
    </div>
    {/* Whether to take money is the one thing a mistake on is expensive, so it
        is stated in the imperative rather than as a status word. */}
    <div className="pt-total">
      <span>{paid ? "PAID ONLINE" : "COLLECT"}</span>
      <span>{formatMoney(Number(order.total_cents ?? 0))}</span>
    </div>
    {/* Captured when the button was pressed, not read during render: the clock
        is impure, and "when this was sent to print" is the honest meaning. */}
    <div className="pt-footer">Pizza 62 · printed {time(printedAt)}</div>
  </div>;
}

function KitchenTicket({ order, toppingNames }: { order: Record<string, unknown>; toppingNames: Map<string, string> }) {
  const items = (order.items as Array<Record<string, unknown>> | undefined) ?? [];
  const address = order.address as Record<string, string> | null;
  const phone = order.customer_phone ? String(order.customer_phone) : null;
  return <div className="kitchen-ticket">
    {items.map((item, index) => {
      const snapshot = (item.snapshot as ItemSnapshot) ?? {};
      // Shared with the printed ticket and the emails — see lib/order-presentation.ts.
      const flags = snapshotFlags(snapshot);
      const details = snapshotDetails(snapshot, toppingNames);
      return <div className="ticket-line" key={String(item.id ?? index)}>
        <div className="ticket-line-head"><strong>{String(item.quantity)}× {String(item.productName)}</strong>{item.variationName ? <span> · {String(item.variationName)}</span> : null}{flags.map((flag) => <span className={`ticket-tag${flag.startsWith("No ") ? " ticket-tag--warn" : ""}`} key={flag}>{flag}</span>)}</div>
        {details.map((detail) => <div className="ticket-modifier" key={detail.label}><em>{detail.label}:</em> {detail.value}</div>)}
        {item.instructions ? <div className="ticket-note">Note: {String(item.instructions)}</div> : null}
      </div>;
    })}
    {address ? <div className="ticket-address"><strong>Deliver to:</strong> {address.line1}{address.unit ? `, Unit ${address.unit}` : ""}, {address.city} {address.postalCode}{order.instructions ? ` — ${String(order.instructions)}` : ""}</div> : null}
    <div className="ticket-payment">{String(order.payment_method ?? "").replaceAll("_", " ")} · {String(order.payment_status ?? "").replaceAll("_", " ")}{phone ? ` · ${phone}` : order.contactRedacted ? " · contact hidden" : ""}</div>
    {!address && order.instructions ? <div className="ticket-note">Order note: {String(order.instructions)}</div> : null}
  </div>;
}

/**
 * H-20a: checkouts that started and never finished.
 *
 * These orders exist, hold a real cart, and belong to a real customer, but they
 * were absent from every screen — the live queue filters them out and the
 * history filter had no option for the status. So the one case that most needs a
 * human, a customer whose card was charged but whose confirmation never arrived,
 * was the one case nobody could see.
 *
 * Deliberately read-only and visually quiet: it is a watchlist, not a work
 * queue. Most rows here are abandoned carts that the payment reaper will cancel
 * on its own. What matters is that a row which *stays* becomes visible.
 */
function AwaitingPaymentPanel({ dashboard }: { dashboard: Dashboard }) {
  const waiting = dashboard.awaitingPayment ?? [];
  if (waiting.length === 0) return null;
  return <section className="staff-panel">
    <div className="staff-panel-head">
      <h2>Awaiting payment</h2>
      <span className="live-chip">{waiting.length} unconfirmed</span>
    </div>
    <p className="editor-hint">Checkout was started but never confirmed. Nothing has been cooked and no payment is recorded. Most of these are abandoned carts and expire on their own — one that lingers may mean a payment went through without reaching us.</p>
    {waiting.map((order) => <article className="ops-order" key={String(order.id)}>
      <div className="order-ref">{String(order.order_number).replace("P62-", "#")}</div>
      <div>
        <h3>{String(order.customer_name)} · {String(order.fulfilment)}</h3>
        <p>Started {new Date(Number(order.created_at)).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })} · {formatMoney(Number(order.total_cents))}</p>
        <span className="status-pill">{String(order.payment_status).replaceAll("_", " ")}</span>
      </div>
    </article>)}
  </section>;
}

// Reading the URL and the user agent during an ordinary render is what broke
// the feedback page: the server and the browser disagreed about the first
// screen and React threw the markup away. Same crossing, same instrument.
const NEVER_CHANGES = () => () => {};
const NO_PRINT_RESULT = () => null;
const readViaPassPrnt = () => shouldUsePassPrnt(window.navigator.userAgent);
const NOT_PASSPRNT = () => false;

function OrdersPanel({ dashboard, action, compact = false, kitchen = false }: { dashboard: Dashboard; action: (body: Record<string, unknown>) => Promise<void>; compact?: boolean; kitchen?: boolean }) {
  const orders = compact ? dashboard.orders.slice(0, 6) : dashboard.orders;
  const toppingNames = new Map(dashboard.toppings.map((topping) => [topping.id, topping.name]));
  // The order currently being sent to paper. Exactly one at a time: the print
  // stylesheet hides everything except the ticket, so a second one on the page
  // would come out on the same receipt.
  const [printJob, setPrintJob] = useState<{ order: Record<string, unknown>; at: number } | null>(null);
  // What the printer app said when it handed control back, if anything, and
  // whether this device prints through PassPRNT at all. Both are browser-only
  // facts on a page the server also renders, so both cross that gap the way
  // FeedbackApp does rather than by branching mid-render.
  const printResult = useSyncExternalStore(NEVER_CHANGES, capturePassPrntResult, NO_PRINT_RESULT);
  const viaPassPrnt = useSyncExternalStore(NEVER_CHANGES, readViaPassPrnt, NOT_PASSPRNT);
  // Cleared by the next print attempt: a warning about the previous ticket
  // sitting over a successful one is its own kind of wrong.
  const [printAlertDismissed, setPrintAlertDismissed] = useState(false);
  const printAlert = !printAlertDismissed && printResult && !printResult.ok ? printResult.message : null;

  useEffect(() => {
    if (!printJob) return;
    const finished = () => setPrintJob(null);
    window.addEventListener("afterprint", finished);
    // Deferred a tick so React has painted the ticket before the print dialog
    // reads the DOM — window.print() is synchronous and would otherwise capture
    // the page as it was before this render.
    const timer = window.setTimeout(() => window.print(), 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", finished);
    };
  }, [printJob]);
  const passPrntCallback = () => {
    const callback = new URL(window.location.href);
    callback.searchParams.delete("passprnt_code");
    callback.searchParams.delete("passprnt_message");
    return callback.toString();
  };
  /**
   * `viaBrowser` is the escape hatch. If PassPRNT cannot reach the printer, the
   * tablet previously had no way to get a ticket out at all — this hands the
   * same ticket to the browser's own print dialog, which needs no hardware and
   * is how every device printed before the PassPRNT bridge existed.
   */
  const printOrder = (order: Record<string, unknown>, viaBrowser = false) => {
    const printedAt = Date.now();
    setPrintAlertDismissed(true);
    if (!viaBrowser && shouldUsePassPrnt(window.navigator.userAgent)) {
      // Keep this navigation inside the click handler. Android browsers commonly
      // block a custom URL scheme after an async wait or a React effect because
      // it no longer counts as a direct user gesture.
      window.location.assign(buildPassPrntUri({
        order,
        toppingNames,
        printedAt,
        callbackUrl: passPrntCallback(),
      }));
      return;
    }
    // The desktop fallback stays useful for setup and emergency printing.
    setPrintJob({ order, at: printedAt });
  };
  const openCashDrawer = () => {
    if (!shouldUsePassPrnt(window.navigator.userAgent)) return;
    // Direct click → PassPRNT → printer drawer. No receipt data is included, so
    // the printer neither feeds nor cuts paper.
    window.location.assign(buildPassPrntDrawerUri({ callbackUrl: passPrntCallback() }));
  };
  return <section className="staff-panel"><div className="staff-panel-head"><h2>{kitchen ? "Active kitchen queue" : "Live orders"}</h2><span className="live-chip"><i /> {orders.length} active</span></div>{printAlert ? <p className="form-error" role="alert">{printAlert} Use <b>Browser print</b> on the order to get the ticket out.</p> : null}{orders.length ? orders.map((order) => { const next = order.status === "received" ? "preparing" : order.status === "preparing" ? (order.fulfilment === "pickup" ? "ready_for_pickup" : "out_for_delivery") : order.status === "ready_for_pickup" || order.status === "out_for_delivery" ? "completed" : null; const payAtStore = String(order.payment_method) === "pay_at_store"; return <article className={`ops-order ${!order.acknowledged_at ? "unacknowledged" : ""}`} key={String(order.id)}><div className="order-ref">{String(order.order_number).replace("P62-", "#")}</div><div><h3>{String(order.customer_name)} · {String(order.fulfilment)}</h3><p>{order.schedule_type === "scheduled" ? `Scheduled ${new Date(Number(order.scheduled_for)).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })}` : `Received ${new Date(Number(order.created_at)).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })}`} · {formatMoney(Number(order.total_cents))}</p><KitchenTicket order={order} toppingNames={toppingNames} /><span className="status-pill">{String(order.status).replaceAll("_", " ")}</span></div><div className="order-actions"><button onClick={() => printOrder(order)}>Print ticket</button>{viaPassPrnt ? <button onClick={() => printOrder(order, true)}>Browser print</button> : null}{payAtStore ? <button onClick={openCashDrawer}>Cash · open drawer</button> : null}{!order.acknowledged_at ? <button onClick={() => action({ action: "order.acknowledge", orderId: order.id })}>Acknowledge</button> : null}{next ? <button onClick={() => action({ action: "order.status", orderId: order.id, status: next })}>{next === "completed" ? "Complete" : `Move to ${String(next).replaceAll("_", " ")}`}</button> : null}</div></article>; }) : <div className="staff-empty">No active orders. The next confirmed order will appear here.</div>}
    {/* Portalled to document.body so the print stylesheet can hide every sibling
        with one rule; nested inside the app root, hiding its ancestors would
        hide the ticket too. */}
    {printJob && typeof document !== "undefined"
      ? createPortal(
          <PrintableTicket order={printJob.order} toppingNames={toppingNames} printedAt={printJob.at} />,
          document.body,
        )
      : null}
  </section>;
}

export function LegacySettingsPanel({ dashboard, onSaved }: { dashboard: Dashboard; onSaved: () => Promise<void> }) {
  const deliveryRecord = dashboard.settings.delivery; const orderingRecord = dashboard.settings.ordering; const taxRecord = dashboard.settings.taxAndTips; const businessRecord = dashboard.settings.business;
  const [radius, setRadius] = useState(String(deliveryRecord.value.radiusKm ?? 10)); const [fee, setFee] = useState(String(Number(deliveryRecord.value.feeCents ?? 350) / 100)); const [minimum, setMinimum] = useState(String(Number(deliveryRecord.value.minimumCents ?? 0) / 100)); const [pickupEstimate, setPickupEstimate] = useState(String(orderingRecord.value.pickupEstimateMinutes ?? 15)); const [deliveryEstimate, setDeliveryEstimate] = useState(String(orderingRecord.value.deliveryEstimateMinutes ?? 30)); const [tax, setTax] = useState(String(Number(taxRecord.value.taxRateBps ?? 1300) / 100)); const [address, setAddress] = useState(String(businessRecord.value.address ?? "")); const [latitude, setLatitude] = useState(String(businessRecord.value.latitude ?? "")); const [longitude, setLongitude] = useState(String(businessRecord.value.longitude ?? "")); const [reviewUrl, setReviewUrl] = useState(String(businessRecord.value.googleReviewUrl ?? "")); const [status, setStatus] = useState("");
  const save = async (key: string, value: Record<string, unknown>, expectedVersion: number) => { setStatus(""); const response = await fetch("/api/admin/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "settings.update", key, value, expectedVersion, reason: "Updated in admin settings" }) }); const result = await response.json(); setStatus(response.ok ? "Settings saved and audited." : result.error); if (response.ok) await onSaved(); };
  return <div className="admin-stack"><div className="staff-grid"><section className="staff-panel"><div className="staff-panel-head"><h2>Delivery & ordering</h2></div><div className="settings-form"><label>Radius · km<input type="number" min="0.1" max="100" step="0.1" value={radius} onChange={(event) => setRadius(event.target.value)} /></label><label>Delivery fee · C$<input type="number" min="0" step="0.01" value={fee} onChange={(event) => setFee(event.target.value)} /></label><label>Minimum · C$<input type="number" min="0" step="0.01" value={minimum} onChange={(event) => setMinimum(event.target.value)} /></label><label>Pickup estimate · min<input type="number" min="5" max="240" value={pickupEstimate} onChange={(event) => setPickupEstimate(event.target.value)} /></label><label>Delivery estimate · min<input type="number" min="5" max="360" value={deliveryEstimate} onChange={(event) => setDeliveryEstimate(event.target.value)} /></label></div><button className="staff-button" onClick={() => save("delivery", { ...deliveryRecord.value, radiusKm: Number(radius), feeCents: Math.round(Number(fee) * 100), minimumCents: Math.round(Number(minimum) * 100) }, deliveryRecord.version)}>Save delivery</button> <button className="staff-button" onClick={() => save("ordering", { ...orderingRecord.value, pickupEstimateMinutes: Number(pickupEstimate), deliveryEstimateMinutes: Number(deliveryEstimate) }, orderingRecord.version)}>Save estimates</button></section><section className="staff-panel"><div className="staff-panel-head"><h2>Restaurant details</h2></div><div className="settings-form"><label>Address<input value={address} onChange={(event) => setAddress(event.target.value)} /></label><label>Google review URL<input value={reviewUrl} onChange={(event) => setReviewUrl(event.target.value)} /></label><label>Latitude<input type="number" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} /></label><label>Longitude<input type="number" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} /></label></div><button className="staff-button" onClick={() => save("business", { ...businessRecord.value, address, latitude: Number(latitude), longitude: Number(longitude), googleReviewUrl: reviewUrl }, businessRecord.version)}>Save restaurant details</button></section></div><div className="staff-grid"><section className="staff-panel"><div className="staff-panel-head"><h2>Tax & tip</h2></div><div className="settings-form"><label>Menu HST · %<input type="number" min="0" max="30" step="0.01" value={tax} onChange={(event) => setTax(event.target.value)} /></label><label>Delivery fee taxable<input type="text" value={taxRecord.value.deliveryFeeTaxable ? "Yes" : "No"} readOnly /></label></div><button className="staff-button" onClick={() => save("taxAndTips", { ...taxRecord.value, taxRateBps: Math.round(Number(tax) * 100) }, taxRecord.version)}>Save tax settings</button></section><section className="staff-panel"><div className="staff-panel-head"><h2>Provider keys</h2></div><div className="setup-list"><SetupItem title="Clover checkout" text={dashboard.integrations.cloverCheckout ? "Configured" : "Add CLOVER_MERCHANT_ID and CLOVER_API_TOKEN in Azure."} /><SetupItem title="Clover webhook" text={dashboard.integrations.cloverWebhook ? "Configured" : "Add CLOVER_WEBHOOK_SECRET and point Clover to /api/payments/clover/webhook."} /><SetupItem title="Email provider" text={dashboard.integrations.emailApiKey ? `${dashboard.integrations.emailProvider ?? "Provider"} API key configured.` : "When selected, add EMAIL_PROVIDER, EMAIL_API_KEY and EMAIL_FROM as secrets."} /></div></section></div>{status ? <p className="staff-empty" role="status">{status}</p> : null}</div>;
}

export function LegacyMenuPanel({ dashboard, onSaved }: { dashboard: Dashboard; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(""); const [label, setLabel] = useState(""); const [meat, setMeat] = useState(false); const [halal, setHalal] = useState(false); const [message, setMessage] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); const response = await fetch("/api/admin/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "topping.upsert", name, kitchenLabel: label, isMeat: meat, hasHalalVersion: halal, halalAvailable: halal, halalCostCents: 0, active: true }) }); const result = await response.json(); setMessage(response.ok ? "Topping added to the live menu." : result.error); if (response.ok) { setName(""); setLabel(""); await onSaved(); } };
  const updateProduct = async (product: Dashboard["products"][number], changes: Record<string, unknown>) => { const response = await fetch("/api/admin/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "product.update", productId: product.id, ...changes }) }); const result = await response.json(); setMessage(response.ok ? `${product.name} updated.` : result.error); if (response.ok) await onSaved(); };
  const updateTopping = async (topping: Dashboard["toppings"][number], halalAvailable: boolean) => { const response = await fetch("/api/admin/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "topping.upsert", id: topping.id, name: topping.name, kitchenLabel: topping.kitchen_label, isMeat: Boolean(topping.is_meat), hasHalalVersion: halalAvailable, halalAvailable, halalDisplayName: halalAvailable ? `Halal ${topping.name}` : null, halalCostCents: 0, active: Boolean(topping.active) }) }); const result = await response.json(); setMessage(response.ok ? `${topping.name} updated.` : result.error); if (response.ok) await onSaved(); };
  return <div className="admin-stack"><section className="staff-panel"><div className="staff-panel-head"><h2>Current menu · {dashboard.products.length} items</h2><span className="live-chip"><i /> Official menu loaded</span></div><div className="admin-product-list">{dashboard.products.map((product) => <ProductAdminRow key={product.id} product={product} onSave={(changes) => updateProduct(product, changes)} />)}</div></section><section className="staff-panel"><div className="staff-panel-head"><h2>Toppings & halal availability</h2><span className="live-chip">Owner controlled</span></div><div className="admin-topping-list">{dashboard.toppings.map((topping) => <ToppingAdminRow key={topping.id} topping={topping} onSave={(available) => updateTopping(topping, available)} />)}</div></section><div className="staff-grid"><form className="staff-panel employee-form" onSubmit={submit}><div className="staff-panel-head"><h2>Add a topping</h2></div><label>Customer name<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Kitchen label<input value={label} onChange={(event) => setLabel(event.target.value)} required /></label><label><span><input type="checkbox" checked={meat} onChange={(event) => setMeat(event.target.checked)} /> Meat topping</span></label><label><span><input type="checkbox" checked={halal} onChange={(event) => setHalal(event.target.checked)} /> Halal version available</span></label><button className="staff-button">Add topping</button></form><aside className="staff-panel"><div className="staff-panel-head"><h2>Menu rules</h2></div><div className="setup-list"><SetupItem title="Normal toppings" text="Customer ordering uses one straightforward topping list; half requests go in instructions." /><SetupItem title="Halal selection" text="Six common meat toppings start with halal alternatives enabled. Confirm the switches against your suppliers." /><SetupItem title="Drinks" text="Pop is offered only inside items that include pop. Water remains a standalone C$1.60 item." /></div></aside></div>{message ? <p className="staff-empty" role="status">{message}</p> : null}</div>;
}

function ToppingAdminRow({ topping, onSave }: { topping: Dashboard["toppings"][number]; onSave: (available: boolean) => Promise<void> }) {
  const [available, setAvailable] = useState(Boolean(topping.halal_available));
  return <div className="admin-topping-row"><span><strong>{topping.name}</strong><small>{topping.is_meat ? "Meat topping" : "Vegetarian topping"}</small></span><label><input type="checkbox" disabled={!topping.is_meat} checked={available} onChange={(event) => setAvailable(event.target.checked)} /> Halal alternative</label><button className="staff-button" disabled={!topping.is_meat || available === Boolean(topping.halal_available)} onClick={() => onSave(available)}>Save</button></div>;
}

function ProductAdminRow({ product, onSave }: { product: Dashboard["products"][number]; onSave: (changes: Record<string, unknown>) => Promise<void> }) {
  const [price, setPrice] = useState(String(product.base_price_cents / 100));
  const [soldOut, setSoldOut] = useState(Boolean(product.sold_out));
  return <div className="admin-product-row"><div><strong>{product.name}</strong><small>{product.description}</small></div><label>Price<input type="number" min="0" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} /></label><label className="inline-check"><input type="checkbox" checked={soldOut} onChange={(event) => setSoldOut(event.target.checked)} /> Sold out</label><button className="staff-button" onClick={() => onSave({ basePriceCents: Math.round(Number(price) * 100), soldOut })}>Save</button></div>;
}

export function LegacyTeamPanel({ onSaved }: { onSaved: () => Promise<void> }) {
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [permissions, setPermissions] = useState<string[]>(["view_orders", "acknowledge_orders", "change_order_status"]); const [message, setMessage] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); const response = await fetch("/api/admin/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "staff.create", name, email, password, role: "employee", permissions }) }); const result = await response.json(); setMessage(response.ok ? "Employee access created." : result.error); if (response.ok) { setName(""); setEmail(""); setPassword(""); await onSaved(); } };
  return <div className="staff-grid"><form className="staff-panel employee-form" onSubmit={submit}><div className="staff-panel-head"><h2>Create employee access</h2></div><label>Name<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>Temporary password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} required /></label><div className="settings-form">{permissionLabels.map(([key, label]) => <label key={key}><span><input type="checkbox" checked={permissions.includes(key)} onChange={(event) => setPermissions((current) => event.target.checked ? [...current, key] : current.filter((entry) => entry !== key))} /> {label}</span></label>)}</div><button className="staff-button">Create employee</button>{message ? <p className="staff-empty" role="status">{message}</p> : null}</form><aside className="staff-panel"><div className="staff-panel-head"><h2>Permission boundaries</h2></div><div className="setup-list"><SetupItem title="Refunds are separate" text="Refund, cancellation, payroll and employee-management access are independently grantable." /><SetupItem title="No shared passwords" text="Every employee signs in with an individual email and password." /><SetupItem title="Revocation-ready" text="Disabled users no longer pass server-side session checks." /></div></aside></div>;
}
