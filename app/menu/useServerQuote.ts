"use client";

import { useCallback, useEffect, useState } from "react";

/** A response is authoritative only for the exact input and catalog revision requested. */
export function useServerQuote<T>(url: string, body: string | null, revision = "") {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);
  const key = JSON.stringify([url, body, revision, attempt]);
  const enabled = Boolean(body);
  const [result, setResult] = useState<{ key: string; quote: T | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!body) return;
    const controller = new AbortController();
    let timeout: number | undefined;
    const timer = window.setTimeout(() => {
      timeout = window.setTimeout(() => {
        controller.abort();
        setResult({ key, quote: null, error: "Pricing timed out. Please retry." });
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
          if (!controller.signal.aborted) setResult({ key, quote: quote as T, error: null });
        } catch (error) {
          if (!controller.signal.aborted) setResult({ key, quote: null, error: error instanceof Error ? error.message : "Unable to price this order." });
        } finally { window.clearTimeout(timeout); }
      })();
    }, 150);
    return () => { controller.abort(); window.clearTimeout(timer); window.clearTimeout(timeout); };
  }, [url, body, key]);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(retry, 60_000);
    window.addEventListener("focus", retry);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", retry); };
  }, [enabled, retry]);
  const current = body && result?.key === key ? result : null;
  return { quote: current?.quote ?? null, loading: Boolean(body && !current), failed: Boolean(current?.error), error: current?.error ?? null, retry };
}
