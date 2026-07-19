"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { formatMoney } from "@/lib/domain";

type User = { id: string; email: string; name: string; role: string; permissions: string[] };
type Dashboard = {
  user: User;
  orders: Array<Record<string, unknown>>;
  metrics: Record<string, unknown>;
  availabilityWarnings: { count?: number };
  clockedIn: Array<Record<string, unknown>>;
  lowRatings: Array<Record<string, unknown>>;
  settings: Record<string, { value: Record<string, unknown>; version: number; updatedAt: number }>;
};
type ClockData = {
  user: User;
  state: "clocked_out" | "working" | "on_break";
  paidMs: number;
  events: Array<{ id: string; action: string; occurred_at: number; session_id: string }>;
  corrections: Array<Record<string, unknown>>;
  timeOff: Array<Record<string, unknown>>;
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

function StaffBrand() {
  return <div className="staff-brand"><span className="pizza-mark"><span>62</span><i className="pizza-dot pizza-dot--one" /><i className="pizza-dot pizza-dot--two" /></span><span><strong>Pizza 62</strong><small>Operations</small></span></div>;
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
  if (checking) return <div className="login-shell"><div className="login-panel"><div className="login-card" role="status">Checking secure staff access…</div></div></div>;
  if (!user) return <StaffLogin mode={mode} onUser={setUser} />;
  if (mode === "employee") return <EmployeePortal user={user} onLogout={() => setUser(null)} />;
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
  return <div className="login-shell"><section className="login-art"><StaffBrand /><div><h1>Hot orders.<br />Cool heads.</h1><p>A focused operations hub for the Pizza 62 team—from the first alert to the final clock-out.</p></div><small>Private staff access · Every sensitive action is permission checked</small></section><section className="login-panel"><form className="login-card" onSubmit={submit}><StaffBrand /><h2>{bootstrap ? "Create owner access" : `${mode === "employee" ? "Team" : "Staff"} sign in`}</h2><p>{bootstrap ? "This one-time setup requires the secure secret configured in the hosting environment." : "Use your individual Pizza 62 email and password."}</p>{bootstrap ? <label>Owner name<input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></label> : null}<label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label><label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={bootstrap ? "new-password" : "current-password"} required /></label>{bootstrap ? <label>Owner setup secret<input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" required /></label> : null}{error ? <div className="form-error" role="alert">{error}</div> : null}<button className="staff-button" disabled={busy}>{busy ? "Please wait…" : bootstrap ? "Create owner" : "Sign in"}</button><div className="bootstrap-note"><strong>{bootstrap ? "Already set up?" : "First-time owner setup"}</strong><p>{bootstrap ? "Return to normal sign in." : "An environment secret is required and no default password exists."}</p><button type="button" className="text-button" onClick={() => { setBootstrap(!bootstrap); setError(""); }}>{bootstrap ? "Back to sign in" : "Set up the first owner"}</button></div></form></section></div>;
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
  return <div className="staff-shell"><aside className="staff-sidebar"><StaffBrand /><nav className="staff-nav" aria-label="Operations sections">{mode === "admin" ? <><button className={section === "overview" ? "active" : ""} onClick={() => setSection("overview")}><span>Overview</span></button><button className={section === "orders" ? "active" : ""} onClick={() => setSection("orders")}><span>Live orders</span></button><button className={section === "settings" ? "active" : ""} onClick={() => setSection("settings")}><span>Settings</span></button><button className={section === "menu" ? "active" : ""} onClick={() => setSection("menu")}><span>Menu setup</span></button><button className={section === "team" ? "active" : ""} onClick={() => setSection("team")}><span>Team</span></button><a href="/employee"><span>Time clock</span></a></> : <><button className="active"><span>Kitchen board</span></button><a href="/admin"><span>Admin</span></a></>}</nav><div className="staff-sidebar-footer"><strong>{user.name}</strong><small>{user.role}</small><button onClick={logout}>Sign out</button></div></aside><main className="staff-main"><div className="staff-topbar"><div><h1>{mode === "kitchen" ? "Kitchen command" : section === "overview" ? "Good service starts here" : section.replace("_", " ")}</h1><p>{new Date().toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Toronto" })} · Hamilton time</p></div><div className="sound-control"><span className="live-chip"><i /> Live</span>{mode === "kitchen" ? <button onClick={enableSound}>{sound ? "Sound on" : "Enable alerts"}</button> : null}</div></div>{error ? <div className="form-error" role="alert">{error}</div> : null}{unacknowledged.length ? <div className="new-order-alert">{unacknowledged.length} new order{unacknowledged.length === 1 ? "" : "s"} waiting for acknowledgement</div> : null}
    {!dashboard ? <div className="staff-panel" role="status">Loading live operations…</div> : section === "overview" ? <AdminOverview dashboard={dashboard} action={action} /> : section === "orders" ? <OrdersPanel dashboard={dashboard} action={action} kitchen={mode === "kitchen"} /> : section === "settings" ? <SettingsPanel dashboard={dashboard} onSaved={load} /> : section === "menu" ? <MenuPanel onSaved={load} /> : <TeamPanel onSaved={load} />}
  </main></div>;
}

function AdminOverview({ dashboard, action }: { dashboard: Dashboard; action: (body: Record<string, unknown>) => Promise<void> }) {
  const metrics = dashboard.metrics; const ordering = dashboard.settings.ordering?.value ?? {};
  return <><div className={ordering.paused ? "danger-banner" : "danger-banner"}><span><strong>{ordering.paused ? "Online ordering is paused" : "Online ordering is live"}</strong> · Pickup estimate {String(ordering.pickupEstimateMinutes ?? 15)} min</span><button onClick={() => action({ action: "ordering.pause", paused: !ordering.paused, reason: "Changed from operations overview" })}>{ordering.paused ? "Resume ordering" : "Pause ordering"}</button></div><section className="stats-grid"><Stat label="Sales · 24h" value={formatMoney(Number(metrics.sales_cents ?? 0))} note="Cancelled orders excluded" /><Stat label="Orders · 24h" value={String(metrics.order_count ?? 0)} note="All active channels" /><Stat label="Average order" value={formatMoney(Math.round(Number(metrics.average_cents ?? 0)))} note="Last 24 hours" /><Stat label="Team on clock" value={String(dashboard.clockedIn.length)} note="Live clock status" /></section><div className="staff-grid"><OrdersPanel dashboard={dashboard} action={action} compact /><aside className="staff-panel"><div className="staff-panel-head"><h2>Launch checklist</h2></div><div className="setup-list"><SetupItem title="Restaurant origin" text="Add the address and coordinates before enabling delivery." /><SetupItem title="Online payments" text="Connect a hosted or tokenized provider. No card data is stored here." /><SetupItem title="Delivery estimate" text="Set the default completion estimate before delivery launch." /><SetupItem title="Menu bundle details" text={`${dashboard.availabilityWarnings.count ?? 0} items still require owner confirmation or setup.`} /><SetupItem title="Notifications" text="Connect the email provider for receipts and low-rating alerts." /></div></aside></div></>;
}
function Stat({ label, value, note }: { label: string; value: string; note: string }) { return <article className="stat-card"><span>{label}</span><strong>{value}</strong><small>{note}</small></article>; }
function SetupItem({ title, text }: { title: string; text: string }) { return <div className="setup-item"><b>!</b><div><strong>{title}</strong><p>{text}</p></div></div>; }

function OrdersPanel({ dashboard, action, compact = false, kitchen = false }: { dashboard: Dashboard; action: (body: Record<string, unknown>) => Promise<void>; compact?: boolean; kitchen?: boolean }) {
  const orders = compact ? dashboard.orders.slice(0, 6) : dashboard.orders;
  return <section className="staff-panel"><div className="staff-panel-head"><h2>{kitchen ? "Active kitchen queue" : "Live orders"}</h2><span className="live-chip"><i /> {orders.length} active</span></div>{orders.length ? orders.map((order) => { const next = order.status === "received" ? "preparing" : order.status === "preparing" ? (order.fulfilment === "pickup" ? "ready_for_pickup" : "out_for_delivery") : order.status === "ready_for_pickup" || order.status === "out_for_delivery" ? "completed" : null; return <article className={`ops-order ${!order.acknowledged_at ? "unacknowledged" : ""}`} key={String(order.id)}><div className="order-ref">{String(order.order_number).replace("P62-", "#")}</div><div><h3>{String(order.customer_name)} · {String(order.fulfilment)}</h3><p>{order.schedule_type === "scheduled" ? `Scheduled ${new Date(Number(order.scheduled_for)).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })}` : `Received ${new Date(Number(order.created_at)).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })}`} · {formatMoney(Number(order.total_cents))}</p><span className="status-pill">{String(order.status).replaceAll("_", " ")}</span></div><div className="order-actions">{!order.acknowledged_at ? <button onClick={() => action({ action: "order.acknowledge", orderId: order.id })}>Acknowledge</button> : null}{next ? <button onClick={() => action({ action: "order.status", orderId: order.id, status: next })}>{next === "completed" ? "Complete" : `Move to ${String(next).replaceAll("_", " ")}`}</button> : null}</div></article>; }) : <div className="staff-empty">No active orders. The next confirmed order will appear here.</div>}</section>;
}

function SettingsPanel({ dashboard, onSaved }: { dashboard: Dashboard; onSaved: () => Promise<void> }) {
  const deliveryRecord = dashboard.settings.delivery; const orderingRecord = dashboard.settings.ordering; const taxRecord = dashboard.settings.taxAndTips;
  const [radius, setRadius] = useState(String(deliveryRecord.value.radiusKm ?? 10)); const [fee, setFee] = useState(String(Number(deliveryRecord.value.feeCents ?? 350) / 100)); const [minimum, setMinimum] = useState(String(Number(deliveryRecord.value.minimumCents ?? 0) / 100)); const [pickupEstimate, setPickupEstimate] = useState(String(orderingRecord.value.pickupEstimateMinutes ?? 15)); const [deliveryEstimate, setDeliveryEstimate] = useState(String(orderingRecord.value.deliveryEstimateMinutes ?? "")); const [tax, setTax] = useState(String(Number(taxRecord.value.taxRateBps ?? 1300) / 100)); const [status, setStatus] = useState("");
  const save = async (key: string, value: Record<string, unknown>, expectedVersion: number) => { setStatus(""); const response = await fetch("/api/admin/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "settings.update", key, value, expectedVersion, reason: "Updated in admin settings" }) }); const result = await response.json(); setStatus(response.ok ? "Settings saved and audited." : result.error); if (response.ok) await onSaved(); };
  return <div className="staff-grid"><section className="staff-panel"><div className="staff-panel-head"><h2>Delivery & ordering</h2></div><div className="settings-form"><label>Radius · km<input type="number" min="0.1" max="100" step="0.1" value={radius} onChange={(event) => setRadius(event.target.value)} /></label><label>Delivery fee · C$<input type="number" min="0" step="0.01" value={fee} onChange={(event) => setFee(event.target.value)} /></label><label>Minimum · C$<input type="number" min="0" step="0.01" value={minimum} onChange={(event) => setMinimum(event.target.value)} /></label><label>Pickup estimate · min<input type="number" min="5" max="240" value={pickupEstimate} onChange={(event) => setPickupEstimate(event.target.value)} /></label><label>Delivery estimate · min<input type="number" min="5" max="360" value={deliveryEstimate} onChange={(event) => setDeliveryEstimate(event.target.value)} placeholder="Required before launch" /></label></div><button className="staff-button" onClick={() => save("delivery", { ...deliveryRecord.value, radiusKm: Number(radius), feeCents: Math.round(Number(fee) * 100), minimumCents: Math.round(Number(minimum) * 100) }, deliveryRecord.version)}>Save delivery</button> <button className="staff-button" onClick={() => save("ordering", { ...orderingRecord.value, pickupEstimateMinutes: Number(pickupEstimate), deliveryEstimateMinutes: deliveryEstimate ? Number(deliveryEstimate) : null }, orderingRecord.version)}>Save estimates</button>{status ? <p className="staff-empty" role="status">{status}</p> : null}</section><section className="staff-panel"><div className="staff-panel-head"><h2>Tax & tip</h2></div><div className="settings-form"><label>Menu HST · %<input type="number" min="0" max="30" step="0.01" value={tax} onChange={(event) => setTax(event.target.value)} /></label><label>Delivery fee taxable<input type="text" value={taxRecord.value.deliveryFeeTaxable ? "Yes" : "No"} readOnly /></label></div><button className="staff-button" onClick={() => save("taxAndTips", { ...taxRecord.value, taxRateBps: Math.round(Number(tax) * 100) }, taxRecord.version)}>Save tax settings</button><div className="setup-list" style={{ marginTop: 20 }}><SetupItem title="Dangerous change" text="Tax and delivery updates are recorded with the acting user and previous value." /><SetupItem title="Toronto time" text="Hours and schedules use America/Toronto, including midnight closing." /></div></section></div>;
}

function MenuPanel({ onSaved }: { onSaved: () => Promise<void> }) {
  const [name, setName] = useState(""); const [label, setLabel] = useState(""); const [meat, setMeat] = useState(false); const [halal, setHalal] = useState(false); const [message, setMessage] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); const response = await fetch("/api/admin/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "topping.upsert", name, kitchenLabel: label, isMeat: meat, hasHalalVersion: halal, halalAvailable: halal, halalCostCents: 0, active: true }) }); const result = await response.json(); setMessage(response.ok ? "Topping added to the live menu." : result.error); if (response.ok) { setName(""); setLabel(""); await onSaved(); } };
  return <div className="staff-grid"><form className="staff-panel employee-form" onSubmit={submit}><div className="staff-panel-head"><h2>Add a topping</h2></div><label>Customer name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Owner-approved name" required /></label><label>Kitchen label<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Short kitchen label" required /></label><label><span><input type="checkbox" checked={meat} onChange={(event) => setMeat(event.target.checked)} /> Meat topping</span></label><label><span><input type="checkbox" checked={halal} onChange={(event) => setHalal(event.target.checked)} /> Halal version confirmed and available</span></label><button className="staff-button">Add topping</button>{message ? <p className="staff-empty" role="status">{message}</p> : null}</form><aside className="staff-panel"><div className="staff-panel-head"><h2>Why the menu starts lean</h2></div><div className="setup-list"><SetupItem title="No invented toppings" text="The specification does not confirm the final topping list, so the owner publishes it here." /><SetupItem title="Halal is explicit" text="Meat, halal display name, availability, and future cost impact are separate settings." /><SetupItem title="Server-priced" text="Every cart selection is checked against active database records before order creation." /></div></aside></div>;
}

function TeamPanel({ onSaved }: { onSaved: () => Promise<void> }) {
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [permissions, setPermissions] = useState<string[]>(["view_orders", "acknowledge_orders", "change_order_status"]); const [message, setMessage] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); const response = await fetch("/api/admin/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "staff.create", name, email, password, role: "employee", permissions }) }); const result = await response.json(); setMessage(response.ok ? "Employee access created." : result.error); if (response.ok) { setName(""); setEmail(""); setPassword(""); await onSaved(); } };
  return <div className="staff-grid"><form className="staff-panel employee-form" onSubmit={submit}><div className="staff-panel-head"><h2>Create employee access</h2></div><label>Name<input value={name} onChange={(event) => setName(event.target.value)} required /></label><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>Temporary password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} required /></label><div className="settings-form">{permissionLabels.map(([key, label]) => <label key={key}><span><input type="checkbox" checked={permissions.includes(key)} onChange={(event) => setPermissions((current) => event.target.checked ? [...current, key] : current.filter((entry) => entry !== key))} /> {label}</span></label>)}</div><button className="staff-button">Create employee</button>{message ? <p className="staff-empty" role="status">{message}</p> : null}</form><aside className="staff-panel"><div className="staff-panel-head"><h2>Permission boundaries</h2></div><div className="setup-list"><SetupItem title="Refunds are separate" text="Refund, cancellation, payroll and employee-management access are independently grantable." /><SetupItem title="No shared passwords" text="Every employee signs in with an individual email and password." /><SetupItem title="Revocation-ready" text="Disabled users no longer pass server-side session checks." /></div></aside></div>;
}

function EmployeePortal({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [data, setData] = useState<ClockData | null>(null); const [error, setError] = useState(""); const [timeOffStart, setTimeOffStart] = useState(""); const [timeOffEnd, setTimeOffEnd] = useState(""); const [note, setNote] = useState("");
  const load = useCallback(async () => { const response = await fetch("/api/timeclock"); if (response.status === 401) { onLogout(); return; } const result = await response.json(); if (!response.ok) setError(result.error); else setData(result); }, [onLogout]);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initial);
  }, [load]);
  const act = async (action: string, extra: Record<string, unknown> = {}) => { setError(""); const response = await fetch("/api/timeclock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...extra }) }); const result = await response.json(); if (!response.ok) setError(result.error); else await load(); };
  const logout = async () => { await fetch("/api/auth/logout", { method: "POST" }); onLogout(); };
  const paidHours = data ? data.paidMs / 3_600_000 : 0;
  return <div className="staff-shell"><aside className="staff-sidebar"><StaffBrand /><nav className="staff-nav"><button className="active"><span>My time</span></button><a href="/kitchen"><span>Kitchen</span></a></nav><div className="staff-sidebar-footer"><strong>{user.name}</strong><small>{user.role}</small><button onClick={logout}>Sign out</button></div></aside><main className="staff-main"><div className="staff-topbar"><div><h1>Your shift, accurately recorded</h1><p>Exact timestamps · Manual unpaid breaks · No automatic rounding</p></div><span className="live-chip"><i /> Secure session</span></div>{error ? <div className="form-error" role="alert">{error}</div> : null}{!data ? <div className="staff-panel">Loading your time record…</div> : <div className="clock-layout"><section className="clock-hero"><span className="live-chip"><i /> {data.state.replaceAll("_", " ")}</span><div className="clock-state"><strong>{data.state === "working" ? "On shift" : data.state === "on_break" ? "On break" : "Off shift"}</strong></div><div className="clock-time">{paidHours.toFixed(2)} h</div><p style={{ textAlign: "center", fontSize: 9, color: "rgba(255,255,255,.55)" }}>Paid time visible in the last 30 days</p><div className="clock-actions"><button className="primary" disabled={data.state !== "clocked_out"} onClick={() => act("clock_in")}>Clock in</button><button disabled={data.state !== "working"} onClick={() => act("break_start")}>Start break</button><button disabled={data.state !== "on_break"} onClick={() => act("break_end")}>End break</button><button disabled={data.state !== "working"} onClick={() => act("clock_out")}>Clock out</button></div></section><section className="staff-panel"><div className="staff-panel-head"><h2>Recent events</h2><span className="live-chip">Exact time</span></div><div className="clock-events">{data.events.slice(-8).reverse().map((event) => <div className="clock-event" key={event.id}><strong>{event.action.replaceAll("_", " ")}</strong><span>{new Date(event.occurred_at).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })}</span></div>)}{!data.events.length ? <div className="staff-empty">No clock events yet.</div> : null}</div></section><section className="staff-panel"><div className="staff-panel-head"><h2>Request time off</h2></div><div className="timeoff-form"><label>Starts<input type="date" value={timeOffStart} onChange={(event) => setTimeOffStart(event.target.value)} /></label><label>Ends<input type="date" value={timeOffEnd} onChange={(event) => setTimeOffEnd(event.target.value)} /></label><label>Note<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} /></label><button className="staff-button" onClick={() => act("timeoff.request", { startsAt: new Date(`${timeOffStart}T12:00:00`).getTime(), endsAt: new Date(`${timeOffEnd}T12:00:00`).getTime(), partialDay: false, note })}>Submit request</button></div></section><section className="staff-panel"><div className="staff-panel-head"><h2>Request status</h2></div><div className="setup-list">{data.timeOff.map((request) => <div className="setup-item" key={String(request.id)}><b>{String(request.status) === "approved" ? "✓" : "·"}</b><div><strong>{new Date(Number(request.starts_at)).toLocaleDateString("en-CA")} — {new Date(Number(request.ends_at)).toLocaleDateString("en-CA")}</strong><p>Status: {String(request.status)}</p></div></div>)}{!data.timeOff.length ? <div className="staff-empty">No time-off requests.</div> : null}</div></section></div>}</main></div>;
}
