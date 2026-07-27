"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/lib/domain";
import { formatDuration } from "@/app/staff/TimeClock";

type TeamRow = {
  id: string; name: string; email: string; role: string; active: number;
  jobTitle: string | null; employmentType: string; wageCents: number;
  weeklyOvertimeMinutes: number; overtimeMultiplierBps: number; hasPin: boolean;
};
type TimesheetRow = {
  staffUserId: string; name: string; totalPaidMs: number; totalBreakMs: number;
  regularMs: number; overtimeMs: number; grossPayCents: number; openSession: boolean; approved: boolean;
  days: Array<{ date: string; paidMs: number; breakMs: number; firstIn: number | null; lastOut: number | null; open: boolean }>;
};
// A new shift always opens with a start and end already chosen, so the dialog
// never has to invent "now" while rendering.
type ShiftDraft = Omit<Partial<ShiftRow>, "starts_at" | "ends_at"> & { starts_at: number; ends_at: number };
type ShiftRow = { id: string; staff_user_id: string | null; role: string | null; starts_at: number; ends_at: number; unpaid_break_minutes: number; notes: string | null; published: number };

type ManagerData = {
  period: { start: number; end: number; label: string; timeZone: string; offset: number };
  week: { from: number; to: number };
  team: TeamRow[];
  timesheets: TimesheetRow[];
  shifts: ShiftRow[];
  onClock: Array<Record<string, unknown>>;
  corrections: Array<Record<string, unknown>>;
  timeOff: Array<Record<string, unknown>>;
};

