"use client";
/* eslint-disable @next/next/no-html-link-for-pages */

/**
 * The form a customer opens from the "how did we do?" email.
 *
 * ## Why five stars are treated differently, and why it stops where it does
 *
 * A customer who had a good night is, for about ten seconds, willing to say so
 * in public — and then the moment passes. So a five sends them straight to the
 * Google review page while they still mean it, with a thank-you and a couple of
 * seconds to read it rather than a jump they did not ask for.
 *
 * What is deliberately *not* done: hiding the review link from anyone else.
 * Showing the invitation only to happy customers is review gating — it breaks
 * Google's policy, and it buys a star average that means nothing, because a
 * rating nobody unhappy could contribute is not a measurement. Every rating gets
 * the same link on the same screen. Five just gets there faster.
 *
 * The thank-you coupon follows the same rule: it is emailed to everyone who
 * answered, and the screen says so regardless of the score. Paying for good
 * reviews is the thing that is wrong; thanking people for their time is not.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { UtilityHeader } from "@/app/UtilityHeader";

type Question = { id: string; label: string; type: "rating" | "text"; ratingScale: number | null; required: boolean };
type Reward = { offer: string; worth: string };
type FeedbackData = {
  order: { orderNumber: string; fulfilment: string };
  alreadySubmitted: boolean;
  googleReviewUrl: string | null;
  questions: Question[];
};

/** How long the thank-you stays on screen before Google opens. */
const REDIRECT_SECONDS = 4;

/** The score that earns the automatic hand-off to Google. */
const DELIGHTED = 5;

const RATING_WORDS = ["", "Poor", "Not great", "Fine", "Good", "Great"];

function initialFeedbackParams() {
  // H-15: same as tracking. The link has to carry the token; the address bar
  // does not have to keep it afterwards.
  if (typeof window === "undefined") return { order: "", token: "" };
  const params = new URLSearchParams(window.location.search);
  const order = params.get("order") ?? "";
  const token = params.get("token") ?? "";
  if (token) {
    const url = new URL(window.location.href);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", url.toString());
  }
  return { order, token };
}

function track(eventName: string, context: Record<string, unknown> = {}) {
  void fetch("/api/analytics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventName, context }),
  }).catch(() => undefined);
}

export default function FeedbackApp() {
  const [initial] = useState(initialFeedbackParams);
  const orderNumber = initial.order;
  const token = initial.token;
  // A link with no token cannot be looked up, and that is knowable on the first
  // render — so it is the starting state rather than something an effect sets,
  // which would cost a second render to say what we already knew.
  const linked = Boolean(orderNumber && token);
  const [data, setData] = useState<FeedbackData | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [comments, setComments] = useState("");
  const [error, setError] = useState(linked ? "" : "Use the secure feedback link connected to your order.");
  const [submitted, setSubmitted] = useState(false);
  const [reward, setReward] = useState<Reward | null>(null);
  const [busy, setBusy] = useState(linked);

  const overall = answers.overall;

  useEffect(() => {
    if (!linked) return;
    fetch(`/api/feedback?order=${encodeURIComponent(orderNumber)}`, { headers: { "x-tracking-token": token } })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
        setData(body);
        if (body.alreadySubmitted) setSubmitted(true);
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Feedback link is unavailable."))
      .finally(() => setBusy(false));
  }, [linked, orderNumber, token]);

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderNumber, token, answers, writtenFeedback: comments }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setSubmitted(true);
      setReward(body.reward ?? null);
      if (data) setData({ ...data, googleReviewUrl: body.googleReviewUrl });
      track("feedback_submitted", { rating: overall });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Feedback could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const reviewUrl = data?.googleReviewUrl ?? null;
  const ratingQuestions = data?.questions.filter((question) => question.type === "rating") ?? [];

  return (
    <div className="utility-page">
      <a className="skip-link" href="#utility-content">Skip to content</a>
      <UtilityHeader />
      <main className="utility-content" id="utility-content">
        <div className="utility-title">
          <p className="eyebrow dark" style={{ justifyContent: "center" }}><span /> Straight to the Pizza 62 team</p>
          <h1>How did we do?</h1>
          <p>Your feedback helps us make the next order even better.</p>
        </div>

        {busy && !data ? (
          <div className="lookup-card" role="status">Opening your secure feedback form…</div>
        ) : error && !data ? (
          <div className="lookup-card form-error" role="alert">{error}</div>
        ) : submitted ? (
          <ThankYou rating={overall} reviewUrl={reviewUrl} reward={reward} />
        ) : data ? (
          <section className="feedback-card">
            <p className="eyebrow dark"><span /> Order {data.order.orderNumber}</p>
            {ratingQuestions.map((question) => (
              <RatingRow
                key={question.id}
                question={question}
                value={answers[question.id]}
                onChange={(rating) => setAnswers((current) => ({ ...current, [question.id]: rating }))}
              />
            ))}
            <label className="feedback-comments">
              Written feedback
              <textarea
                rows={6}
                maxLength={2000}
                value={comments}
                onChange={(event) => setComments(event.target.value)}
                placeholder="Tell us what stood out—or what we can improve."
              />
            </label>
            {error ? <div className="form-error" role="alert">{error}</div> : null}
            <button className="primary-button" disabled={busy || !overall} onClick={() => void submit()}>
              {busy ? "Saving…" : "Send feedback"}
            </button>
            <p className="feedback-alert-note">Ratings of 1 or 2 create an immediate owner alert in the notification queue.</p>
          </section>
        ) : null}
      </main>
    </div>
  );
}

