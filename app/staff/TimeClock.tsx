"use client";

import { useCallback, useEffect, useState } from "react";
import { BrandLogo } from "@/app/BrandLogo";
import { formatMoney } from "@/lib/domain";

export type ClockUser = { id: string; email: string; name: string; role: string; permissions: string[] };

type TimesheetDay = { date: string; paidMs: number; breakMs: number; firstIn: number | null; lastOut: number | null; open: boolean };
type Shift = { id: string; staff_user_id: string | null; role: string | null; starts_at: number; ends_at: number; unpaid_break_minutes: number; notes: string | null; published: number };
type ClockEvent = { id: string; action: string; occurred_at: number; session_id: string; source: string };

export type EmployeeClockData = {
  user: ClockUser;
  state: "clocked_out" | "working" | "on_break";
  period: { start: number; end: number; label: string; timeZone: string; offset: number };
  profile: { jobTitle: string | null; employmentType: string; wageCents: number; weeklyOvertimeMinutes: number; hasPin: boolean; availability: Array<{ weekday: number; available: boolean; startMinute: number; endMinute: number }> };
  timesheet: { days: TimesheetDay[]; totalPaidMs: number; totalBreakMs: number; regularMs: number; overtimeMs: number; grossPayCents: number; openSession: boolean; weeks: Array<{ weekStart: string; paidMs: number; regularMs: number; overtimeMs: number }> };
  shifts: Shift[];
  events: ClockEvent[];
  corrections: Array<Record<string, unknown>>;
  timeOff: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function formatDuration(milliseconds: number) {
  const total = Math.max(0, Math.round(milliseconds / 60_000));
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, "0")}m`;
}

const clockTime = (value: number, timeZone: string) =>
  new Date(value).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone });
const dayLabel = (value: number | string, timeZone: string) =>
  new Date(typeof value === "string" ? `${value}T12:00:00Z` : value)
    .toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: typeof value === "string" ? "UTC" : timeZone });
const dateInput = (value: number) => new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const minuteToTime = (value: number) => `${String(Math.floor(value / 60) % 24).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const timeToMinute = (value: string) => { const [hour, minute] = value.split(":").map(Number); return hour * 60 + minute; };

// ─── Employee ────────────────────────────────────────────────────────────────

export function EmployeeTimeClock({ user, onLogout }: { user: ClockUser; onLogout: () => void }) {
  const [data, setData] = useState<EmployeeClockData | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"clock" | "schedule" | "timesheet" | "requests">("clock");
  const [periodOffset, setPeriodOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(async () => {
    const response = await fetch(`/api/timeclock?period=${periodOffset}`);
    if (response.status === 401) { onLogout(); return; }
    const result = await response.json();
    if (!response.ok) setError(result.error ?? "Your time record could not be loaded.");
    else { setData(result); setError(""); }
  }, [onLogout, periodOffset]);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => { setNow(Date.now()); void load(); }, 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load]);
  const act = async (action: string, body: Record<string, unknown> = {}) => {
    setError(""); setMessage("");
    const response = await fetch("/api/timeclock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, ...body }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { setError(result.error ?? "That did not work."); return false; }
    setMessage("Saved.");
    await load();
    return true;
  };
  const logout = async () => { await fetch("/api/auth/logout", { method: "POST" }); onLogout(); };
  const timeZone = data?.period.timeZone ?? "America/Toronto";
  // The paid total already includes any shift in progress — the server measures an
  // open session up to now — so the screen matches the clock on the wall.
  const todayShift = data?.shifts.find((shift) => shift.starts_at < now + 12 * 3_600_000 && shift.ends_at > now - 3_600_000);

  return <div className="staff-shell">
    <aside className="staff-sidebar">
      <div className="staff-brand"><BrandLogo name="Pizza 62" chip /><small>Time clock</small></div>
      <nav className="staff-nav" aria-label="Time clock sections">
        <button className={tab === "clock" ? "active" : ""} onClick={() => setTab("clock")}><span>Clock</span></button>
        <button className={tab === "schedule" ? "active" : ""} onClick={() => setTab("schedule")}><span>My schedule</span></button>
        <button className={tab === "timesheet" ? "active" : ""} onClick={() => setTab("timesheet")}><span>My hours</span></button>
        <button className={tab === "requests" ? "active" : ""} onClick={() => setTab("requests")}><span>Requests</span></button>
        <a href="/kiosk"><span>Kiosk mode</span></a>
        <a href="/kitchen"><span>Kitchen</span></a>
      </nav>
      <div className="staff-sidebar-footer"><strong>{user.name}</strong><small>{data?.profile.jobTitle ?? user.role}</small><button onClick={logout}>Sign out</button></div>
    </aside>
    <main className="staff-main">
      <div className="staff-topbar">
        <div><h1>{tab === "clock" ? "Your shift" : tab === "schedule" ? "Your schedule" : tab === "timesheet" ? "Your hours" : "Your requests"}</h1>
          <p>Exact timestamps · Unpaid breaks subtracted · No automatic rounding</p></div>
        <span className="live-chip"><i /> {data ? data.state.replaceAll("_", " ") : "Loading"}</span>
      </div>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
      {message ? <p className="admin-message" role="status">{message}</p> : null}
      {!data ? <div className="staff-panel" role="status">Loading your time record…</div> : <>
        {tab === "clock" ? <div className="clock-layout">
          <section className="clock-hero">
            <span className="live-chip"><i /> {data.state.replaceAll("_", " ")}</span>
            <div className="clock-state"><strong>{data.state === "working" ? "On shift" : data.state === "on_break" ? "On break" : "Off shift"}</strong></div>
            <div className="clock-time">{formatDuration(data.timesheet.totalPaidMs)}</div>
            <p className="clock-caption">Paid time this {data.period.label} pay period</p>
            <div className="clock-actions">
              <button className="primary" disabled={data.state !== "clocked_out"} onClick={() => void act("clock_in")}>Clock in</button>
              <button disabled={data.state !== "working"} onClick={() => void act("break_start")}>Start break</button>
              <button disabled={data.state !== "on_break"} onClick={() => void act("break_end")}>End break</button>
              <button disabled={data.state !== "working"} onClick={() => void act("clock_out")}>Clock out</button>
            </div>
            {todayShift ? <p className="clock-caption">Scheduled {clockTime(todayShift.starts_at, timeZone)} – {clockTime(todayShift.ends_at, timeZone)}{todayShift.role ? ` · ${todayShift.role}` : ""}</p> : null}
          </section>
          <section className="staff-panel">
            <div className="staff-panel-head"><h2>This pay period</h2><span className="live-chip">{dayLabel(data.period.start, timeZone)} – {dayLabel(data.period.end - 1, timeZone)}</span></div>
            <dl className="viz-facts">
              <div><dt>Paid hours</dt><dd>{formatDuration(data.timesheet.totalPaidMs)}</dd></div>
              <div><dt>Regular</dt><dd>{formatDuration(data.timesheet.regularMs)}</dd></div>
              <div><dt>Overtime</dt><dd>{formatDuration(data.timesheet.overtimeMs)}</dd></div>
              <div><dt>Unpaid breaks</dt><dd>{formatDuration(data.timesheet.totalBreakMs)}</dd></div>
              {data.profile.wageCents ? <div><dt>Estimated gross</dt><dd>{formatMoney(data.timesheet.grossPayCents)}</dd></div> : null}
            </dl>
            {data.timesheet.overtimeMs > 0 ? <p className="editor-hint">Overtime starts after {Math.round(data.profile.weeklyOvertimeMinutes / 60)} hours in a week.</p> : null}
          </section>
          <section className="staff-panel">
            <div className="staff-panel-head"><h2>Recent punches</h2><span className="live-chip">Exact time</span></div>
            <div className="clock-events">
              {data.events.slice(-8).reverse().map((event) => <div className="clock-event" key={event.id}>
                <strong>{event.action.replaceAll("_", " ")}{event.source === "manager" ? " · edited" : event.source === "kiosk" ? " · kiosk" : ""}</strong>
                <span>{new Date(event.occurred_at).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })}</span>
              </div>)}
              {!data.events.length ? <div className="staff-empty">No clock events yet.</div> : null}
            </div>
          </section>
        </div> : null}

        {tab === "schedule" ? <>
          <section className="staff-panel">
            <div className="staff-panel-head"><h2>Published shifts</h2><span className="live-chip">Next two weeks</span></div>
            <div className="shift-list">
              {data.shifts.map((shift) => <div className="shift-row" key={shift.id}>
                <strong>{dayLabel(shift.starts_at, timeZone)}</strong>
                <span>{clockTime(shift.starts_at, timeZone)} – {clockTime(shift.ends_at, timeZone)}</span>
                <span>{shift.role ?? "Shift"}{shift.unpaid_break_minutes ? ` · ${shift.unpaid_break_minutes} min unpaid break` : ""}</span>
                <small>{shift.notes ?? ""}</small>
              </div>)}
              {!data.shifts.length ? <div className="staff-empty">Nothing published yet. Your manager releases the schedule when it is ready.</div> : null}
            </div>
          </section>
          <AvailabilityEditor availability={data.profile.availability} onSave={(availability) => act("availability.update", { availability })} />
        </> : null}

        {tab === "timesheet" ? <section className="staff-panel">
          <div className="staff-panel-head"><h2>Day by day</h2>
            <div className="period-switch">
              <button className="text-button" onClick={() => setPeriodOffset((value) => value - 1)}>← Earlier</button>
              <span>{dayLabel(data.period.start, timeZone)} – {dayLabel(data.period.end - 1, timeZone)}</span>
              <button className="text-button" disabled={periodOffset === 0} onClick={() => setPeriodOffset((value) => Math.min(0, value + 1))}>Later →</button>
            </div>
          </div>
          <table className="viz-table">
            <thead><tr><th scope="col">Day</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Break</th><th scope="col">Paid</th></tr></thead>
            <tbody>
              {data.timesheet.days.map((day) => <tr key={day.date}>
                <th scope="row">{dayLabel(day.date, timeZone)}</th>
                <td>{day.firstIn ? clockTime(day.firstIn, timeZone) : "—"}</td>
                <td>{day.open ? "on shift" : day.lastOut ? clockTime(day.lastOut, timeZone) : "—"}</td>
                <td>{formatDuration(day.breakMs)}</td>
                <td>{formatDuration(day.paidMs)}</td>
              </tr>)}
              {!data.timesheet.days.length ? <tr><td colSpan={5} className="staff-empty">No hours recorded in this period.</td></tr> : null}
            </tbody>
          </table>
          {data.approvals.length ? <p className="editor-hint">Approved periods: {data.approvals.map((row) => new Date(Number(row.period_start)).toLocaleDateString("en-CA")).join(", ")}</p> : null}
        </section> : null}

        {tab === "requests" ? <RequestsPanel data={data} timeZone={timeZone} onAct={act} /> : null}
      </>}
    </main>
  </div>;
}

