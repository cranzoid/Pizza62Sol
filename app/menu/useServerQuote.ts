"use client";

import { useCallback, useEffect, useState } from "react";

/** A response is authoritative only for the exact input and catalog revision requested. */
export function useServerQuote<T>(url: string, body: string | null, revision = "") {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  // `input` is what was priced; `key` adds the refresh count. Only a change of
  // input makes the old answer wrong. A background refresh (the minute timer,
  // or the window regaining focus) keeps showing the last answer until the new
  // one lands. Dropping it to null made the checkout unmount Clover's card form,
  // and the window regains focus every time a customer clicks out of a card
  // field, so typed card details were wiped on the way to "Place order".
  const input = JSON.stringify([url, body, revision]);
  const key = JSON.stringify([input, attempt]);
  const enabled = Boolean(body);
  const [result, setResult] = useState<{ key: string; input: string; quote: T | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!body) return;
    const controller = new AbortController();
    let timeout: number | undefined;
    const timer = window.setTimeout(() => {
      timeout = window.setTimeout(() => {
        controller.abort();
        setResult({ key, input, quote: null, error: "Pricing timed out. Please retry." });
      }, 15_000);
      void (async () => {
        try {
          const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: controller.signal, cache: "no-store" });
          const quote = await response.json();
          if (!response.ok) throw new Error(quote.error ?? "Unable to price this order.");
          if (typeof quote.ok !== "boolean" || !Array.isArray(quote.lines) || !Array.isArray(quote.issues) ||
            !quote.totals || !Number.isSafeInteger(quote.totals.amountDueCents) || quote.totals.amountDueCents < 0) {
            throw new Error("The price response was incomplete. Please retry.");
          }
          if (!controller.signal.aborted) setResult({ key, input, quote: quote as T, error: null });
        } catch (error) {
          if (!controller.signal.aborted) setResult({ key, input, quote: null, error: error instanceof Error ? error.message : "Unable to price this order." });
        } finally { window.clearTimeout(timeout); }
      })();
    }, 150);
    return () => { controller.abort(); window.clearTimeout(timer); window.clearTimeout(timeout); };
  }, [url, body, key, input]);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(retry, 60_000);
    window.addEventListener("focus", retry);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", retry); };
  }, [enabled, retry]);
  const fresh = body && result?.key === key ? result : null;
  const current = fresh ?? (body && result?.input === input && result.quote ? result : null);
  // Not "loading" during a background refresh either: the focus event fires on
  // the mousedown of a click on "Place order", and disabling the button
  // between mousedown and mouseup swallows the click.
  return { quote: current?.quote ?? null, loading: Boolean(body && !current), failed: Boolean(current?.error), error: current?.error ?? null, retry };
}