const DAY_MS = 86_400_000;
const localDayStart = (value: number) => { const date = new Date(value); date.setHours(0, 0, 0, 0); return date.getTime(); };
const dateTimeInput = (value: number) => new Date(value - new Date(value).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function ManagerTimeClock() {
  const [data, setData] = useState<ManagerData | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState<"today" | "schedule" | "timesheets" | "requests" | "pay">("today");
  const [periodOffset, setPeriodOffset] = useState(0);
  const [weekFrom, setWeekFrom] = useState(() => localDayStart(Date.now()) - ((new Date().getDay() + 7) % 7) * DAY_MS);
  const load = useCallback(async () => {
    const response = await fetch(`/api/timeclock/manager?period=${periodOffset}&weekFrom=${weekFrom}`);
    const result = await response.json();
    if (!response.ok) { setError(result.error ?? "Time records could not be loaded."); return; }
    setData(result); setError("");
  }, [periodOffset, weekFrom]);
  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 60_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load]);
  const act = async (body: Record<string, unknown>, success: string) => {
    setError(""); setMessage("");
    const response = await fetch("/api/timeclock/manager", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { setError(result.error ?? "That did not work."); return false; }
    setMessage(success);
    await load();
    return true;
  };
  const exportPayroll = async () => {
    const response = await fetch("/api/timeclock/manager", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ periodOffset }) });
    if (!response.ok) { setError("Payroll could not be exported."); return; }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pizza62-payroll-${new Date(data?.period.start ?? Date.now()).toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (error && !data) return <div className="staff-panel"><div className="form-error" role="alert">{error}</div></div>;
  if (!data) return <div className="staff-panel" role="status">Loading team time records…</div>;
  const timeZone = data.period.timeZone;
  const pendingCorrections = data.corrections.filter((row) => row.status === "pending");
  const pendingTimeOff = data.timeOff.filter((row) => row.status === "pending");
  const labourCents = data.timesheets.reduce((sum, row) => sum + row.grossPayCents, 0);
  const overtimeRows = data.timesheets.filter((row) => row.overtimeMs > 0);

  return <div className="admin-stack">
    <div className="viz-toolbar">
      <div className="segmented-range" role="group" aria-label="Time clock sections">
        {([["today", "On now"], ["schedule", "Schedule"], ["timesheets", "Timesheets"], ["requests", `Requests${pendingCorrections.length + pendingTimeOff.length ? ` (${pendingCorrections.length + pendingTimeOff.length})` : ""}`], ["pay", "Pay & PINs"]] as const)
          .map(([key, label]) => <button key={key} className={tab === key ? "active" : ""} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}
      </div>
      <span className="live-chip"><i /> {data.onClock.length} on the clock</span>
    </div>
    {error ? <div className="form-error" role="alert">{error}</div> : null}
    {message ? <p className="admin-message" role="status">{message}</p> : null}

    {tab === "today" ? <>
      <section className="stats-grid">
        <article className="stat-card"><span>On the clock</span><strong className="viz-figure">{data.onClock.length}</strong><small>Right now</small></article>
        <article className="stat-card"><span>Hours this period</span><strong className="viz-figure">{formatDuration(data.timesheets.reduce((sum, row) => sum + row.totalPaidMs, 0))}</strong><small>{data.period.label}</small></article>
        <article className="stat-card"><span>Overtime</span><strong className="viz-figure">{formatDuration(data.timesheets.reduce((sum, row) => sum + row.overtimeMs, 0))}</strong><small>{overtimeRows.length} people</small></article>
        <article className="stat-card"><span>Labour cost</span><strong className="viz-figure">{formatMoney(labourCents)}</strong><small>Estimated gross</small></article>
      </section>
      <section className="staff-panel">
        <div className="staff-panel-head"><h2>Who is on</h2><span className="live-chip">Live</span></div>
        <div className="shift-list">
          {data.onClock.map((row) => <div className="shift-row" key={String(row.id)}>
            <strong>{String(row.name)}</strong>
            <span>{String(row.state).replaceAll("_", " ")}</span>
            <span>since {new Date(Number(row.updated_at)).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone })}</span>
            <button className="text-button" onClick={() => void act({ action: "punch.for", staffUserId: row.id, punch: row.state === "on_break" ? "break_end" : "clock_out" }, "Clock updated.")}>{row.state === "on_break" ? "End break" : "Clock out"}</button>
          </div>)}
          {!data.onClock.length ? <div className="staff-empty">Nobody is clocked in.</div> : null}
        </div>
      </section>
      {overtimeRows.length ? <section className="staff-panel">
        <div className="staff-panel-head"><h2>Approaching or in overtime</h2></div>
        <div className="shift-list">{overtimeRows.map((row) => <div className="shift-row" key={row.staffUserId}><strong>{row.name}</strong><span>{formatDuration(row.totalPaidMs)} worked</span><span>{formatDuration(row.overtimeMs)} overtime</span><small>Paid at time and a half</small></div>)}</div>
      </section> : null}
    </> : null}

    {tab === "schedule" ? <ScheduleBoard data={data} weekFrom={weekFrom} onWeek={setWeekFrom} onAct={act} /> : null}

    {tab === "timesheets" ? <section className="staff-panel">
      <div className="staff-panel-head"><h2>Timesheets</h2>
        <div className="period-switch">
          <button className="text-button" onClick={() => setPeriodOffset((value) => value - 1)}>← Earlier</button>
          <span>{new Date(data.period.start).toLocaleDateString("en-CA")} – {new Date(data.period.end - 1).toLocaleDateString("en-CA")}</span>
          <button className="text-button" disabled={periodOffset === 0} onClick={() => setPeriodOffset((value) => Math.min(0, value + 1))}>Later →</button>
        </div>
      </div>
      {data.timesheets.map((row) => <details className="product-admin-card" key={row.staffUserId}>
        <summary><span><strong>{row.name}</strong><small>{formatDuration(row.totalPaidMs)} paid · {formatDuration(row.overtimeMs)} overtime · {formatMoney(row.grossPayCents)}</small></span><span>{row.approved ? "Approved" : row.openSession ? "Shift open" : "Ready"}</span></summary>
        <div className="product-editor">
          <table className="viz-table">
            <thead><tr><th scope="col">Day</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Break</th><th scope="col">Paid</th></tr></thead>
            <tbody>{row.days.map((day) => <tr key={day.date}>
              <th scope="row">{day.date}</th>
              <td>{day.firstIn ? new Date(day.firstIn).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone }) : "—"}</td>
              <td>{day.open ? "on shift" : day.lastOut ? new Date(day.lastOut).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone }) : "—"}</td>
              <td>{formatDuration(day.breakMs)}</td>
              <td>{formatDuration(day.paidMs)}</td>
            </tr>)}
            {!row.days.length ? <tr><td colSpan={5} className="staff-empty">No hours in this period.</td></tr> : null}</tbody>
          </table>
          <ManualPunch staffUserId={row.staffUserId} onAct={act} />
          <button className="staff-button" disabled={row.openSession} onClick={() => void act({ action: "timesheet.approve", staffUserId: row.staffUserId, periodOffset }, `${row.name}'s timesheet approved.`)}>{row.approved ? "Re-approve timesheet" : "Approve timesheet"}</button>
        </div>
      </details>)}
    </section> : null}

    {tab === "requests" ? <div className="staff-grid">
      <section className="staff-panel">
        <div className="staff-panel-head"><h2>Punch corrections</h2><span className="live-chip">{pendingCorrections.length} waiting</span></div>
        <div className="setup-list">
          {data.corrections.map((row) => <div className="setup-item" key={String(row.id)}>
            <b>{row.status === "pending" ? "!" : row.status === "approved" ? "✓" : "×"}</b>
            <div>
              <strong>{String(row.staff_name)} · {String(row.action ?? "punch").replaceAll("_", " ")}</strong>
              <p>{row.occurred_at ? `${new Date(Number(row.occurred_at)).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })} → ` : ""}
                {new Date(Number(row.requested_time)).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })} — {String(row.reason)}</p>
              {row.status === "pending" ? <div className="order-actions">
                <button onClick={() => void act({ action: "correction.resolve", id: row.id, approve: true }, "Punch corrected.")}>Approve &amp; move the punch</button>
                <button className="secondary" onClick={() => void act({ action: "correction.resolve", id: row.id, approve: false }, "Request declined.")}>Decline</button>
              </div> : <p>{String(row.status)}</p>}
            </div>
          </div>)}
          {!data.corrections.length ? <div className="staff-empty">No correction requests.</div> : null}
        </div>
      </section>
      <section className="staff-panel">
        <div className="staff-panel-head"><h2>Time off</h2><span className="live-chip">{pendingTimeOff.length} waiting</span></div>
        <div className="setup-list">
          {data.timeOff.map((row) => <div className="setup-item" key={String(row.id)}>
            <b>{row.status === "pending" ? "!" : row.status === "approved" ? "✓" : "×"}</b>
            <div>
              <strong>{String(row.staff_name)}</strong>
              <p>{new Date(Number(row.starts_at)).toLocaleDateString("en-CA")} — {new Date(Number(row.ends_at)).toLocaleDateString("en-CA")}{row.note ? ` · ${String(row.note)}` : ""}</p>
              {row.status === "pending" ? <div className="order-actions">
                <button onClick={() => void act({ action: "timeoff.resolve", id: row.id, approve: true }, "Time off approved.")}>Approve</button>
                <button className="secondary" onClick={() => void act({ action: "timeoff.resolve", id: row.id, approve: false }, "Request declined.")}>Decline</button>
              </div> : <p>{String(row.status)}</p>}
            </div>
          </div>)}
          {!data.timeOff.length ? <div className="staff-empty">No time-off requests.</div> : null}
        </div>
      </section>
    </div> : null}

    {tab === "pay" ? <section className="staff-panel">
      <div className="staff-panel-head"><h2>Pay, roles and clock-in PINs</h2><button className="staff-button" onClick={() => void exportPayroll()}>Export payroll CSV</button></div>
      <p className="editor-hint">Overtime follows Ontario&apos;s 44-hour work week by default. A PIN lets someone clock in on the shared tablet at /kiosk without signing in.</p>
      {data.team.filter((member) => member.active).map((member) => <PayEditor key={member.id} member={member} onAct={act} />)}
    </section> : null}
  </div>;
}