function AvailabilityEditor({ availability, onSave }: { availability: EmployeeClockData["profile"]["availability"]; onSave: (rows: unknown[]) => Promise<boolean> }) {
  const initial = WEEKDAYS.map((_, weekday) => {
    const row = availability.find((entry) => entry.weekday === weekday);
    return { weekday, available: row?.available ?? true, startMinute: row?.startMinute ?? 660, endMinute: row?.endMinute ?? 1320 };
  });
  const [rows, setRows] = useState(initial);
  return <section className="staff-panel">
    <div className="staff-panel-head"><h2>When you can work</h2><button className="staff-button" onClick={() => void onSave(rows)}>Save availability</button></div>
    <div className="hours-admin">
      {rows.map((row, index) => <div key={row.weekday}>
        <strong>{WEEKDAYS[row.weekday]}</strong>
        <label className="admin-check"><input type="checkbox" checked={row.available} onChange={(event) => setRows((current) => current.map((entry, position) => position === index ? { ...entry, available: event.target.checked } : entry))} /><span>Available</span></label>
        <input type="time" aria-label={`${WEEKDAYS[row.weekday]} from`} value={minuteToTime(row.startMinute)} disabled={!row.available} onChange={(event) => setRows((current) => current.map((entry, position) => position === index ? { ...entry, startMinute: timeToMinute(event.target.value) } : entry))} />
        <span>to</span>
        <input type="time" aria-label={`${WEEKDAYS[row.weekday]} to`} value={minuteToTime(row.endMinute)} disabled={!row.available} onChange={(event) => setRows((current) => current.map((entry, position) => position === index ? { ...entry, endMinute: timeToMinute(event.target.value) } : entry))} />
      </div>)}
    </div>
  </section>;
}

