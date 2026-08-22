"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Clover's card fields, mounted inline on our own checkout.
 *
 * The card number never reaches this component or our server. Each field below
 * is an iframe served by Clover into a container we provide, so what we hold is
 * a layout and a callback; what Clover hands back is a single-use token that the
 * server charges. That split is the whole reason this is worth the code — it
 * keeps card data out of our PCI scope while keeping the customer on our page.
 *
 * Three things this has to get right, all of them failure modes rather than
 * features:
 *
 * - **The SDK may never load.** Ad and tracker blockers block payment iframes
 *   fairly often. `onUnavailable` fires so the checkout can fall back to Clover's
 *   hosted page rather than showing a form that will never work.
 * - **The mount must survive React.** Clover writes into these containers itself,
 *   so they are rendered once and never re-keyed, and the SDK is torn down on
 *   unmount to avoid orphaned iframes when the modal closes.
 * - **Tokenising can fail without the card being wrong** — an incomplete field,
 *   a network blip. Those surface as a message on the form, not as a decline.
 */

type CloverElement = { mount: (target: string | HTMLElement) => void; unmount?: () => void };
type CloverElements = { create: (kind: string, options?: Record<string, unknown>) => CloverElement };
type CloverInstance = {
  elements: () => CloverElements;
  createToken: () => Promise<{ token?: string; errors?: Record<string, string> }>;
};
type CloverConstructor = new (apiKey: string, options?: Record<string, unknown>) => CloverInstance;

declare global {
  interface Window {
    Clover?: CloverConstructor;
  }
}

const SDK_PRODUCTION = "https://checkout.clover.com/sdk.js";
const SDK_SANDBOX = "https://checkout.sandbox.dev.clover.com/sdk.js";

/** Resolves once the SDK is on the page, or rejects if it cannot be loaded. */
function loadCloverSdk(sandbox: boolean): Promise<CloverConstructor> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.Clover) return Promise.resolve(window.Clover);

  const src = sandbox ? SDK_SANDBOX : SDK_PRODUCTION;
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
  const script = existing ?? document.createElement("script");

  return new Promise((resolve, reject) => {
    const settle = () => (window.Clover ? resolve(window.Clover) : reject(new Error("Clover SDK did not initialise")));
    script.addEventListener("load", settle, { once: true });
    script.addEventListener("error", () => reject(new Error("Clover SDK could not be loaded")), { once: true });
    if (!existing) {
      script.src = src;
      script.async = true;
      document.head.appendChild(script);
    } else if (window.Clover) {
      resolve(window.Clover);
    }
  });
}

export type CloverCardFormHandle = { tokenize: () => Promise<string> };

export function CloverCardForm({
  publicToken,
  merchantId,
  sandbox,
  onReady,
  onUnavailable,
}: {
  publicToken: string;
  merchantId?: string;
  sandbox: boolean;
  onReady: (handle: CloverCardFormHandle) => void;
  onUnavailable: (reason: string) => void;
}) {
  const numberRef = useRef<HTMLDivElement>(null);
  const expiryRef = useRef<HTMLDivElement>(null);
  const cvvRef = useRef<HTMLDivElement>(null);
  const postalRef = useRef<HTMLDivElement>(null);
  const cloverRef = useRef<CloverInstance | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [fieldError, setFieldError] = useState("");

  // Held in refs so the mount effect does not re-run when the parent re-renders
  // and hands down new function identities — remounting Clover's iframes on every
  // keystroke elsewhere in the form would clear whatever the customer had typed.
  const onReadyRef = useRef(onReady);
  const onUnavailableRef = useRef(onUnavailable);
  useEffect(() => {
    onReadyRef.current = onReady;
    onUnavailableRef.current = onUnavailable;
  });

  const tokenize = useCallback(async (): Promise<string> => {
    const clover = cloverRef.current;
    if (!clover) throw new Error("The card form is not ready yet.");
    setFieldError("");
    const result = await clover.createToken();
    const firstError = result.errors ? Object.values(result.errors)[0] : undefined;
    if (firstError) {
      setFieldError(firstError);
      throw new Error(firstError);
    }
    if (!result.token) {
      const message = "The card details could not be verified. Please check them and try again.";
      setFieldError(message);
      throw new Error(message);
    }
    return result.token;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const elements: CloverElement[] = [];

    void (async () => {
      try {
        const Clover = await loadCloverSdk(sandbox);
        if (cancelled) return;
        const clover = new Clover(publicToken, merchantId ? { merchantId } : undefined);
        cloverRef.current = clover;
        const factory = clover.elements();

        const mounts: Array<[string, HTMLDivElement | null]> = [
          ["CARD_NUMBER", numberRef.current],
          ["CARD_DATE", expiryRef.current],
          ["CARD_CVV", cvvRef.current],
          ["CARD_POSTAL_CODE", postalRef.current],
        ];
        for (const [kind, target] of mounts) {
          if (!target) continue;
          const element = factory.create(kind);
          element.mount(target);
          elements.push(element);
        }

        if (cancelled) return;
        setStatus("ready");
        onReadyRef.current({ tokenize });
      } catch (error) {
        if (cancelled) return;
        setStatus("failed");
        onUnavailableRef.current(error instanceof Error ? error.message : "The card form could not be loaded.");
      }
    })();

    return () => {
      cancelled = true;
      // Clover owns the DOM inside these containers; leaving its iframes behind
      // when the modal closes leaks them into the next checkout.
      for (const element of elements) element.unmount?.();
      cloverRef.current = null;
    };
  }, [publicToken, merchantId, sandbox, tokenize]);

  return (
    <fieldset className="clover-card-fields">
      <legend>Card details</legend>
      {status === "loading" ? <p className="utility-help">Loading the secure card form…</p> : null}
      {status === "failed" ? (
        <p className="utility-help" role="status">
          The secure card form could not load. You can still pay on Clover&apos;s page.
        </p>
      ) : null}
      <div hidden={status !== "ready"}>
        <label>
          Card number
          <div className="clover-field" ref={numberRef} />
        </label>
        <div className="clover-field-row">
          <label>
            Expiry
            <div className="clover-field" ref={expiryRef} />
          </label>
          <label>
            Security code
            <div className="clover-field" ref={cvvRef} />
          </label>
          <label>
            Postal code
            <div className="clover-field" ref={postalRef} />
          </label>
        </div>
        {fieldError ? (
          <p className="utility-help" role="alert">
            {fieldError}
          </p>
        ) : null}
        <p className="utility-help">Your card is entered directly with Clover. We never see or store it.</p>
      </div>
    </fieldset>
  );
}
