"use client";

/**
 * Admin → Giveaway: the Pizza 62 Thanksgiving Giveaway, run from one screen.
 *
 * In the order the owner will need it over the two weeks:
 *
 * 1. **How it is going** — entries, people, today.
 * 2. **Nudging past customers** — the two buttons the owner asked for, one
 *    to announce and one the day before it closes, each with a test send and
 *    a log that says when it went, who pressed it and how far it has got.
 * 3. **Picking the winner**, once entries close — owner only, at random,
 *    recorded the moment it happens.
 * 4. **Whose number is whose** — searchable, exportable.
 * 5. **The settings**, for the prize wording, the minimum and the dates.
 *
 * Self-fetching like the other reports; it is not part of the dashboard poll.
 */

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/lib/domain";
import { NUDGES, planNudgeSchedule, type GiveawaySetting, type NudgeKind } from "@/lib/giveaway";

type Entry = {
  id: string;
  entry_label: string;
  order_id: string;
  order_number: string;
  customer_name: string;
  customer_email: string;
  customer_phone: string;
  qualifying_cents: number;
  channel: string;
  fulfilment: string;
  created_at: number;
  picked_at: number | null;
  picked_by_name: string | null;
  eligible: boolean;
};

type Send = {
  id: string;
  nudge: string;
  recipient_count: number;
  skipped_count: number;
  per_day: number;
  first_send_at: number | null;
  last_send_at: number | null;
  created_at: number;
  created_by_name: string | null;
  sent: number;
  waiting: number;
  failed: number;
  stopped: number;
};

type Audience = { ready: number; optedOut: number; alreadyNudged: number };

type Overview = {
  giveaway: GiveawaySetting | null;
  status: "off" | "upcoming" | "open" | "closed";
  now: number;
  stats: { entries: number; eligible: number; people: number; today: number };
  entries: Entry[];
  total: number;
  page: number;
  pageSize: number;
  picks: Entry[];
  nudges: Record<NudgeKind, Audience>;
  sends: Send[];
  emailVolume: { sent: number; rateLimited: number };
  emailReady: boolean;
  canPick: boolean;
  canViewContact: boolean;
  me: { email: string; name: string };
};

const STATUS_LABELS: Record<Overview["status"], string> = {
  off: "Switched off",
  upcoming: "Not started",
  open: "Live",
  closed: "Entries closed",
};

const CHANNELS: Record<string, string> = { online: "Website", phone: "Phone", walk_in: "Walk-in" };

