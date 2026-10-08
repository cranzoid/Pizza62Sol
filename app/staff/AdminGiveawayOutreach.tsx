"use client";

import { useEffect, useState } from "react";
import { NUDGES, type NudgeKind } from "@/lib/giveaway";
import { formatMoney } from "@/lib/domain";
import { when, type Act, type Overview } from "@/app/staff/AdminGiveaway";

type Customer = {
  contact: string; name: string; imported: boolean; buyer: boolean; ready: boolean; opted_out: boolean; active: boolean;
  status: string | null; delivery_status: string | null; last_error: string | null; delivery_error: string | null;
  scheduled_for: number | null; sent_at: number | null; attempt_count: number; last_visit_at: number | null;
  legacy: { visits: number; spentCents: number; records: number } | null;
};
type Audience = {
  ready: number; audienceTotal: number; alreadyNudged: number; optedOut: number; waiting: number; resendReady: number;
  queued: number; notQueued: number; firstSendAt: number | null; lastSendAt: number | null;
  customers: Customer[]; total: number; pageSize: number;
};

function statusLabel(row: { status: string | null; delivery_status?: string | null; opted_out?: boolean; ready?: boolean }) {
  if (row.opted_out) return "Opted out";
  if (row.delivery_status === "delivered") return "Delivered";
  if (["failed", "undelivered"].includes(row.delivery_status ?? "")) return "Not delivered";
  return ({ sent: "Sent to provider", pending: "Queued", retrying: "Retrying", sending: "Sending", failed: "Failed",
    cancelled: "Stopped / skipped", pending_provider_setup: "Waiting for setup" } as Record<string, string>)[row.status ?? ""] ?? "Not sent";
}

function Status({ row }: { row: Parameters<typeof statusLabel>[0] }) {
  const label = statusLabel(row);
  return <span className={`giveaway-badge ${["Delivered", "Sent to provider"].includes(label) ? "good" : ["Failed", "Not delivered"].includes(label) ? "bad" : ""}`}>{label}</span>;
}