function ManualPunch({ staffUserId, onAct }: { staffUserId: string; onAct: (body: Record<string, unknown>, success: string) => Promise<boolean> }) {
  const [punch, setPunch] = useState("clock_in");
  const [when, setWhen] = useState(() => dateTimeInput(Date.now()));
  return <div className="manual-punch">
    <strong>Add a missing punch</strong>
    <select value={punch} onChange={(event) => setPunch(event.target.value)} aria-label="Punch type">
      <option value="clock_in">Clock in</option><option value="break_start">Break start</option>
      <option value="break_end">Break end</option><option value="clock_out">Clock out</option>
    </select>
    <input type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} aria-label="Punch time" />
    <button className="staff-button" onClick={() => void onAct({ action: "event.insert", staffUserId, punch, occurredAt: new Date(when).getTime() }, "Punch added and recorded in the audit log.")}>Add punch</button>
  </div>;
}

function PayEditor({ member, onAct }: { member: TeamRow; onAct: (body: Record<string, unknown>, success: string) => Promise<boolean> }) {
  const [jobTitle, setJobTitle] = useState(member.jobTitle ?? "");
  const [wage, setWage] = useState((member.wageCents / 100).toFixed(2));
  const [overtimeHours, setOvertimeHours] = useState(String(Math.round(member.weeklyOvertimeMinutes / 60)));
  const [employmentType, setEmploymentType] = useState(member.employmentType);
  const [pin, setPin] = useState("");
  return <details className="product-admin-card compact">
    <summary><span><strong>{member.name}</strong><small>{member.jobTitle ?? member.role} · {member.wageCents ? `${formatMoney(member.wageCents)}/h` : "no wage set"}{member.hasPin ? " · PIN set" : ""}</small></span><span>{member.role}</span></summary>
    <div className="product-editor">
      <div className="settings-form">
        <label>Job title<input value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} /></label>
        <label>Hourly rate · C$<input type="number" step="0.01" min="0" value={wage} onChange={(event) => setWage(event.target.value)} /></label>
        <label>Overtime after · hours a week<input type="number" min="0" max="168" value={overtimeHours} onChange={(event) => setOvertimeHours(event.target.value)} /></label>
        <label>Paid as<select value={employmentType} onChange={(event) => setEmploymentType(event.target.value)}><option value="hourly">Hourly</option><option value="salary">Salary</option></select></label>
      </div>
      <button className="staff-button" onClick={() => void onAct({ action: "profile.update", staffUserId: member.id, jobTitle, wageCents: Math.round(Number(wage) * 100), weeklyOvertimeMinutes: Number(overtimeHours) * 60, employmentType }, `${member.name}'s pay settings saved.`)}>Save pay settings</button>
      <div className="manual-punch">
        <strong>Clock-in PIN</strong>
        <input value={pin} inputMode="numeric" maxLength={8} placeholder="4–8 digits" onChange={(event) => setPin(event.target.value.replace(/[^0-9]/g, ""))} aria-label={`${member.name} PIN`} />
        <button className="staff-button" disabled={pin.length < 4} onClick={() => { void onAct({ action: "pin.set", staffUserId: member.id, pin }, `PIN set for ${member.name}.`); setPin(""); }}>Set PIN</button>
        {member.hasPin ? <button className="text-button danger-text" onClick={() => void onAct({ action: "pin.set", staffUserId: member.id, pin: "" }, `PIN removed for ${member.name}.`)}>Remove PIN</button> : null}
      </div>
    </div>
  </details>;
}