function RequestsPanel({ data, timeZone, onAct }: { data: EmployeeClockData; timeZone: string; onAct: (action: string, body?: Record<string, unknown>) => Promise<boolean> }) {
  const [eventId, setEventId] = useState("");
  const [correctedTime, setCorrectedTime] = useState("");
  const [reason, setReason] = useState("");
  const [timeOffStart, setTimeOffStart] = useState("");
  const [timeOffEnd, setTimeOffEnd] = useState("");
  const [note, setNote] = useState("");
  return <div className="staff-grid">
    <section className="staff-panel">
      <div className="staff-panel-head"><h2>Fix a punch</h2></div>
      <div className="settings-form">
        <label>Which punch<select value={eventId} onChange={(event) => { setEventId(event.target.value); const match = data.events.find((entry) => entry.id === event.target.value); if (match) setCorrectedTime(dateInput(match.occurred_at)); }}>
          <option value="">Choose a punch…</option>
          {[...data.events].reverse().map((event) => <option key={event.id} value={event.id}>{event.action.replaceAll("_", " ")} · {new Date(event.occurred_at).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })}</option>)}
        </select></label>
        <label>Correct time<input type="datetime-local" value={correctedTime} onChange={(event) => setCorrectedTime(event.target.value)} /></label>
        <label className="field-wide">Why<textarea value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="I forgot to clock out at the end of my shift." /></label>
      </div>
      <button className="staff-button" disabled={!eventId || !correctedTime || reason.trim().length < 5} onClick={() => void onAct("correction.request", { eventId, requestedTime: new Date(correctedTime).getTime(), reason })}>Send to your manager</button>
      <div className="setup-list">
        {data.corrections.map((row) => <div className="setup-item" key={String(row.id)}><b>{String(row.status) === "approved" ? "✓" : String(row.status) === "declined" ? "×" : "·"}</b><div><strong>{new Date(Number(row.requested_time)).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })}</strong><p>{String(row.status)}{row.reviewer_note ? ` — ${String(row.reviewer_note)}` : ""}</p></div></div>)}
      </div>
    </section>
    <section className="staff-panel">
      <div className="staff-panel-head"><h2>Time off</h2></div>
      <div className="timeoff-form">
        <label>From<input type="date" value={timeOffStart} onChange={(event) => setTimeOffStart(event.target.value)} /></label>
        <label>To<input type="date" value={timeOffEnd} onChange={(event) => setTimeOffEnd(event.target.value)} /></label>
        <label>Note<textarea value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label>
        <button className="staff-button" disabled={!timeOffStart || !timeOffEnd} onClick={() => void onAct("timeoff.request", { startsAt: new Date(`${timeOffStart}T12:00:00`).getTime(), endsAt: new Date(`${timeOffEnd}T12:00:00`).getTime(), partialDay: false, note })}>Request time off</button>
      </div>
      <div className="setup-list">
        {data.timeOff.map((row) => <div className="setup-item" key={String(row.id)}><b>{String(row.status) === "approved" ? "✓" : String(row.status) === "declined" ? "×" : "·"}</b><div><strong>{new Date(Number(row.starts_at)).toLocaleDateString("en-CA")} — {new Date(Number(row.ends_at)).toLocaleDateString("en-CA")}</strong><p>{String(row.status)}{row.reviewer_note ? ` — ${String(row.reviewer_note)}` : ""}</p></div></div>)}
        {!data.timeOff.length ? <div className="staff-empty">No time-off requests.</div> : null}
      </div>
    </section>
  </div>;
}