export function OutreachPanel({ data, busy, act, notice }: {
  data: Overview; busy: boolean; act: Act; notice: { tone: "ok" | "bad"; text: string } | null;
}) {
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [nudge, setNudge] = useState<NudgeKind>("announce");
  const [source, setSource] = useState("all");
  const [mode, setMode] = useState("new");
  const [intervalMinutes, setIntervalMinutes] = useState(0);
  const [perDay, setPerDay] = useState("500");
  const [testTo, setTestTo] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [audience, setAudience] = useState<Audience | null>(null);
  const [error, setError] = useState("");
  const [template, setTemplate] = useState<{ html: string; subject: string; sms: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{ key: string; count: number } | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [testedSelection, setTestedSelection] = useState("");
  const blocker = channel === "sms" ? data.smsBlocker : data.emailReady ? null : "Email is not connected. Set it up in Integrations.";

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const params = new URLSearchParams({ view: "audience", channel, nudge, source, mode, intervalMinutes: String(intervalMinutes), perDay, q: query, filter, page: String(page) });
      try {
        const response = await fetch(`/api/admin/giveaway?${params}`, { signal: controller.signal, cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Could not load this audience.");
        setAudience(result); setError("");
      } catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Could not load this audience."); }
    };
    const timer = window.setTimeout(() => void load(), 250);
    const poll = window.setInterval(() => void load(), 15_000);
    return () => { controller.abort(); window.clearTimeout(timer); window.clearInterval(poll); };
  }, [channel, nudge, source, mode, intervalMinutes, perDay, query, filter, page, refresh, data.now]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/admin/giveaway?view=template&nudge=${nudge}`, { signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error("Preview could not load."); return response.json(); })
      .then(setTemplate).catch(() => undefined);
    return () => controller.abort();
  }, [nudge]);

  const change = (fn: () => void) => { fn(); setAudience(null); setConfirmation(null); setPage(0); };
  const validPace = Number.isInteger(Number(perDay)) && Number(perDay) >= 1 && Number(perDay) <= 5000;
  const canSend = data.status === "open" && !blocker && !busy && !error && validPace && !!audience?.queued;
  const testIdentity = `${channel}:${nudge}:${testTo}`;

  return <>
    <section className="staff-panel giveaway-compose">
      <div className="staff-panel-head"><div><span className="giveaway-eyebrow">01 / PREPARE A NUDGE</span><h2>Who would you like to reach?</h2></div><span className="live-chip">You choose when to send</span></div>
      <div className="giveaway-compose-grid">
        <div className="giveaway-controls">
          <div className="giveaway-channel" role="group" aria-label="Message channel">
            <button className={channel === "sms" ? "active" : ""} onClick={() => change(() => { setChannel("sms"); setIntervalMinutes(0); setPerDay("500"); setTestTo(""); })}>SMS text</button>
            <button className={channel === "email" ? "active" : ""} onClick={() => change(() => { setChannel("email"); setIntervalMinutes(3); setPerDay(String(data.giveaway?.nudgePerDay ?? 80)); setTestTo(data.me.email); })}>Email</button>
          </div>
          <div className="settings-form">
            <label>Message<select value={nudge} onChange={(event) => change(() => setNudge(event.target.value as NudgeKind))}>
              <option value="announce">First nudge · giveaway announcement</option><option value="last_call">Last-call nudge · reminder before closing</option>
            </select></label>
            <label>Customer group<select value={source} onChange={(event) => change(() => setSource(event.target.value))}>
              <option value="all">All customers</option><option value="imported">Old customers · POS imports</option><option value="orders">Customers with website / till orders</option>
            </select></label>
            <label className="field-wide">Send to<select value={mode} onChange={(event) => change(() => setMode(event.target.value))}>
              <option value="new">Customers not yet sent this nudge</option><option value="resend">Resend to customers already sent this nudge</option>
            </select></label>
            <label>Time between messages<select value={intervalMinutes} onChange={(event) => change(() => setIntervalMinutes(Number(event.target.value)))}>
              {channel === "sms" ? <option value={0}>Send together · no delay</option> : null}
              {[1, 3, 4, 5, 10].map((value) => <option key={value} value={value}>Every {value} minute{value === 1 ? "" : "s"}</option>)}
            </select></label>
            <label>Maximum per day<input type="number" min={1} max={5000} value={perDay} onChange={(event) => change(() => setPerDay(event.target.value))} /></label>
          </div>
          <p className="editor-hint">Messages go out from 11 a.m. to 7 p.m. Hamilton time. The daily cap includes other queued giveaway nudges on this channel. Each contact appears once per batch.</p>
          {channel === "sms" && intervalMinutes === 0 ? <p className="secure-note">Texts start sending together during sending hours. Carrier delivery may take a few minutes.</p> : null}
          {channel === "email" ? <p className="secure-note">{data.emailVolume.sent} emails sent in the last 24 hours. Leave room in your email plan for order receipts.{data.emailVolume.rateLimited ? ` ${data.emailVolume.rateLimited} provider rate-limit errors recently.` : ""}</p> : null}
          {mode === "resend" ? <p className="giveaway-warning">This sends another copy to people already sent the selected nudge. People still waiting for it and anyone who opted out are excluded.</p> : <p className="secure-note">Already sent or queued? They are automatically skipped. You can send the last-call reminder before the final day whenever you are ready.</p>}
          {blocker ? <p className="form-error">{blocker}</p> : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
        </div>
        <div className="giveaway-preview">
          <span className="giveaway-eyebrow">CUSTOMER PREVIEW</span>
          {channel === "sms" ? <div className="giveaway-phone"><span>Pizza 62</span><p>{template?.sms ?? "Loading message…"}</p><small>SMS preview · includes opt-out instructions</small></div> : <>
            <strong>{template?.subject ?? "Loading email…"}</strong>
            <iframe title="Branded giveaway email preview" sandbox="" srcDoc={template?.html.replace("</head>", '<style>table[width="600"]{width:100%!important}body{overflow-wrap:anywhere}</style></head>') ?? ""} />
          </>}
          <label>Send a test to · optional<input type={channel === "sms" ? "tel" : "email"} value={testTo} onChange={(event) => setTestTo(event.target.value)} placeholder={channel === "sms" ? "Your phone number" : "Your email address"} /></label>
          <button className="staff-button" disabled={!!blocker || busy || !testTo.trim() || data.status !== "open"} onClick={async () => {
            const result = await act({ action: "nudge.test", channel, variant: nudge, [channel === "sms" ? "phone" : "email"]: testTo }, () => "Test queued. Check that it arrives before sending to customers.");
            if (result) setTestedSelection(testIdentity);
          }}>Send test {channel === "sms" ? "text" : "email"}</button>
        </div>
      </div>
    </section>

    <section className="staff-panel">
      <div className="staff-panel-head"><div><span className="giveaway-eyebrow">02 / REVIEW & SEND</span><h2>{mode === "resend" ? "Review the resend" : "Your audience"}</h2></div><span className="live-chip">{audience?.audienceTotal ?? "…"} contacts in this group</span></div>
      <div className="giveaway-counts">
        <div><strong>{audience?.ready ?? "—"}</strong><span>{mode === "resend" ? "Ready for a resend" : "Ready for this nudge"}</span></div>
        <div><strong>{audience?.waiting ?? "—"}</strong><span>Already in the queue</span></div>
        <div><strong>{audience?.resendReady ?? "—"}</strong><span>Previously sent</span></div>
        <div><strong>{audience?.optedOut ?? "—"}</strong><span>Opted out · excluded</span></div>
      </div>
      <div className="giveaway-send-summary">
        <div><strong>{audience?.queued ?? 0} {channel === "sms" ? "texts" : "emails"} fit before closing</strong>
          <p>{audience?.queued ? `${intervalMinutes === 0 ? "No delay between texts" : `Every ${intervalMinutes} minute${intervalMinutes === 1 ? "" : "s"}`}, up to ${perDay} a day. First: ${when(audience.firstSendAt)}. Last: ${when(audience.lastSendAt)}.` : "Choose an audience with eligible contacts to start a send."}</p>
          {audience?.notQueued ? <p className="giveaway-warning">{audience.notQueued} will remain unsent because this pace runs past closing. Choose a faster pace or a higher daily cap.</p> : null}
          {channel === "email" && source === "imported" && !audience?.audienceTotal ? <p>The attached POS export has no emails. Those customers can be reached by text. Imported customers with valid emails will appear here.</p> : null}
        </div>
        <button className="staff-button giveaway-primary" disabled={!canSend} onClick={() => setConfirmation({ key: crypto.randomUUID(), count: audience!.queued })}>
          Review {mode === "resend" ? "resend" : "send"} to {audience?.queued ?? 0}
        </button>
      </div>
      {!confirmation && notice ? <p className={notice.tone === "bad" ? "form-error" : "admin-message"} role={notice.tone === "bad" ? "alert" : "status"}>{notice.text}</p> : null}
      {confirmation ? <div className="giveaway-confirm" role="region" aria-label="Confirm customer messages">
        <h3>{mode === "resend" ? "Confirm another copy" : "Confirm this send"}</h3>
        <p>{NUDGES[nudge].label} by {channel === "sms" ? "SMS text" : "email"} to {confirmation.count} {source === "imported" ? "old POS customers" : "customers"}. {mode === "resend" ? "These customers have already been sent this nudge." : "Customers already sent or queued for this nudge will be skipped."}</p>
        {testedSelection !== testIdentity ? <p>You can send a test above, or confirm now using the customer preview.</p> : <p>Test queued to {testTo}. Check it has arrived and looks right.</p>}
        {notice ? <p className={notice.tone === "bad" ? "form-error" : "admin-message"} role={notice.tone === "bad" ? "alert" : "status"}>{notice.text}</p> : null}
        <div className="pager"><button className="staff-button giveaway-primary" disabled={busy || !canSend || queueing} aria-busy={queueing} onClick={async () => {
          setQueueing(true);
          try {
            const result = await act({ action: "nudge.send", channel, nudge, source, mode, intervalMinutes, perDay: Number(perDay), requestKey: confirmation.key },
              (value) => `${value.queued} messages queued. ${value.skipped} excluded.${value.notQueued ? ` ${value.notQueued} did not fit before closing.` : ""} Follow progress in Message activity.`);
            if (result) { setConfirmation(null); setRefresh((value) => value + 1); }
          } finally { setQueueing(false); }
        }}>{queueing ? "Queuing messages…" : `Confirm & queue ${mode === "resend" ? "resend" : "messages"}`}</button><button className="text-button" disabled={busy || queueing} onClick={() => setConfirmation(null)}>Cancel</button></div>
      </div> : null}
      <div className="record-filters giveaway-recipient-filters">
        <input aria-label="Search audience" placeholder="Search customer name, phone or email" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
        <select aria-label="Filter customer message status" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(0); }}>
          <option value="all">All statuses</option><option value="ready">Ready to send</option><option value="waiting">Queued / waiting</option><option value="sent">Previously sent</option><option value="failed">Failed / not delivered</option><option value="opted_out">Opted out</option>
        </select>
      </div>
      <div className="table-scroll" role="region" aria-label="Customer message status" tabIndex={0}><table className="viz-table"><thead><tr><th scope="col">Customer</th><th scope="col">Source & history</th><th scope="col">Selected nudge</th><th scope="col">Schedule / result</th></tr></thead><tbody>
        {audience?.customers.map((customer) => <tr key={customer.contact}>
          <th scope="row">{customer.name || "Customer"}<small>{customer.contact}</small></th>
          <td>{customer.imported ? "Old POS customer" : "Order customer"}{customer.buyer && customer.imported ? " + orders" : ""}<small>{customer.legacy ? `${customer.legacy.visits} POS visits · ${formatMoney(customer.legacy.spentCents)} POS spend` : ""}{customer.last_visit_at ? ` · Last visit ${when(customer.last_visit_at)}` : ""}</small></td>
          <td><Status row={customer} />{customer.ready ? <small>{mode === "resend" ? "Eligible for another copy" : "Ready to send"}</small> : null}</td>
          <td>{customer.sent_at ? when(customer.sent_at) : customer.active ? when(customer.scheduled_for) : "—"}<small>{customer.delivery_error ?? customer.last_error ?? (customer.attempt_count ? `${customer.attempt_count} sending attempt${customer.attempt_count === 1 ? "" : "s"}` : "")}</small></td>
        </tr>)}
        {!audience?.customers.length ? <tr><td colSpan={4} className="staff-empty">{audience ? "No customers match this selection." : "Loading audience…"}</td></tr> : null}
      </tbody></table></div>
      <Pager page={page} total={audience?.total ?? 0} pageSize={audience?.pageSize ?? 50} setPage={setPage} />
    </section>
  </>;
}

export function ActivityPanel({ data, busy, act }: { data: Overview; busy: boolean; act: Act }) {
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<{ messages: Array<{ id: string; recipient: string; status: string; delivery_status: string | null; scheduled_for: number; sent_at: number | null; attempt_count: number; last_error: string | null; delivery_error: string | null }>; total: number; pageSize: number } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void fetch(`/api/admin/giveaway?view=messages&sendId=${encodeURIComponent(selected)}&page=${page}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => { const value = await response.json(); if (!response.ok) throw new Error(value.error ?? "Could not load messages."); return value; })
      .then((value) => { setResult(value); setError(""); }).catch((caught) => { if (!controller.signal.aborted) setError(caught.message); });
    return () => controller.abort();
  }, [selected, page, data.now]);
  return <section className="staff-panel">
    <div className="staff-panel-head"><div><span className="giveaway-eyebrow">DELIVERY TRACKING</span><h2>Every send, in one place</h2></div><span className="live-chip">Refreshes every 15 seconds</span></div>
    <p className="editor-hint">Sent means the provider accepted the message. SMS shows Delivered only after a carrier receipt. Email delivery and opens are not confirmed here. Older texts may have no delivery receipt.</p>
    {!data.sends.length ? <p className="staff-empty">No nudges have been queued. Start in Send nudges.</p> : <div className="giveaway-runs">{data.sends.map((send) => <article key={send.id} className={`giveaway-run ${selected === send.id ? "selected" : ""}`}>
      <div className="staff-panel-head"><div><span className="giveaway-badge">{send.channel === "sms" ? "SMS" : "EMAIL"} · {send.send_mode === "resend" ? "RESEND" : "FIRST SEND"}</span><h3>{NUDGES[send.nudge as NudgeKind]?.label ?? send.nudge}</h3><small>{when(send.created_at)} · {send.created_by_name ?? "Staff"} · {send.audience_source === "imported" ? "Old POS customers" : send.audience_source === "orders" ? "Order customers" : "All customers"}</small></div><strong>{send.sent + send.failed + send.stopped} / {send.recipient_count}<small>processed</small></strong></div>
      <progress max={Math.max(1, send.recipient_count)} value={send.sent + send.failed + send.stopped} aria-label={`${send.sent + send.failed + send.stopped} of ${send.recipient_count} processed`} />
      <div className="giveaway-run-counts"><span><b>{send.sent}</b> sent to provider</span>{send.channel === "sms" ? <span><b>{send.delivered}</b> delivered</span> : null}<span><b>{send.waiting}</b> waiting</span><span><b>{send.failed + send.undelivered}</b> failed / not delivered</span><span><b>{send.stopped}</b> stopped / skipped</span></div>
      <p className="secure-note">{send.interval_minutes === 0 ? "Send together · " : send.interval_minutes ? `Every ${send.interval_minutes} minutes · ` : ""}Up to {send.per_day}/day · Last scheduled {when(send.last_send_at)} · {send.skipped_count} excluded</p>
      <div className="pager"><button className="staff-button" onClick={() => { setSelected(send.id); setPage(0); setResult(null); }}>View recipients</button>
        {send.waiting && send.channel === "sms" ? <button className="text-button" disabled={busy} onClick={() => {
          const cap = Math.max(send.per_day, 500);
          if (window.confirm(`Send the ${send.waiting} waiting texts together during sending hours, up to ${cap} a day? Already sent messages will not be sent again.`)) void act({ action: "nudge.repace", sendId: send.id, intervalMinutes: 0, perDay: cap }, (value) => `${value.updated} waiting texts set to send together. Follow progress here.`);
        }}>Send remaining together</button> : null}
        {send.waiting ? [3, 4].map((interval) => <button className="text-button" key={interval} disabled={busy} onClick={() => {
          const cap = send.channel === "sms" ? Math.max(send.per_day, Math.floor(480 / interval)) : send.per_day;
          if (window.confirm(`Re-time the unsent messages to every ${interval} minutes, up to ${cap} a day? Already sent messages will not be sent again.`)) void act({ action: "nudge.repace", sendId: send.id, intervalMinutes: interval, perDay: cap }, (value) => `${value.updated} waiting messages re-timed. Previously sent messages were left unchanged.`);
        }}>Use {interval}-minute pace</button>) : null}
        {send.waiting ? <button className="text-button" disabled={busy} onClick={() => {
          if (window.confirm(`Stop the ${send.waiting} messages still waiting in this batch? Messages already sent cannot be recalled.`)) void act({ action: "nudge.stop", sendId: send.id }, (value) => `${value.stopped} waiting messages stopped.`);
        }}>Stop remaining messages</button> : null}
      </div>
    </article>)}</div>}
    {selected ? <div className="giveaway-delivery-detail"><h3>Recipients in the selected batch</h3>{error ? <p className="form-error">{error}</p> : null}
      <div className="table-scroll" role="region" aria-label="Batch message details" tabIndex={0}><table className="viz-table"><thead><tr><th scope="col">Recipient</th><th scope="col">Status</th><th scope="col">Scheduled</th><th scope="col">Sent</th><th scope="col">Attempts / details</th></tr></thead><tbody>
        {result?.messages.map((row) => <tr key={row.id}><th scope="row">{row.recipient}</th><td><Status row={row} /></td><td>{when(row.scheduled_for)}</td><td>{when(row.sent_at)}</td><td>{row.attempt_count}<small>{row.delivery_error ?? row.last_error ?? ""}</small></td></tr>)}
        {!result?.messages.length ? <tr><td colSpan={5} className="staff-empty">{result ? "No messages in this batch." : "Loading recipients…"}</td></tr> : null}
      </tbody></table></div><Pager page={page} total={result?.total ?? 0} pageSize={result?.pageSize ?? 50} setPage={setPage} />
    </div> : null}
  </section>;
}