function ScheduleBoard({ data, weekFrom, onWeek, onAct }: { data: ManagerData; weekFrom: number; onWeek: (value: number) => void; onAct: (body: Record<string, unknown>, success: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState<ShiftDraft | null>(null);
  const days = Array.from({ length: 7 }, (_, index) => weekFrom + index * DAY_MS);
  const weekTo = weekFrom + 7 * DAY_MS;
  const inWeek = data.shifts.filter((shift) => shift.starts_at >= weekFrom && shift.starts_at < weekTo);
  const unpublished = inWeek.filter((shift) => !shift.published).length;
  const timeZone = data.period.timeZone;
  const hoursFor = (staffId: string) => inWeek
    .filter((shift) => shift.staff_user_id === staffId)
    .reduce((sum, shift) => sum + (shift.ends_at - shift.starts_at - shift.unpaid_break_minutes * 60_000), 0);
  return <>
    <section className="staff-panel">
      <div className="staff-panel-head">
        <h2>Week of {new Date(weekFrom).toLocaleDateString("en-CA", { month: "long", day: "numeric" })}</h2>
        <div className="period-switch">
          <button className="text-button" onClick={() => onWeek(weekFrom - 7 * DAY_MS)}>← Previous</button>
          <button className="text-button" onClick={() => onWeek(weekFrom + 7 * DAY_MS)}>Next →</button>
          <button className="staff-button" disabled={!unpublished} onClick={() => void onAct({ action: "schedule.publish", from: weekFrom, to: weekTo }, "Schedule published to the team.")}>{unpublished ? `Publish ${unpublished} shift${unpublished === 1 ? "" : "s"}` : "All published"}</button>
        </div>
      </div>
      <div className="schedule-grid">
        <div className="schedule-head"><span>Team</span>{days.map((day) => <span key={day}>{new Date(day).toLocaleDateString("en-CA", { weekday: "short", day: "numeric" })}</span>)}</div>
        {data.team.filter((member) => member.active).map((member) => <div className="schedule-row" key={member.id}>
          <span className="schedule-person"><strong>{member.name}</strong><small>{formatDuration(hoursFor(member.id))} scheduled</small></span>
          {days.map((day) => {
            const cellShifts = inWeek.filter((shift) => shift.staff_user_id === member.id && shift.starts_at >= day && shift.starts_at < day + DAY_MS);
            return <button className="schedule-cell" key={day} onClick={() => setEditing({ staff_user_id: member.id, starts_at: day + 16 * 3_600_000, ends_at: day + 22 * 3_600_000, unpaid_break_minutes: 30 })}>
              {cellShifts.map((shift) => <span key={shift.id} className={shift.published ? "shift-chip" : "shift-chip shift-chip--draft"} onClick={(event) => { event.stopPropagation(); setEditing(shift); }}>
                {new Date(shift.starts_at).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone })}–{new Date(shift.ends_at).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit", timeZone })}
                {shift.role ? <small>{shift.role}</small> : null}
              </span>)}
              {!cellShifts.length ? <i aria-hidden="true">+</i> : null}
            </button>;
          })}
        </div>)}
      </div>
      <p className="editor-hint">Click a day to add a shift, or a shift to change it. Draft shifts are outlined; the team only sees a shift after you publish.</p>
    </section>
    {editing ? <ShiftDialog shift={editing} team={data.team} onClose={() => setEditing(null)} onAct={async (body, success) => { const ok = await onAct(body, success); if (ok) setEditing(null); return ok; }} /> : null}
  </>;
}

function ShiftDialog({ shift, team, onClose, onAct }: { shift: ShiftDraft; team: TeamRow[]; onClose: () => void; onAct: (body: Record<string, unknown>, success: string) => Promise<boolean> }) {
  const [staffUserId, setStaffUserId] = useState(shift.staff_user_id ?? "");
  const [startsAt, setStartsAt] = useState(dateTimeInput(shift.starts_at));
  const [endsAt, setEndsAt] = useState(dateTimeInput(shift.ends_at));
  const [role, setRole] = useState(shift.role ?? "");
  const [breakMinutes, setBreakMinutes] = useState(String(shift.unpaid_break_minutes ?? 30));
  const [notes, setNotes] = useState(shift.notes ?? "");
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <div className="staff-panel shift-dialog" role="dialog" aria-modal="true" aria-labelledby="shift-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="staff-panel-head"><h2 id="shift-title">{shift.id ? "Change shift" : "Add shift"}</h2><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div>
      <div className="settings-form">
        <label>Who<select value={staffUserId} onChange={(event) => setStaffUserId(event.target.value)}><option value="">Open shift</option>{team.filter((member) => member.active).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <label>Role<input value={role} onChange={(event) => setRole(event.target.value)} placeholder="Kitchen, driver, counter" /></label>
        <label>Starts<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label>
        <label>Ends<input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} /></label>
        <label>Unpaid break · minutes<input type="number" min="0" max="240" value={breakMinutes} onChange={(event) => setBreakMinutes(event.target.value)} /></label>
        <label className="field-wide">Notes<input value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      </div>
      <div className="order-actions">
        <button onClick={() => void onAct({ action: "shift.upsert", id: shift.id, staffUserId: staffUserId || null, role, startsAt: new Date(startsAt).getTime(), endsAt: new Date(endsAt).getTime(), unpaidBreakMinutes: Number(breakMinutes), notes }, "Shift saved as a draft.")}>Save shift</button>
        {shift.id ? <button className="secondary" onClick={() => void onAct({ action: "shift.delete", id: shift.id }, "Shift removed.")}>Delete</button> : null}
      </div>
    </div>
  </div>;
}
