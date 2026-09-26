"use client";

/**
 * The page behind the "Unsubscribe" link in a marketing email.
 *
 * It asks for one tap rather than acting on arrival: mail filters that scan
 * links fetch them before the customer ever sees the message, and a page that
 * unsubscribed on load would unsubscribe people who never clicked. See
 * lib/marketing-consent.ts.
 */
import { useState, useSyncExternalStore } from "react";
import { UtilityHeader } from "@/app/UtilityHeader";

const NEVER_CHANGES = () => () => {};
const readQuery = () => window.location.search;
const NO_QUERY = () => "";

function addressFrom(query: string): string {
  const encoded = new URLSearchParams(query).get("e") ?? "";
  try {
    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
    return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return "";
  }
}

export default function UnsubscribeForm() {
  const query = useSyncExternalStore(NEVER_CHANGES, readQuery, NO_QUERY);
  const [state, setState] = useState<"ready" | "working" | "done" | "error">("ready");
  const [message, setMessage] = useState("");
  const email = addressFrom(query);

  const unsubscribe = async () => {
    setState("working");
    const params = new URLSearchParams(query);
    const response = await fetch(
      `/api/marketing/unsubscribe?${new URLSearchParams({ e: params.get("e") ?? "", t: params.get("t") ?? "" })}`,
      { method: "POST" },
    ).catch(() => null);
    const result = (await response?.json().catch(() => null)) as { error?: string } | null;
    if (response?.ok) {
      setState("done");
    } else {
      setState("error");
      setMessage(result?.error ?? "We could not record that just now. Please try again, or call us at (905) 547-5777.");
    }
  };

  return (
    <div className="utility-page">
      <UtilityHeader />
      <main className="utility-content" id="utility-content">
        <div className="utility-title">
          <p className="eyebrow dark" style={{ justifyContent: "center" }}><span /> Email preferences</p>
          <h1>{state === "done" ? "You're unsubscribed." : "Unsubscribe from Pizza 62 emails?"}</h1>
          <p>
            {state === "done"
              ? "We won't send you any more offers or giveaway emails. You'll still get receipts for orders you place."
              : "You'll stop getting offers and giveaway news from us. Order receipts and pickup updates still arrive."}
          </p>
        </div>
        <article className="feedback-card policy-card" style={{ textAlign: "center" }}>
          {!email ? (
            <p>This link is incomplete. Please use the unsubscribe link from the email, or call us at (905) 547-5777.</p>
          ) : state === "done" ? (
            <p><strong>{email}</strong> has been removed from our marketing emails.</p>
          ) : (
            <>
              <p>Unsubscribe <strong>{email}</strong>?</p>
              <button className="primary-button" onClick={unsubscribe} disabled={state === "working"}>
                {state === "working" ? "Unsubscribing…" : "Unsubscribe"}
              </button>
              {state === "error" ? <p className="form-error" role="alert">{message}</p> : null}
            </>
          )}
        </article>
      </main>
    </div>
  );
}