export function ImportPanel({ canImport, onImported }: { canImport: boolean; onImported: () => Promise<void> }) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<{ ready: number; withPhone: number; withEmail: number; merged: number; skipped: number; columns: Record<string, string>; skippedRows: Array<{ row: number; reason: string }> } | null>(null);
  if (!canImport) return null;
  const submit = async (action: "import.preview" | "import.commit", contents = csv, name = fileName) => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/admin/contacts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, csv: contents, fileName: name }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Import failed.");
      if (action === "import.preview") setPreview(result);
      else { setMessage(`${result.created} customers added, ${result.updated} updated, ${result.merged} duplicate rows merged, ${result.skipped} rows skipped. No messages were sent.`); setPreview(null); setCsv(""); await onImported(); }
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : "Import failed."); }
    finally { setBusy(false); }
  };
  return <section className="staff-panel"><details><summary className="giveaway-import-title">Import old customers from CSV</summary>
    <p className="editor-hint">Keeps customers with a valid phone or email. Invalid contact fields are dropped; rows without either are skipped. Duplicate contacts are merged, existing opt-outs and message history are preserved. POS visits and spend stay separate from website orders.</p>
    <label className="giveaway-file">Choose customer CSV<input type="file" accept=".csv,text/csv" disabled={busy} onChange={async (event) => {
      const file = event.target.files?.[0]; setPreview(null); setMessage(""); if (!file) return;
      if (file.size > 2_000_000) { setMessage("Choose a CSV smaller than 2 MB."); return; }
      const contents = await file.text(); setCsv(contents); setFileName(file.name); await submit("import.preview", contents, file.name);
    }} /></label>
    {busy ? <p role="status">Processing customer file…</p> : null}
    {message ? <p className="admin-message" role="status">{message}</p> : null}
    {preview ? <div className="giveaway-confirm"><h3>Review {fileName}</h3><p>{preview.ready} contacts ready · {preview.withPhone} with phone · {preview.withEmail} with email · {preview.merged} duplicate rows merged · {preview.skipped} unusable rows skipped.</p><p className="secure-note">Mapped columns: {Object.values(preview.columns).join(", ")}</p>
      {preview.skippedRows.length ? <details><summary>See rows merged or skipped</summary><ul>{preview.skippedRows.map((row) => <li key={row.row}>Row {row.row}: {row.reason}</li>)}</ul></details> : null}
      <div className="pager"><button className="staff-button" disabled={busy || !preview.ready} onClick={() => void submit("import.commit")}>Import {preview.ready} customers</button><button className="text-button" onClick={() => setPreview(null)}>Cancel</button></div>
    </div> : null}
  </details></section>;
}

function Pager({ page, total, pageSize, setPage }: { page: number; total: number; pageSize: number; setPage: (page: number) => void }) {
  if (total <= pageSize) return null;
  return <div className="pager"><button className="staff-button" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page + 1} of {Math.ceil(total / pageSize)} · {total} results</span><button className="staff-button" disabled={(page + 1) * pageSize >= total} onClick={() => setPage(page + 1)}>Next</button></div>;
}