function RatingRow({
  question,
  value,
  onChange,
}: {
  question: Question;
  value: number | undefined;
  onChange: (rating: number) => void;
}) {
  const scale = question.ratingScale ?? 5;
  return (
    <div className="feedback-question">
      <h3>{question.label}{question.required ? " *" : ""}</h3>
      <div className="rating-row" role="radiogroup" aria-label={question.label}>
        {Array.from({ length: scale }, (_, index) => index + 1).map((rating) => (
          <button
            type="button"
            role="radio"
            aria-checked={value === rating}
            // Screen readers get the words; a bare "3" out of context says nothing.
            aria-label={scale === 5 ? `${rating} — ${RATING_WORDS[rating]}` : String(rating)}
            className={value === rating ? "active" : ""}
            key={rating}
            onClick={() => onChange(rating)}
          >
            {rating}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The screen after Send, in three variants that share one review link.
 *
 * A five is walked to Google on a visible timer it can stop. Anything else is
 * thanked, told what happens next, and offered the same link without a countdown
 * — pushing someone who just told us the pizza was cold towards a public review
 * form is tone-deaf, and it is the offering, not the pushing, that keeps this
 * the same invitation for everybody.
 */
function ThankYou({ rating, reviewUrl, reward }: { rating: number | undefined; reviewUrl: string | null; reward: Reward | null }) {
  const delighted = rating === DELIGHTED && Boolean(reviewUrl);
  const [secondsLeft, setSecondsLeft] = useState(REDIRECT_SECONDS);
  const [cancelled, setCancelled] = useState(false);
  // Survives the re-renders the countdown causes, so a slow redirect cannot be
  // started twice.
  const sent = useRef(false);

  const openReview = useCallback(
    (automatic: boolean) => {
      if (!reviewUrl || sent.current) return;
      sent.current = true;
      track("google_review_clicked", { rating, automatic });
      window.location.href = reviewUrl;
    },
    [rating, reviewUrl],
  );

  useEffect(() => {
    if (!delighted || cancelled) return;
    const timer = window.setInterval(() => {
      setSecondsLeft((current) => {
        if (current <= 1) {
          window.clearInterval(timer);
          openReview(true);
          return 0;
        }
        return current - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [delighted, cancelled, openReview]);

  return (
    <section className="feedback-card feedback-card--centered">
      <div className="confirmation-check">✓</div>
      <h2 className="feedback-thanks">{delighted ? "Five stars. Thank you." : "Thanks for telling us."}</h2>
      <p className="feedback-thanks-copy">
        {delighted
          ? "That genuinely makes someone's shift. Would you say it where the next customer can see it?"
          : "Your feedback is saved for the Pizza 62 team, and someone here reads every one."}
      </p>

      {reward ? (
        <div className="review-cta review-cta--reward">
          <h3>Have {reward.offer} on us</h3>
          <p>We are emailing you a code worth {reward.worth} on your next order. Give it a minute to arrive.</p>
        </div>
      ) : null}

      <div className="review-cta">
        {delighted ? (
          <>
            <h3>Taking you to Google</h3>
            <p aria-live="polite">
              {cancelled
                ? "Stopped — the link is still here whenever you want it."
                : secondsLeft > 0
                  ? `Opening the review page in ${secondsLeft} second${secondsLeft === 1 ? "" : "s"}…`
                  : "Opening the review page…"}
            </p>
            <a href={reviewUrl ?? "#"} onClick={() => openReview(false)}>Leave a Google review now ↗</a>
            {!cancelled && secondsLeft > 0 ? (
              <button type="button" className="text-button" onClick={() => setCancelled(true)}>No thanks, stay here</button>
            ) : null}
          </>
        ) : (
          <>
            <h3>Share your experience on Google</h3>
            <p>Every customer receives the same review invitation, whatever their rating.</p>
            {reviewUrl ? (
              <a href={reviewUrl} target="_blank" rel="noreferrer" onClick={() => track("google_review_clicked", { rating, automatic: false })}>
                Leave a Google review ↗
              </a>
            ) : (
              <p><strong>The owner is still configuring the direct review link.</strong></p>
            )}
          </>
        )}
      </div>
      <a className="text-button" href="/">Back to Pizza 62</a>
    </section>
  );
}
