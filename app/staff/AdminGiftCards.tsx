"use client";

/**
 * Admin → Gift cards.
 *
 * Four questions this screen exists to answer, in the order they get asked at a
 * counter:
 *
 * 1. *"Did my card go out?"* — search by the last four characters, by the
 *    recipient's email, or by pasting the whole code the customer is reading
 *    out. The full code is matched by its hash; nothing here can ever display
 *    one, because nothing stored can produce one.
 * 2. *"Where did my balance go?"* — the ledger, oldest first, with the order
 *    number against every redemption.
 * 3. *"I have lost it."* — void and reissue. The old card dies with its code,
 *    which is the point: whoever found the lost email cannot spend it either.
 * 4. *"What do we owe?"* — the outstanding liability, which is the number the
 *    bookkeeper asks for and the only one on this screen that is not derivable
 *    from the orders table.
 *
 * Self-fetching, like `AdminCustomersPanel`: gift cards are their own report
 * rather than part of the dashboard payload every section polls every 30
 * seconds.
 */

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/lib/domain";

type Card = {
  id: string;
  code_suffix: string;
  initial_cents: number;
  balance_cents: number;
  status: string;
  origin: string;
  recipient_name: string;
  recipient_email: string;
  sender_name: string;
  message: string | null;
  expires_at: number | null;
  issued_at: number;
};

type LedgerRow = {
  id: string;
  type: string;
  amount_cents: number;
  balance_after_cents: number;
  order_number: string | null;
  actor_type: string;
  note: string | null;
  created_at: number;
};

type Liability = {
  outstandingCents: number;
  activeCards: number;
  issuedCents: number;
  redeemedCents: number;
};

const when = (value: unknown) =>
  value
    ? new Date(Number(value)).toLocaleString("en-CA", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Toronto",
      })
    : "—";

/**
 * What each ledger entry means, in words rather than in the vocabulary the
 * database uses. "hold" is meaningless to whoever is standing at the counter
 * with a customer; "reserved for an order being paid for" is not.
 */
const LEDGER_LABELS: Record<string, string> = {
  issue: "Card issued",
  hold: "Reserved for an order",
  capture: "Spent — payment cleared",
  release: "Returned — order not paid",
  adjust: "Balance adjusted by staff",
  void: "Card cancelled",
};