const when = (value: number | null | undefined) =>
  value
    ? new Date(value).toLocaleString("en-CA", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" })
    : "—";

const day = (value: number) =>
  new Date(value).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Toronto" });

/** The YYYY-MM-DD of the last day orders count, for the date input. */
const lastDayInput = (endsAt: number) => new Date(endsAt - 1).toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

export function AdminGiveawayPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const search = new URLSearchParams({ q: query, page: String(page) });
    const response = await fetch(`/api/admin/giveaway?${search}`);
    const result = await response.json();
    if (!response.ok) {
      setMessage({ tone: "bad", text: result.error ?? "The giveaway could not be loaded." });
      return;
    }
    setData(result);
  }, [query, page]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  const act = async (body: Record<string, unknown>, success: (result: Record<string, unknown>) => string) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/giveaway", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "That did not work.");
      setMessage({ tone: "ok", text: success(result) });
      await load();
      return result as Record<string, unknown>;
    } catch (caught) {
      setMessage({ tone: "bad", text: caught instanceof Error ? caught.message : "That did not work." });
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (!data) return <div className="staff-panel" role="status">{message?.text ?? "Loading the giveaway…"}</div>;
  if (!data.giveaway) return <div className="staff-panel staff-empty">The giveaway has not been set up.</div>;
  const giveaway = data.giveaway;

  return (
    <div className="admin-stack">
      <section className="stats-grid">
        <Stat label="Status" value={STATUS_LABELS[data.status]} note={data.status === "open" ? `Closes at midnight after ${day(giveaway.endsAt - 1)}` : `Winner: ${giveaway.winnerAnnouncedOn}`} />
        <Stat label="Entries" value={String(data.stats.eligible)} note={data.stats.entries > data.stats.eligible ? `${data.stats.entries - data.stats.eligible} dropped out (cancelled or refunded)` : "One per qualifying order"} />
        <Stat label="People entered" value={String(data.stats.people)} note="By email or phone" />
        <Stat label="Entries today" value={String(data.stats.today)} note="Since midnight, Hamilton time" />
      </section>

      <p className="admin-message" role="note">
        <strong>{giveaway.title}:</strong> every order of {formatMoney(giveaway.minimumCents)} or more (food before tax, after any promo)
        placed from {when(giveaway.startsAt)} until closing on {day(giveaway.endsAt - 1)} earns one entry to win {giveaway.prize}.
        Customers get their entry number on their receipt email, in a separate &ldquo;You&rsquo;re in&rdquo; email and on the printed ticket.
      </p>

      {message ? <p className={message.tone === "bad" ? "form-error" : "admin-message"} role="status">{message.text}</p> : null}

      <NudgesPanel data={data} busy={busy} act={act} />
      <WinnerPanel data={data} busy={busy} act={act} />

      <section className="staff-panel">
        <div className="staff-panel-head">
          <h2>Entries</h2>
          <span className="live-chip">{data.total} entr{data.total === 1 ? "y" : "ies"}</span>
        </div>
        <div className="record-filters">
          <input
            value={query}
            onChange={(event) => { setQuery(event.target.value); setPage(0); }}
            placeholder="Entry number, name, phone, email or order"
            aria-label="Search entries"
          />
          {data.canViewContact ? (
            <button className="staff-button" disabled={!data.total} onClick={() => window.location.assign("/api/admin/giveaway?format=csv")}>
              Export CSV
            </button>
          ) : null}
        </div>
        <div className="table-scroll" role="region" aria-label="Giveaway entries" tabIndex={0}>
          <table className="viz-table">
            <thead>
              <tr><th scope="col">Entry</th><th scope="col">Customer</th><th scope="col">Order</th><th scope="col">Food before tax</th><th scope="col">Entered</th></tr>
            </thead>
            <tbody>
              {data.entries.map((entry) => (
                <tr key={entry.id}>
                  <th scope="row">#{entry.entry_label}{entry.picked_at ? <small>Picked {when(entry.picked_at)}</small> : !entry.eligible ? <small>Not eligible · order cancelled or refunded</small> : null}</th>
                  <td>{entry.customer_name}<small>{[entry.customer_phone, entry.customer_email].filter(Boolean).join(" · ") || "No contact details"}</small></td>
                  <td>{entry.order_number}<small>{CHANNELS[entry.channel] ?? entry.channel} · {entry.fulfilment}</small></td>
                  <td>{formatMoney(entry.qualifying_cents)}</td>
                  <td>{when(entry.created_at)}</td>
                </tr>
              ))}
              {!data.entries.length ? <tr><td colSpan={5} className="staff-empty">{query ? "No entries match that search." : "No entries yet. The first qualifying order will appear here."}</td></tr> : null}
            </tbody>
          </table>
        </div>
        {data.total > data.pageSize ? (
          <div className="pager">
            <button className="staff-button" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>Previous</button>
            <span>Page {page + 1} of {Math.ceil(data.total / data.pageSize)}</span>
            <button className="staff-button" disabled={(page + 1) * data.pageSize >= data.total} onClick={() => setPage((current) => current + 1)}>Next</button>
          </div>
        ) : null}
      </section>

      <SettingsPanel giveaway={giveaway} busy={busy} act={act} />
    </div>
  );
}

type Act = (body: Record<string, unknown>, success: (result: Record<string, unknown>) => string) => Promise<Record<string, unknown> | null>;

/**
 * The two nudges.
 *
 * The daily limit is the one number here that needs explaining, so it is
 * explained where it is set: nudges share the email plan's daily allowance
 * with order receipts, and on the free plan that allowance is 100.
 */
