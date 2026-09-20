"use client";

/**
 * Buying a gift card.
 *
 * ## Why this is its own checkout
 *
 * A gift card is not food. It has no fulfilment, no address, no schedule, no
 * HST, no tip and no kitchen ticket, and mixing it into the ordinary cart would
 * mean teaching every one of those things to ignore it. It is also bought in a
 * different frame of mind — the person filling this in is thinking about who it
 * is for, not about dinner — so the page is built around that: the amount, the
 * two people, the message, and a live picture of what will land in the inbox.
 *
 * ## The preview is the product
 *
 * The card face on the right is drawn from the same tokens and the same layout
 * as the email in `lib/notifications/email-template.ts`. That is deliberate and
 * worth keeping in step: the buyer is paying for something they will never see,
 * and the only reassurance available is showing them, before they pay, the thing
 * the recipient is going to open.
 *
 * ## Everything that matters is decided on the server
 *
 * The amount is re-parsed and re-bounded in `validateGiftCardPurchase`, the card
 * is minted only on confirmed capture, and the code never exists in this
 * browser. What is here is a form and a picture.
 */

import { useState } from "react";
import { UtilityHeader } from "@/app/UtilityHeader";
import { formatMoney } from "@/lib/domain";
import {
  GIFT_CARD_MAX_CENTS,
  GIFT_CARD_MESSAGE_MAX,
  GIFT_CARD_MIN_CENTS,
  GIFT_CARD_PRESET_CENTS,
  giftCardAmountError,
  parseGiftCardAmountCents,
} from "@/lib/gift-cards";
// Campaign capture already ran in the root layout (see app/MarketingTags.tsx),
// so this only reads what that stored and sends it with the purchase.
import { orderAttribution, trackEvent } from "@/lib/marketing";
import { CloverCardForm, type CloverCardFormHandle } from "@/app/customer/CloverCardForm";