export function AdminGiftCardsPanel({ isOwner }: { isOwner: boolean }) {
  const [query, setQuery] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [liability, setLiability] = useState<Liability | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ card: Card; ledger: LedgerRow[] } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/admin/gift-cards?q=${encodeURIComponent(query)}`);
    const result = await response.json();
    if (!response.ok) {
      setMessage(result.error ?? "Gift cards could not be loaded.");
      return;
    }
    setCards(result.cards ?? []);
    setLiability(result.liability ?? null);
  }, [query]);

  // Debounced, so typing a recipient's email is one request rather than twenty.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  const openCard = useCallback(async (id: string) => {
    setSelectedId(id);
    setSelected(null);
    const response = await fetch(`/api/admin/gift-cards?id=${encodeURIComponent(id)}`);
    const result = await response.json();
    if (!response.ok) {
      setMessage(result.error ?? "That card could not be loaded.");
      setSelectedId(null);
      return;
    }
    setSelected({ card: result.card, ledger: result.ledger ?? [] });
  }, []);

  const act = async (body: Record<string, unknown>, success: (result: Record<string, unknown>) => string) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/gift-cards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "That action could not be completed.");
      setMessage(success(result));
      await load();
      if (selectedId) await openCard(selectedId);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "That action could not be completed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-stack">
      <section className="stats-grid">
        <Stat
          label="Outstanding liability"
          value={formatMoney(liability?.outstandingCents ?? 0)}
          note="Unspent balances — money owed, not revenue"
        />
        <Stat label="Active cards" value={String(liability?.activeCards ?? 0)} note="With a balance or without" />
        <Stat label="Issued to date" value={formatMoney(liability?.issuedCents ?? 0)} note="Face value of live cards" />
        <Stat label="Redeemed to date" value={formatMoney(liability?.redeemedCents ?? 0)} note="Spent on orders" />
      </section>

      {/* Said in words, because it is the one thing about gift cards that gets
          entered wrongly in the books and is expensive to unpick a year later. */}
      <p className="admin-message" role="note">
        A gift card sale is a <strong>liability, not revenue</strong>. The money is taken before anything is
        supplied and becomes revenue when the card is spent — at which point it is already counted, because
        the redeeming order&rsquo;s total is unchanged by the card. Outstanding liability is the figure to
        carry on the books.
      </p>

      {message ? <p className="admin-message" role="status">{message}</p> : null}

      {isOwner ? <IssueCard busy={busy} onIssue={(body) => act(body, (result) => `Card ending ${result.suffix} issued and emailed.`)} /> : null}

      <section className="staff-panel">
        <div className="staff-panel-head">
          <h2>Gift cards</h2>
          <span className="live-chip">{cards.length} shown</span>
        </div>
        <div className="record-filters">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Last 4 characters, recipient email, name, or a whole code"
            aria-label="Search gift cards"
          />
        </div>
        <div className="table-scroll" role="region" aria-label="Gift cards" tabIndex={0}>
          <table className="viz-table">
            <thead>
              <tr>
                <th scope="col">Card</th>
                <th scope="col">Recipient</th>
                <th scope="col">Issued</th>
                <th scope="col">Face value</th>
                <th scope="col">Balance</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <tr key={card.id} className="customer-row" onClick={() => void openCard(card.id)}>
                  <th scope="row">
                    &bull;&bull;&bull;&bull; {card.code_suffix}
                    <small>
                      {card.status === "voided" ? "Cancelled" : card.origin === "staff_issue" ? "Promotional" : "Purchased"}
                      {card.expires_at ? ` · expires ${when(card.expires_at)}` : ""}
                    </small>
                  </th>
                  <td>
                    {card.recipient_name}
                    <small>{card.recipient_email}</small>
                  </td>
                  <td>
                    {when(card.issued_at)}
                    <small>from {card.sender_name}</small>
                  </td>
                  <td>{formatMoney(card.initial_cents)}</td>
                  <td>{formatMoney(card.balance_cents)}</td>
                </tr>
              ))}
              {!cards.length ? (
                <tr>
                  <td colSpan={5} className="staff-empty">No gift cards match that search.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {selectedId ? (
        <section className="staff-panel">
          {selected ? (
            <CardDetail
              card={selected.card}
              ledger={selected.ledger}
              busy={busy}
              onClose={() => { setSelectedId(null); setSelected(null); }}
              onAdjust={(amountCents, note) =>
                act({ action: "adjust", giftCardId: selected.card.id, amountCents, note }, (result) =>
                  `Balance is now ${formatMoney(Number(result.balanceCents ?? 0))}.`,
                )
              }
              onVoid={(note, reissue) =>
                act({ action: "void", giftCardId: selected.card.id, note, reissue }, (result) =>
                  result.reissuedSuffix
                    ? `Cancelled. A replacement ending ${result.reissuedSuffix} has been emailed.`
                    : "That card has been cancelled.",
                )
              }
            />
          ) : (
            <div className="staff-empty" role="status">Loading that card&hellip;</div>
          )}
        </section>
      ) : null}
    </div>
  );
}

/**
 * Issuing a free card. Owner-only, and behind a summary because it is the one
 * control on this screen that creates money rather than moving it.
 */
function IssueCard({ busy, onIssue }: { busy: boolean; onIssue: (body: Record<string, unknown>) => Promise<void> }) {
  const [amount, setAmount] = useState("25");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState("");

  const amountCents = Math.round(Number(amount.replace(/[^0-9.]/g, "")) * 100);
  const ready = Number.isSafeInteger(amountCents) && amountCents > 0 && name.trim().length > 1 && /\S+@\S+\.\S+/.test(email) && note.trim().length > 1;

  return (
    <details className="staff-panel">
      <summary className="staff-panel-head" style={{ cursor: "pointer" }}>
        <h2>Issue a promotional card</h2>
        <span className="live-chip">Owner only</span>
      </summary>
      <div className="settings-form">
        <label>
          Amount · C$
          <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <label>
          Recipient name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Recipient email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        {/*
          The only place an expiry can ever be set. A purchased card cannot
          carry one — Ontario's Consumer Protection Act forbids it, and the
          database refuses to store one — but a card given away free may.
        */}
        <label>
          Expires · optional
          <input type="date" value={expires} onChange={(event) => setExpires(event.target.value)} />
        </label>
        <label className="field-wide">
          Why · goes in the audit trail
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Cold delivery — order P62-1841"
          />
        </label>
      </div>
      <p className="secure-note">
        The card is emailed to the recipient immediately. Nobody here — including you — can read the code
        back afterwards, so if it is lost the card must be cancelled and reissued.
      </p>
      <button
        className="staff-button"
        disabled={!ready || busy}
        onClick={() =>
          void onIssue({
            action: "issue",
            amountCents,
            recipientName: name.trim(),
            recipientEmail: email.trim(),
            note: note.trim(),
            expiresAt: expires ? new Date(`${expires}T23:59:59`).getTime() : null,
          })
        }
      >
        {busy ? "Issuing…" : "Issue and email the card"}
      </button>
    </details>
  );
}

function CardDetail({
  card,
  ledger,
  busy,
  onClose,
  onAdjust,
  onVoid,
}: {
  card: Card;
  ledger: LedgerRow[];
  busy: boolean;
  onClose: () => void;
  onAdjust: (amountCents: number, note: string) => Promise<void>;
  onVoid: (note: string, reissue: boolean) => Promise<void>;
}) {
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustNote, setAdjustNote] = useState("");
  const [voidNote, setVoidNote] = useState("");
  const [confirmVoid, setConfirmVoid] = useState(false);

  const adjustCents = Math.round(Number(adjustAmount.replace(/[^0-9.-]/g, "")) * 100);
  const canAdjust = Number.isSafeInteger(adjustCents) && adjustCents !== 0 && adjustNote.trim().length > 1;

  return (
    <>
      <div className="staff-panel-head">
        <h2>Card ending {card.code_suffix}</h2>
        <button className="staff-button" onClick={onClose}>Back to all cards</button>
      </div>

      <div className="settings-form">
        <Fact label="Balance" value={formatMoney(card.balance_cents)} />
        <Fact label="Face value" value={formatMoney(card.initial_cents)} />
        <Fact label="Status" value={card.status === "voided" ? "Cancelled" : "Active"} />
        <Fact label="Origin" value={card.origin === "staff_issue" ? "Issued by staff" : "Purchased"} />
        <Fact label="Recipient" value={`${card.recipient_name} · ${card.recipient_email}`} />
        <Fact label="From" value={card.sender_name} />
        <Fact label="Issued" value={when(card.issued_at)} />
        <Fact label="Expires" value={card.expires_at ? when(card.expires_at) : "Never"} />
      </div>
      {card.message ? <p className="secure-note">Message on the card: &ldquo;{card.message}&rdquo;</p> : null}

      <div className="table-scroll" role="region" aria-label="Gift card ledger" tabIndex={0}>
        <table className="viz-table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">What happened</th>
              <th scope="col">Order</th>
              <th scope="col">Change</th>
              <th scope="col">Balance after</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((row) => (
              <tr key={row.id}>
                <th scope="row">{when(row.created_at)}<small>{row.actor_type}</small></th>
                <td>
                  {LEDGER_LABELS[row.type] ?? row.type}
                  {row.note ? <small>{row.note}</small> : null}
                </td>
                <td>{row.order_number ?? "—"}</td>
                <td>
                  {/* A capture moves no money — the hold already did — so it
                      reads as a dash rather than a misleading zero. */}
                  {row.amount_cents === 0
                    ? "—"
                    : `${row.amount_cents > 0 ? "+" : "−"}${formatMoney(Math.abs(row.amount_cents))}`}
                </td>
                <td>{formatMoney(row.balance_after_cents)}</td>
              </tr>
            ))}
            {!ledger.length ? (
              <tr><td colSpan={5} className="staff-empty">Nothing has moved on this card yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {card.status === "active" ? (
        <>
          <div className="settings-form">
            <label>
              Adjust balance · C$ (negative to take off)
              <input inputMode="text" value={adjustAmount} onChange={(event) => setAdjustAmount(event.target.value)} placeholder="10.00" />
            </label>
            <label className="field-wide">
              Why
              <input value={adjustNote} onChange={(event) => setAdjustNote(event.target.value)} placeholder="Goodwill after a late delivery" />
            </label>
          </div>
          <button className="staff-button" disabled={!canAdjust || busy} onClick={() => void onAdjust(adjustCents, adjustNote.trim())}>
            {busy ? "Saving…" : "Adjust balance"}
          </button>

          <div className="danger-banner" style={{ marginTop: 18 }}>
            <span>
              <strong>Cancel this card</strong> · {formatMoney(card.balance_cents)} on it.
              Reissuing emails a brand-new code to {card.recipient_email} and the old one stops working —
              which is the point when a customer has lost theirs.
            </span>
          </div>
          <div className="settings-form">
            <label className="field-wide">
              Why
              <input value={voidNote} onChange={(event) => setVoidNote(event.target.value)} placeholder="Customer lost the code" />
            </label>
          </div>
          <label className="admin-check">
            <input type="checkbox" checked={confirmVoid} onChange={(event) => setConfirmVoid(event.target.checked)} />
            <span>I understand the old code stops working immediately and cannot be recovered.</span>
          </label>
          <div className="pager">
            <button
              className="staff-button"
              disabled={!confirmVoid || voidNote.trim().length < 2 || busy}
              onClick={() => void onVoid(voidNote.trim(), true)}
            >
              Cancel and reissue {formatMoney(card.balance_cents)}
            </button>
            <button
              className="staff-button"
              disabled={!confirmVoid || voidNote.trim().length < 2 || busy}
              onClick={() => void onVoid(voidNote.trim(), false)}
            >
              Cancel without reissuing
            </button>
          </div>
        </>
      ) : (
        <p className="secure-note">This card is cancelled. Its balance was zeroed and its code no longer works.</p>
      )}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <label>
      {label}
      <input value={value} readOnly tabIndex={-1} />
    </label>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return <article className="stat-card"><span>{label}</span><strong>{value}</strong><small>{note}</small></article>;
}