function NudgesPanel({ data, busy, act }: { data: Overview; busy: boolean; act: Act }) {
  const giveaway = data.giveaway as GiveawaySetting;
  const [perDay, setPerDay] = useState(String(giveaway.nudgePerDay));
  const [testEmail, setTestEmail] = useState(data.me.email);
  const [confirming, setConfirming] = useState<NudgeKind | null>(null);
  const perDayNumber = Math.max(1, Math.trunc(Number(perDay) || 0));
  const open = data.status === "open";

  return (
    <section className="staff-panel">
      <div className="staff-panel-head">
        <h2>Nudge past customers</h2>
        <span className="live-chip">{data.emailVolume.sent} emails sent in the last 24 h</span>
      </div>
      <p className="editor-hint">
        Goes to everyone who has bought from us with an email address, plus customers imported from the POS (Customers → Import).
        Anyone who has unsubscribed is always left out, and each nudge reaches each person once — pressing it again only reaches people added since.
        Every nudge carries an unsubscribe link, as Canadian anti-spam law requires.
      </p>
      {!data.emailReady ? <p className="form-error">Email is not set up yet (Integrations), so nudges cannot be sent.</p> : null}
      {data.emailVolume.rateLimited > 0 ? (
        <p className="form-error">The email provider refused {data.emailVolume.rateLimited} email{data.emailVolume.rateLimited === 1 ? "" : "s"} for being over its limit in the last 24 hours. Lower the daily limit, or upgrade the email plan.</p>
      ) : null}
      <div className="settings-form">
        <label>
          Nudges per day
          <input type="number" min={1} max={5000} value={perDay} onChange={(event) => setPerDay(event.target.value)} />
        </label>
        <label className="field-wide">
          Why a limit
          <input readOnly tabIndex={-1} value="Receipts use the same email allowance. Resend's free plan allows 100 a day — leave room for orders." />
        </label>
      </div>

      <div className="staff-grid giveaway-nudges">
        {(Object.keys(NUDGES) as NudgeKind[]).map((nudge) => {
          const audience = data.nudges[nudge];
          const schedule = planNudgeSchedule(audience.ready, perDayNumber, data.now);
          const finishes = schedule.at(-1) ?? null;
          const lateForClose = finishes !== null && finishes >= giveaway.endsAt;
          const lastSend = data.sends.find((send) => send.nudge === nudge);
          return (
            <article className="giveaway-nudge" key={nudge}>
              <h3>{NUDGES[nudge].label}</h3>
              <p>{NUDGES[nudge].description}</p>
              <ul>
                <li><b>{audience.ready}</b> ready to send</li>
                {audience.alreadyNudged ? <li>{audience.alreadyNudged} already sent this nudge</li> : null}
                {audience.optedOut ? <li>{audience.optedOut} unsubscribed — never emailed</li> : null}
              </ul>
              {lastSend ? <p className="secure-note">Last sent {when(lastSend.created_at)} by {lastSend.created_by_name ?? "staff"} to {lastSend.recipient_count}.</p> : <p className="secure-note">Not sent yet.</p>}
              {audience.ready ? (
                <p className="secure-note">
                  At {perDayNumber} a day, from 11 a.m. to 7 p.m.: {schedule.length > 1 ? `first ${when(schedule[0])}, last ${when(finishes)}` : `goes ${when(schedule[0])}`}.
                  {lateForClose ? <strong> That runs past the close — raise the daily limit if your email plan allows.</strong> : null}
                </p>
              ) : null}
              {confirming === nudge ? (
                <div className="pager">
                  <button
                    className="staff-button"
                    disabled={busy}
                    onClick={() => {
                      setConfirming(null);
                      void act({ action: "nudge.send", nudge, perDay: perDayNumber }, (result) =>
                        `${NUDGES[nudge].label} queued for ${result.queued} customer${result.queued === 1 ? "" : "s"}.`);
                    }}
                  >
                    Yes, send to {audience.ready}
                  </button>
                  <button className="staff-button" onClick={() => setConfirming(null)}>Cancel</button>
                </div>
              ) : (
                <button className="staff-button" disabled={!open || !audience.ready || !data.emailReady || busy} onClick={() => setConfirming(nudge)}>
                  {open ? `Send to ${audience.ready} customer${audience.ready === 1 ? "" : "s"}` : "Giveaway is not open"}
                </button>
              )}
              <button
                className="text-button"
                disabled={!open || !data.emailReady || busy || !testEmail.trim()}
                onClick={() => void act({ action: "nudge.test", variant: nudge, email: testEmail }, () => `Test ${NUDGES[nudge].label.toLowerCase()} sent to ${testEmail}. It arrives marked [TEST].`)}
              >
                Send me a test first
              </button>
            </article>
          );
        })}
      </div>
      <div className="settings-form">
        <label className="field-wide">
          Test emails go to
          <input value={testEmail} onChange={(event) => setTestEmail(event.target.value)} inputMode="email" />
        </label>
      </div>

      {data.sends.length ? (
        <div className="table-scroll" role="region" aria-label="Nudges sent" tabIndex={0}>
          <table className="viz-table">
            <thead>
              <tr><th scope="col">Sent</th><th scope="col">Nudge</th><th scope="col">Progress</th><th scope="col">Pace</th><th scope="col" /></tr>
            </thead>
            <tbody>
              {data.sends.map((send) => (
                <tr key={send.id}>
                  <th scope="row">{when(send.created_at)}<small>by {send.created_by_name ?? "staff"}</small></th>
                  <td>{NUDGES[send.nudge as NudgeKind]?.label ?? send.nudge}<small>{send.recipient_count} people{send.skipped_count ? ` · ${send.skipped_count} left out` : ""}</small></td>
                  <td>{send.sent} delivered<small>{[send.waiting ? `${send.waiting} waiting` : "", send.failed ? `${send.failed} failed` : "", send.stopped ? `${send.stopped} stopped or skipped` : ""].filter(Boolean).join(" · ") || "done"}</small></td>
                  <td>{send.per_day}/day<small>{send.last_send_at ? `last one ${when(send.last_send_at)}` : ""}</small></td>
                  <td>
                    {send.waiting ? (
                      <button
                        className="staff-button"
                        disabled={busy}
                        onClick={() => void act({ action: "nudge.stop", sendId: send.id }, (result) => `Stopped ${result.stopped} email${result.stopped === 1 ? "" : "s"} that had not gone yet.`)}
                      >
                        Stop the rest
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Picking the winner.
 *
 * Owner-only and not before entries close, both enforced by the server. The
 * result is shown large, because this is the screen that may be on a phone
 * held up to a camera on the day.
 */
function WinnerPanel({ data, busy, act }: { data: Overview; busy: boolean; act: Act }) {
  const giveaway = data.giveaway as GiveawaySetting;
  const [confirm, setConfirm] = useState(false);
  const latest = data.picks.at(-1) ?? null;
  const closed = data.status === "closed";

  return (
    <section className="staff-panel">
      <div className="staff-panel-head">
        <h2>Pick the winner</h2>
        <span className="live-chip">{giveaway.winnerAnnouncedOn}</span>
      </div>
      {latest ? (
        <div className="giveaway-winner" role="status">
          <span>Winning entry</span>
          <strong>#{latest.entry_label}</strong>
          <p><b>{latest.customer_name}</b>{[latest.customer_phone, latest.customer_email].filter(Boolean).length ? ` · ${[latest.customer_phone, latest.customer_email].filter(Boolean).join(" · ")}` : ""}</p>
          <small>Order {latest.order_number} · picked {when(latest.picked_at)}{latest.picked_by_name ? ` by ${latest.picked_by_name}` : ""}</small>
        </div>
      ) : null}
      <p className="editor-hint">
        One entry is chosen at random from every eligible entry — each qualifying order has the same chance, and cancelled or refunded orders are left out.
        If a winner cannot be reached, pick again: the new pick skips every entry held by the same person.
      </p>
      {!data.canPick ? (
        <p className="secure-note">Only the owner can pick the winner.</p>
      ) : !closed ? (
        <p className="secure-note">Available once entries close, at midnight after {day(giveaway.endsAt - 1)}.</p>
      ) : (
        <>
          <label className="admin-check">
            <input type="checkbox" checked={confirm} onChange={(event) => setConfirm(event.target.checked)} />
            <span>{latest ? "The last winner could not be reached — pick another entry." : "I'm ready: pick the winning entry now. It is recorded straight away."}</span>
          </label>
          <button
            className="staff-button"
            disabled={!confirm || busy}
            onClick={() => {
              setConfirm(false);
              void act({ action: "winner.pick" }, (result) => `Entry #${(result.winner as Entry).entry_label} is the winner.`);
            }}
          >
            {latest ? "Pick another entry" : "Pick the winner"}
          </button>
        </>
      )}
      {data.picks.length > 1 ? (
        <p className="secure-note">Earlier picks: {data.picks.slice(0, -1).map((pick) => `#${pick.entry_label} ${pick.customer_name}`).join(", ")}.</p>
      ) : null}
    </section>
  );
}

function SettingsPanel({ giveaway, busy, act }: { giveaway: GiveawaySetting; busy: boolean; act: Act }) {
  const [enabled, setEnabled] = useState(giveaway.enabled);
  const [title, setTitle] = useState(giveaway.title);
  const [prize, setPrize] = useState(giveaway.prize);
  const [minimum, setMinimum] = useState((giveaway.minimumCents / 100).toFixed(2));
  const [lastDay, setLastDay] = useState(lastDayInput(giveaway.endsAt));
  const [announced, setAnnounced] = useState(giveaway.winnerAnnouncedOn);

  return (
    <section className="staff-panel">
      <div className="staff-panel-head"><h2>Giveaway settings</h2></div>
      <p className="editor-hint">These are read live by the checkout, the till, the emails and the giveaway page, so a change here changes all of them at once.</p>
      <div className="settings-form">
        <label>Name<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="field-wide">Prize · reads after &ldquo;win&rdquo;<input value={prize} onChange={(event) => setPrize(event.target.value)} /></label>
        <label>Minimum order · C$ food before tax<input type="number" min={0} step="0.01" value={minimum} onChange={(event) => setMinimum(event.target.value)} /></label>
        <label>Last day orders count<input type="date" value={lastDay} onChange={(event) => setLastDay(event.target.value)} /></label>
        <label className="field-wide">Winner announced<input value={announced} onChange={(event) => setAnnounced(event.target.value)} /></label>
      </div>
      <label className="admin-check">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        <span>Giveaway is on — orders earn entries and the storefront shows it</span>
      </label>
      <button
        className="staff-button"
        disabled={busy}
        onClick={() =>
          void act(
            {
              action: "settings",
              enabled,
              title,
              prize,
              minimumCents: Math.round(Number(minimum) * 100),
              lastDay,
              winnerAnnouncedOn: announced,
            },
            () => "Giveaway settings saved.",
          )
        }
      >
        Save settings
      </button>
    </section>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return <article className="stat-card"><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}
