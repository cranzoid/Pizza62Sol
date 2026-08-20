"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Where Clover sends the customer back to after a hosted checkout.
 *
 * This page exists because of one property of Clover: **the return URL is
 * configured once per merchant in the Clover dashboard, not per session.** It is
 * the same static URL for every order, so it cannot carry `?order=…&token=…` the
 * way the Stripe success URL did, and the customer arrives here with nothing
 * identifying their order.
 *
 * So the browser stashes the order number and tracking token in `localStorage`
 * immediately before leaving for Clover, and this page picks them back up. That
 * is a same-device, same-browser recovery and nothing more — if it fails, the
 * confirmation email is the durable copy and the manual lookup on /track still
 * works. It is never the only way a customer can reach their order.
 *
 * The second thing this page handles is that **payment confirmation is
 * asynchronous.** The customer returns from Clover the moment the card clears,
 * which may be before Clover's webhook has reached us. Showing "we have no
 * record of your payment" in that window would be alarming and wrong, so the
 * page polls the tracking endpoint until the order leaves `awaiting_payment`,
 * and says plainly what it is waiting for.
 */

type Pending = { orderNumber?: string; trackingToken?: string; feedbackToken?: string };

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 90_000;

function readPending(): Pending | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem("p62_pending_order");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Pending;
    return parsed.orderNumber && parsed.trackingToken ? parsed : null;
  } catch {
    return null;
  }
}

function Header() {
  return <header className="utility-header"><a className="brand" href="/"><span className="pizza-mark"><span>62</span><i className="pizza-dot pizza-dot--one" /></span><span className="brand-copy"><strong>Pizza 62</strong><small>Hamilton, Ontario</small></span></a><a href="/">Back to menu ↗</a></header>;
}

export default function OrderReturn() {
  const [pending] = useState(readPending);
  const [state, setState] = useState<"waiting" | "paid" | "cancelled" | "timeout" | "unknown">(
    () => (readPending() ? "waiting" : "unknown"),
  );
  // Seeded in the effect rather than at render: reading the clock during render
  // is impure, and the deadline only has to start when polling does.
  const startedAt = useRef<number | null>(null);

  const trackingUrl = pending
    ? `/track?order=${encodeURIComponent(pending.orderNumber ?? "")}&token=${encodeURIComponent(pending.trackingToken ?? "")}`
    : null;

  const poll = useCallback(async () => {
    if (!pending?.orderNumber || !pending.trackingToken) return true;
    try {
      const response = await fetch(
        `/api/orders/track?order=${encodeURIComponent(pending.orderNumber)}&token=${encodeURIComponent(pending.trackingToken)}`,
      );
      if (!response.ok) return false;
      const body = await response.json() as { order?: { status?: string; paymentStatus?: string } };
      const status = body.order?.status;
      if (status === "cancelled") { setState("cancelled"); return true; }
      if (status && status !== "awaiting_payment") {
        setState("paid");
        // Only cleared on a settled outcome. Clearing on arrival would lose the
        // customer's own route back to their order if this tab is closed mid-poll.
        window.localStorage.removeItem("p62_pending_order");
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    startedAt.current ??= Date.now();
    const tick = async () => {
      if (cancelled) return;
      const settled = await poll();
      if (cancelled || settled) return;
      if (Date.now() - (startedAt.current ?? Date.now()) > POLL_TIMEOUT_MS) { setState("timeout"); return; }
      window.setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();
    return () => { cancelled = true; };
  }, [pending, poll]);

  return <div className="utility-page"><Header /><main className="utility-content">
    <div className="utility-title">
      <p className="eyebrow dark" style={{ justifyContent: "center" }}><span /> Online payment</p>
      {state === "paid" ? <>
        <h1>Thank you — your order is in.</h1>
        <p>Pizza 62 has your order and the kitchen has been notified.<br />A confirmation email is on its way.</p>
      </> : null}
      {state === "waiting" ? <>
        <h1>Confirming your payment…</h1>
        <p>Your card has gone through and we are waiting for the payment<br />confirmation to reach us. This usually takes a few seconds.</p>
      </> : null}
      {state === "timeout" ? <>
        <h1>Still confirming.</h1>
        <p>Your payment has not been confirmed to us yet. If your card was charged,<br />the order will appear shortly and you will get a confirmation email.</p>
      </> : null}
      {state === "cancelled" ? <>
        <h1>This order was cancelled.</h1>
        <p>The checkout was not completed in time and no payment was taken.<br />You are welcome to order again.</p>
      </> : null}
      {state === "unknown" ? <>
        <h1>Checking on your order.</h1>
        <p>We could not recover this order&apos;s details from this browser — that happens<br />if you returned on a different device or cleared your browsing data.</p>
      </> : null}
    </div>
    <section className="lookup-card">
      {trackingUrl && state !== "cancelled"
        ? <p><a className="primary-button" href={trackingUrl}>Track this order</a></p>
        : <p>Your confirmation email carries the tracking link. You can also <a href="/track"><strong>look the order up</strong></a> with its number and tracking token.</p>}
      <p style={{ color: "var(--muted)", fontSize: 10, marginTop: 24 }}>
        Need help? Call <a style={{ textDecoration: "underline", fontWeight: 900 }} href="tel:+19055475777">(905) 547-5777</a>.
      </p>
    </section>
  </main></div>;
}