// ─── Kiosk ───────────────────────────────────────────────────────────────────

const KIOSK_ACTIONS = [
  ["clock_in", "Clock in"],
  ["break_start", "Start break"],
  ["break_end", "End break"],
  ["clock_out", "Clock out"],
] as const;

/**
 * A shared tablet at the store: pick your name, PIN in, one punch. No session
 * and no data shown.
 *
 * C-09: the name step is not cosmetic. Sending a bare PIN made the server derive
 * PBKDF2 against every staff profile until one matched, and let two people with
 * the same PIN punch each other's cards. Naming the employee first makes it one
 * derivation against one row.
 */
export function TimeClockKiosk() {
  const [employees, setEmployees] = useState<{ id: string; name: string }[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [clock, setClock] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/timeclock/kiosk");
        const payload = (await response.json()) as { employees?: { id: string; name: string }[]; error?: string };
        if (cancelled) return;
        if (!response.ok) setRosterError(payload.error ?? "The staff list could not be loaded.");
        else setEmployees(payload.employees ?? []);
      } catch {
        if (!cancelled) setRosterError("The staff list could not be loaded.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => setResult(null), 6000);
    return () => window.clearTimeout(timer);
  }, [result]);

  // Never leave someone else's name selected on a shared tablet: clearing on
  // success means the next person cannot punch into the previous one's card by
  // walking up and typing their own PIN.
  const reset = () => {
    setPin("");
    setSelected(null);
  };

  const punch = async (action: string) => {
    if (!selected) return;
    setBusy(true);
    try {
      const response = await fetch("/api/timeclock/kiosk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ staffUserId: selected.id, pin, action }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setResult({ tone: "error", text: payload.error ?? "That did not work." });
        setPin("");
      } else {
        setResult({
          tone: "ok",
          text: `${payload.name} — ${String(payload.state).replaceAll("_", " ")} at ${new Date(payload.occurredAt).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`,
        });
        reset();
      }
    } finally {
      setBusy(false);
    }
  };

  return <div className="kiosk-shell">
    <div className="kiosk-card">
      <BrandLogo name="Pizza 62" />
      <div className="kiosk-clock">{clock.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}</div>
      <p className="kiosk-date">{clock.toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" })}</p>

      {selected === null ? <>
        <div className="kiosk-roster" aria-label="Choose your name">
          {employees.map((employee) => <button key={employee.id} onClick={() => setSelected(employee)}>{employee.name}</button>)}
        </div>
        {rosterError
          ? <p className="kiosk-result kiosk-result--error" role="status">{rosterError}</p>
          : employees.length === 0
            ? <p className="kiosk-hint">No one has a clock-in PIN yet. A manager can set one from the staff portal.</p>
            : <p className="kiosk-hint">Tap your name to start.</p>}
      </> : <>
        <p className="kiosk-selected">{selected.name}</p>
        <div className="kiosk-pin" aria-label="PIN entry">{[0, 1, 2, 3, 4, 5, 6, 7].map((slot) => <i key={slot} className={slot < pin.length ? "filled" : ""} aria-hidden="true" />)}</div>
        <div className="kiosk-keypad">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((key) => <button key={key} onClick={() => setPin((value) => (value + key).slice(0, 8))}>{key}</button>)}
          <button onClick={() => setPin("")}>Clear</button>
          <button onClick={() => setPin((value) => (value + "0").slice(0, 8))}>0</button>
          <button onClick={() => setPin((value) => value.slice(0, -1))}>←</button>
        </div>
        <div className="kiosk-actions">
          {KIOSK_ACTIONS.map(([action, label]) => <button key={action} disabled={busy || pin.length < 4} onClick={() => void punch(action)}>{label}</button>)}
        </div>
        <button className="text-button" onClick={reset}>Not {selected.name}?</button>
      </>}

      {result ? <p className={result.tone === "ok" ? "kiosk-result" : "kiosk-result kiosk-result--error"} role="status">{result.text}</p> : null}
      <a className="text-button" href="/employee">Sign in instead</a>
    </div>
  </div>;
}
