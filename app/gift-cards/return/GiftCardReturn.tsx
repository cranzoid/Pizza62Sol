"use client";

/**
 * Where Clover sends a gift card buyer back to.
 *
 * Two differences from `/order/return`, both worth stating because they look
 * like the same page and are not:
 *
 * - **The session id is read from the URL**, which is the right way round and
 *   is what `createCloverCheckout` sends as `{CHECKOUT_SESSION_ID}`. The
 *   localStorage stash is the fallback, for the case where a return URL
 *   configured in the Clover dashboard overrides ours and arrives without it.
 * - **Waiting here matters more.** After a food order the customer has their
 *   confirmation and the kitchen has the ticket; here, nothing exists yet — the
 *   card is minted by the webhook, on capture, and until that lands there is no
 *   gift card at all. So the page says plainly what it is waiting for rather
 *   than implying the present has been sent.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { UtilityHeader } from "@/app/UtilityHeader";
import { formatMoney } from "@/lib/domain";
import { trackEvent } from "@/lib/marketing";

type Pending = { sessionId?: string; reference?: string; amountCents?: number; recipientEmail?: string };
type Purchase = { reference: string; status: string; amountCents: number; recipientEmail: string; recipientName: string };

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 90_000;
const PENDING_STORAGE_KEY = "p62_pending_gift_card";

function readPending(): Pending | null {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(window.localStorage.getItem(PENDING_STORAGE_KEY) ?? "null") as Pending | null;
  } catch {
    return null;
  }
}

/** The URL first, the stash second — see the note at the top of this file. */
function readSessionId(): string {
  if (typeof window === "undefined") return "";
  const fromUrl = new URLSearchParams(window.location.search).get("session_id");
  // Clover substitutes `{CHECKOUT_SESSION_ID}` itself; an unsubstituted literal
  // means the dashboard's own return URL won and carries nothing useful.
  if (fromUrl && !fromUrl.includes("{")) return fromUrl;
  return readPending()?.sessionId ?? "";
}

function arrivedFromFailure(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("status") === "failed";
}

export default function GiftCardReturn() {
  const [pending] = useState(readPending);
  const [sessionId] = useState(readSessionId);
  const [purchase, setPurchase] = useState<Purchase | null>(null);
  const [state, setState] = useState<"waiting" | "paid" | "failed" | "timeout" | "unknown">(() =>
    arrivedFromFailure() ? "failed" : readSessionId() ? "waiting" : "unknown",
  );
  const startedAt = useRef<number | null>(null);
  const tracked = useRef(false);

  const poll = useCallback(async () => {
    if (!sessionId) return true;
    try {
      const response = await fetch(`/api/gift-cards/purchase?session=${encodeURIComponent(sessionId)}`);
      if (!response.ok) return false;
      const body = (await response.json()) as { purchase?: Purchase };
      if (!body.purchase) return false;
      setPurchase(body.purchase);
      if (body.purchase.status === "paid") {
        setState("paid");
        if (!tracked.current) {
          tracked.current = true;
          trackEvent("gift_card_purchased", {
            currency: "CAD",
            value: body.purchase.amountCents / 100,
            transactionId: body.purchase.reference,
          });
        }
        // Cleared only on a settled outcome, so closing the tab mid-poll does
        // not lose the buyer's own way back to this purchase.
        window.localStorage.removeItem(PENDING_STORAGE_KEY);
        window.localStorage.removeItem("p62_giftcard_idempotency");
        return true;
      }
      if (body.purchase.status === "failed" || body.purchase.status === "cancelled") {
        setState("failed");
        window.localStorage.removeItem(PENDING_STORAGE_KEY);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || state === "failed") return;
    let cancelled = false;
    startedAt.current ??= Date.now();
    const tick = async () => {
      if (cancelled) return;
      const settled = await poll();
      if (cancelled || settled) return;
      if (Date.now() - (startedAt.current ?? Date.now()) > POLL_TIMEOUT_MS) {
        setState("timeout");
        return;
      }
      window.setTimeout(tick, POLL_INTERVAL_MS);
    };
    void tick();
    return () => { cancelled = true; };
    // `state` guards entry only; polling must not restart when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, poll]);

  const amountCents = purchase?.amountCents ?? pending?.amountCents ?? 0;
  const recipient = purchase?.recipientEmail ?? pending?.recipientEmail ?? "";
  const reference = purchase?.reference ?? pending?.reference ?? "";

  return (
    <div className="utility-page">
      <a className="skip-link" href="#utility-content">Skip to content</a>
      <UtilityHeader />
      <main className="utility-content" id="utility-content">
        <div className="utility-title">
          <p className="eyebrow dark" style={{ justifyContent: "center" }}><span /> Gift card</p>
          {state === "paid" ? (
            <>
              <h1>{amountCents ? `${formatMoney(amountCents)} sent.` : "Sent."}</h1>
              <p>The card has been emailed{recipient ? <> to <strong>{recipient}</strong></> : null}.<br />Your receipt is on its way to you separately.</p>
            </>
          ) : null}
          {state === "waiting" ? (
            <>
              <h1>Confirming your payment…</h1>
              <p>Your card has gone through and we are waiting for the confirmation<br />to reach us. The gift card is emailed the moment it does.</p>
            </>
          ) : null}
          {state === "timeout" ? (
            <>
              <h1>Still confirming.</h1>
              <p>Your payment has not been confirmed to us yet. If your card was charged,<br />the gift card will be emailed shortly and your receipt with it.</p>
            </>
          ) : null}
          {state === "failed" ? (
            <>
              <h1>That payment did not go through.</h1>
              <p>Your card was not charged and no gift card was created.<br />You are welcome to try again with another card.</p>
            </>
          ) : null}
          {state === "unknown" ? (
            <>
              <h1>Checking on your gift card.</h1>
              <p>We could not recover this purchase from this browser — that happens if you<br />returned on a different device or cleared your browsing data.</p>
            </>
          ) : null}
        </div>

        <section className="lookup-card">
          {state === "paid" ? (
            <>
              {reference ? (
                <div className="confirmation-estimate">
                  <span>Reference</span>
                  <b>{reference}</b>
                </div>
              ) : null}
              <p className="utility-help">
                The card number went only to the recipient — your receipt does not carry it, so it is safe
                to forward. They can check the balance any time at{" "}
                <a href="/gift-cards/balance">pizza62.ca/gift-cards/balance</a>.
              </p>
            </>
          ) : state === "failed" ? (
            <p><a className="primary-button" href="/gift-cards">Try again</a></p>
          ) : (
            <p className="utility-help">
              You can close this page. The gift card and your receipt are emailed automatically once the
              payment is confirmed — nothing here needs to stay open.
            </p>
          )}
          <p className="utility-help">
            Need help? Call <a style={{ textDecoration: "underline", fontWeight: 900 }} href="tel:+19055475777">(905) 547-5777</a>
            {reference ? <> and quote {reference}.</> : "."}
          </p>
        </section>
      </main>
    </div>
  );
}
