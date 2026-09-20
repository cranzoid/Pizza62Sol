"use client";

/**
 * "How much is left on my card?"
 *
 * One field, one answer. The whole design decision here is the one that is
 * invisible: **the code is submitted in a POST body, never in the URL.** A gift
 * card code is money, and a `?code=` would put it in browser history, in the
 * `Referer` header of every asset this page loads, and in any access log
 * between here and the server. It is also why the delivery email sends the
 * recipient here to paste a code rather than giving them a one-tap link that
 * carries it — the extra paste is what keeps the money out of URLs.
 *
 * `noindex`, because a page whose entire content is "type your card number
 * here" has no business in a search result.
 */

import { useState } from "react";
import { UtilityHeader } from "@/app/UtilityHeader";
import { formatMoney } from "@/lib/domain";
import { normalizeGiftCardCode } from "@/lib/gift-cards";

type Balance = {
  suffix: string;
  balanceCents: number;
  expiresAt: number | null;
  usable: boolean;
  message: string | null;
};

export default function GiftCardBalance() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [balance, setBalance] = useState<Balance | null>(null);

  // Checked in the browser too, so an obvious typo costs a keystroke rather than
  // one of the twenty attempts the rate limiter allows.
  const looksLikeACode = normalizeGiftCardCode(code) !== null;

  const check = async () => {
    setBusy(true);
    setError("");
    setBalance(null);
    try {
      const response = await fetch("/api/gift-cards/balance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = (await response.json()) as { card?: Balance; error?: string };
      if (!response.ok || !body.card) throw new Error(body.error ?? "We could not check that balance.");
      setBalance(body.card);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "We could not check that balance.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="utility-page">
      <a className="skip-link" href="#utility-content">Skip to content</a>
      <UtilityHeader />
      <main className="utility-content" id="utility-content">
        <div className="utility-title">
          <p className="eyebrow dark" style={{ justifyContent: "center" }}><span /> Pizza 62 gift card</p>
          <h1>Check your balance.</h1>
          <p>Paste the code from your gift card email.<br />Nothing is charged and nothing is used up.</p>
        </div>

        <section className="lookup-card">
          <form
            className="giftcard-balance-form"
            onSubmit={(event) => { event.preventDefault(); void check(); }}
          >
            <label>
              Gift card code
              <input
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="P62-ABCD-EFGH-JKLM-NPQR"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-describedby="giftcard-balance-help"
              />
            </label>
            <button className="primary-button" disabled={busy || !looksLikeACode}>
              {busy ? "Checking…" : "Check balance"}
            </button>
          </form>

          {error ? <div className="form-error" role="alert" style={{ marginTop: 14 }}>{error}</div> : null}

          {balance ? (
            <div style={{ marginTop: 20 }}>
              <div className="giftcard-balance-result" role="status">
                <span>Available balance</span>
                <b>{formatMoney(balance.balanceCents)}</b>
                <small>Card ending {balance.suffix}</small>
              </div>
              <p className="utility-help" style={{ textAlign: "center" }}>
                {balance.usable ? (
                  <>
                    {/* The truth, stated rather than implied. Ontario's Consumer
                        Protection Act forbids an expiry on a purchased card, and
                        everyone has been trained by every other gift card to
                        assume the opposite. */}
                    <strong>{balance.expiresAt ? `Expires ${new Date(balance.expiresAt).toLocaleDateString("en-CA", { day: "numeric", month: "long", year: "numeric" })}` : "No expiry date. No fees."}</strong>
                    <br />
                    Spend it at the checkout, or read the code out at the counter.
                  </>
                ) : (
                  balance.message
                )}
              </p>
            </div>
          ) : null}

          <p className="utility-help" id="giftcard-balance-help">
            Your code is in the &ldquo;sent you a Pizza 62 gift card&rdquo; email. We store it only in a
            scrambled form and cannot read it back, so we cannot resend it — if it is lost, call{" "}
            <a href="tel:+19055475777">(905) 547-5777</a> and we will cancel that card and reissue
            whatever is left on it.
          </p>
        </section>
      </main>
    </div>
  );
}