export type GiftCardPurchaseProps = {
  available: boolean;
  cardForm: { enabled: boolean; publicToken?: string; merchantId?: string; sandbox?: boolean };
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Survives a refresh and a double tap, exactly as the order checkout's does. */
const IDEMPOTENCY_STORAGE_KEY = "p62_giftcard_idempotency";
const PENDING_STORAGE_KEY = "p62_pending_gift_card";

function freshKey(): string {
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`;
}

export default function GiftCardPurchase({ available, cardForm }: GiftCardPurchaseProps) {
  const [amountCents, setAmountCents] = useState<number>(GIFT_CARD_PRESET_CENTS[0]);
  const [customAmount, setCustomAmount] = useState("");
  const [custom, setCustom] = useState(false);
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [senderName, setSenderName] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<{ reference: string; recipientEmail: string; amountCents: number } | null>(null);
  const [handle, setHandle] = useState<CloverCardFormHandle | null>(null);
  const [cardFormBlocked, setCardFormBlocked] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => {
    if (typeof window === "undefined") return freshKey();
    const existing = window.localStorage.getItem(IDEMPOTENCY_STORAGE_KEY);
    if (existing) return existing;
    const generated = freshKey();
    window.localStorage.setItem(IDEMPOTENCY_STORAGE_KEY, generated);
    return generated;
  });

  const inlineCard = Boolean(cardForm.enabled && cardForm.publicToken) && !cardFormBlocked;

  // The chosen amount, resolved the same way the server will resolve it — the
  // preview must never show a figure the server would refuse.
  const chosenCents = custom ? parseGiftCardAmountCents(customAmount) : amountCents;
  const amountError = custom && customAmount.trim() ? giftCardAmountError(chosenCents) : null;
  const payable = chosenCents !== null && !giftCardAmountError(chosenCents);

  const complete =
    payable &&
    recipientName.trim().length > 1 &&
    EMAIL.test(recipientEmail.trim()) &&
    senderName.trim().length > 1 &&
    EMAIL.test(buyerEmail.trim());

  const submit = async () => {
    if (!complete || chosenCents === null) return;
    setSubmitting(true);
    setError("");
    try {
      // The card is tokenised before anything is created, so a mistyped number
      // fails with the form still on screen and no purchase row behind it.
      let paymentToken: string | undefined;
      if (handle) {
        try {
          paymentToken = await handle.tokenize();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "Please check the card details.");
          setSubmitting(false);
          return;
        }
      }
      const response = await fetch("/api/gift-cards/purchase", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey,
          amountCents: chosenCents,
          buyer: { name: senderName, email: buyerEmail },
          recipient: { name: recipientName, email: recipientEmail },
          message,
          paymentToken,
          attribution: orderAttribution(),
        }),
      });
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        // A confirmed decline is the only outcome that earns a fresh key: an
        // ambiguous failure might have taken the money, and retrying under a new
        // key would be a second charge. Same rule as the order checkout.
        if (response.status === 402 && result.code === "PAYMENT_DECLINED") {
          const next = freshKey();
          window.localStorage.setItem(IDEMPOTENCY_STORAGE_KEY, next);
          setIdempotencyKey(next);
        }
        throw new Error(String(result.error ?? "That gift card could not be purchased."));
      }
      if (typeof result.checkoutUrl === "string") {
        // Clover's hosted page. The session id is stashed so the return page can
        // find this purchase again — the same recovery the food-order return
        // does, and equally a best-effort one: the buyer's receipt is the
        // durable record if this browser loses it.
        window.localStorage.setItem(
          PENDING_STORAGE_KEY,
          JSON.stringify({
            sessionId: result.sessionId,
            reference: result.reference,
            amountCents: chosenCents,
            recipientEmail: recipientEmail.trim(),
            startedAt: Date.now(),
          }),
        );
        window.location.assign(result.checkoutUrl);
        return;
      }
      window.localStorage.removeItem(IDEMPOTENCY_STORAGE_KEY);
      // Real revenue, and the `GC-` prefix keeps it separable from food orders
      // in whatever the ad platforms report back.
      trackEvent("gift_card_purchased", {
        currency: "CAD",
        value: chosenCents / 100,
        transactionId: String(result.reference ?? ""),
      });
      setSent({
        reference: String(result.reference ?? ""),
        recipientEmail: recipientEmail.trim(),
        amountCents: chosenCents,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That gift card could not be purchased.");
      setSubmitting(false);
    }
  };

  return (
    <div className="utility-page">
      <a className="skip-link" href="#utility-content">Skip to content</a>
      <UtilityHeader />
      <main className="utility-content" id="utility-content">
        <div className="utility-title">
          <p className="eyebrow dark" style={{ justifyContent: "center" }}><span /> A Pizza 62 gift card</p>
          <h1>{sent ? "On its way." : "A gift that hits the spot."}</h1>
          <p>
            {sent ? (
              "The card has been emailed. Nothing else to do."
            ) : (
              "Choose an amount, add a message, and we’ll email it straight to them."
            )}
          </p>
        </div>

        {sent ? (
          <Delivered sent={sent} />
        ) : !available ? (
          <section className="lookup-card" role="status">
            <strong>Gift cards are not on sale at the moment.</strong>
            <p className="utility-help">
              Card payment is being set up. Please call{" "}
              <a href="tel:+19055475777">(905) 547-5777</a> — we can take a gift card over the phone.
            </p>
          </section>
        ) : (
          <div className="giftcard-layout">
            <div className="giftcard-form">
              <section className="giftcard-step">
                <h2><i>1</i> Choose an amount</h2>
                <p className="giftcard-step__hint">From {formatMoney(GIFT_CARD_MIN_CENTS)} to {formatMoney(GIFT_CARD_MAX_CENTS)}.</p>
                <div className="giftcard-amounts">
                  {GIFT_CARD_PRESET_CENTS.map((preset) => (
                    <button
                      type="button"
                      key={preset}
                      aria-pressed={!custom && amountCents === preset}
                      className={!custom && amountCents === preset ? "active" : ""}
                      onClick={() => { setCustom(false); setAmountCents(preset); }}
                    >
                      {formatMoney(preset)}
                    </button>
                  ))}
                </div>
                <label className="giftcard-custom">
                  Or another amount · C$
                  <input
                    inputMode="decimal"
                    value={customAmount}
                    placeholder="40.00"
                    aria-label="Another amount in Canadian dollars"
                    onChange={(event) => { setCustom(true); setCustomAmount(event.target.value); }}
                    onFocus={() => setCustom(true)}
                  />
                </label>
                {amountError ? <p className="coupon-bad" role="status">{amountError}</p> : null}
              </section>

              <section className="giftcard-step">
                <h2><i>2</i> Who is it for?</h2>
                <p className="giftcard-step__hint">We’ll email the gift card directly to this address.</p>
                <div className="giftcard-fields">
                  <label>
                    Their name
                    <input value={recipientName} onChange={(event) => setRecipientName(event.target.value)} autoComplete="off" maxLength={80} />
                  </label>
                  <label>
                    Their email
                    <input type="email" inputMode="email" value={recipientEmail} onChange={(event) => setRecipientEmail(event.target.value)} autoComplete="off" maxLength={200} />
                  </label>
                </div>
              </section>

              <section className="giftcard-step">
                <h2><i>3</i> From you</h2>
                <p className="giftcard-step__hint">Your name goes on the gift. We’ll send the receipt to your email.</p>
                <div className="giftcard-fields">
                  <label>
                    Your name
                    <input value={senderName} onChange={(event) => setSenderName(event.target.value)} autoComplete="name" maxLength={80} />
                  </label>
                  <label>
                    Your email
                    <input type="email" inputMode="email" value={buyerEmail} onChange={(event) => setBuyerEmail(event.target.value)} autoComplete="email" maxLength={200} />
                  </label>
                </div>
                <label className="giftcard-message">
                  <span className="giftcard-label-text">Add a message <small>Optional</small></span>
                  <textarea
                    rows={4}
                    maxLength={GIFT_CARD_MESSAGE_MAX}
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="Happy birthday — dinner is on me."
                  />
                  <span className="giftcard-counter" data-full={message.length >= GIFT_CARD_MESSAGE_MAX}>
                    {message.length} / {GIFT_CARD_MESSAGE_MAX}
                  </span>
                </label>
              </section>

              {inlineCard && cardForm.publicToken ? (
                <section className="giftcard-step">
                  <h2><i>4</i> Pay by card</h2>
                  <CloverCardForm
                    publicToken={cardForm.publicToken}
                    merchantId={cardForm.merchantId}
                    sandbox={Boolean(cardForm.sandbox)}
                    onReady={setHandle}
                    onUnavailable={(reason) => {
                      // Silent to the buyer — they get a working payment page
                      // either way — but logged, because a silently blocked card
                      // form is indistinguishable from Clover "taking over".
                      console.error("[gift cards] inline card form unavailable, falling back to Clover:", reason);
                      trackEvent("card_form_unavailable", { reason, surface: "gift_cards" });
                      setCardFormBlocked(true);
                      setHandle(null);
                    }}
                  />
                </section>
              ) : null}
            </div>

            <aside className="giftcard-aside">
              <CardFace
                amountCents={payable && chosenCents !== null ? chosenCents : 0}
                recipient={recipientName.trim()}
                sender={senderName.trim()}
                message={message.trim()}
              />
              <div className="giftcard-summary">
                <div>
                  <span>Gift card</span>
                  <span>{payable && chosenCents !== null ? formatMoney(chosenCents) : "—"}</span>
                </div>
                {/* No HST line, and it is not an oversight: buying a gift card
                    is not a taxable supply in Canada. The tax is charged in full
                    when the card is spent, on the food. */}
                <div>
                  <span>Total today</span>
                  <b>{payable && chosenCents !== null ? formatMoney(chosenCents) : formatMoney(0)}</b>
                </div>
                {error ? <div className="form-error" role="alert">{error}</div> : null}
                <button className="primary-button" disabled={!complete || submitting} onClick={() => void submit()}>
                  {submitting
                    ? "Sending…"
                    : `Pay ${payable && chosenCents !== null ? formatMoney(chosenCents) : ""}`}
                </button>
                {!complete ? (
                  <small>Fill in the amount, who it is for and who it is from to continue.</small>
                ) : (
                  <small>
                    {inlineCard
                      ? "Card details go straight to Clover and never reach this site."
                      : "You will pay on Clover's secure page, then come straight back."}
                  </small>
                )}
              </div>
            </aside>
          </div>
        )}

        {!sent && available ? (
          <details className="giftcard-terms">
            <summary>Gift card details</summary>
            <div>
              <p>Use it online or at the counter, over as many visits as needed. Any remaining balance stays on the card.</p>
              <p>Treat the code like cash. If it is lost, call us and we can cancel it and reissue the available balance.</p>
              <p>Gift cards cannot be reloaded or redeemed for cash, and purchases are final once the card is sent. HST is charged on the food when the gift card is used.</p>
            </div>
          </details>
        ) : null}
      </main>
    </div>
  );
}

/**
 * The card face, as the recipient will see it.
 *
 * The code is shown as a masked placeholder rather than a fake one. A plausible
 * dummy code is the kind of detail somebody writes down.
 */
function CardFace({
  amountCents,
  recipient,
  sender,
  message,
}: {
  amountCents: number;
  recipient: string;
  sender: string;
  message: string;
}) {
  return (
    <div className="giftcard-face">
      <div className="giftcard-face__top">
        <div className="giftcard-face__brand">Pizza 62 Gift Card</div>
        <div className="giftcard-face__amount">{amountCents > 0 ? formatMoney(amountCents) : "$—"}</div>
        <div className="giftcard-face__rule" />
        <div className="giftcard-face__for">For <b>{recipient || "your recipient"}</b></div>
        <div className="giftcard-face__from">from {sender || "you"}</div>
      </div>
      {message ? <div className="giftcard-face__note">&ldquo;{message}&rdquo;</div> : null}
      <div className="giftcard-face__code">
        <span>Gift card code</span>
        <b data-placeholder="true">P62-••••-••••-••••-••••</b>
      </div>
    </div>
  );
}

/** After the money has cleared and the card is in the outbox. */
function Delivered({ sent }: { sent: { reference: string; recipientEmail: string; amountCents: number } }) {
  return (
    <section className="feedback-card feedback-card--centered">
      <div className="confirmation-check">✓</div>
      <h2 className="feedback-thanks">{formatMoney(sent.amountCents)} sent.</h2>
      <p className="feedback-thanks-copy">
        The card is on its way to <strong>{sent.recipientEmail}</strong>. Your receipt is coming to you
        separately — without the card number on it, so it is safe to forward.
      </p>
      <div className="confirmation-estimate">
        <span>Reference</span>
        <b>{sent.reference}</b>
      </div>
      <p className="utility-help">
        If it has not arrived in a few minutes, ask them to check their junk folder, then call us on{" "}
        <a href="tel:+19055475777">(905) 547-5777</a> and quote that reference.
      </p>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a className="text-button" href="/">Back to Pizza 62</a>
    </section>
  );
}
