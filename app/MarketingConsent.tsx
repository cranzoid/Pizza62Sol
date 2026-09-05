"use client";

import { useEffect, useState } from "react";
import {
  MARKETING_CONSENT_KEY,
  OPEN_CONSENT_EVENT,
  captureCampaignAttribution,
  initializeMarketing,
  marketingConfigured,
  revokeMarketing,
} from "@/lib/marketing";

type Choice = "granted" | "denied" | null;

export default function MarketingConsent() {
  const [choice, setChoice] = useState<Choice>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    captureCampaignAttribution();
    const saved = window.localStorage.getItem(MARKETING_CONSENT_KEY);
    const initial = saved === "granted" || saved === "denied" ? saved : null;
    const hydration = window.setTimeout(() => {
      setChoice(initial);
      setOpen(initial === null && marketingConfigured());
    }, 0);
    if (initial === "granted") initializeMarketing();
    const show = () => setOpen(true);
    window.addEventListener(OPEN_CONSENT_EVENT, show);
    return () => {
      window.clearTimeout(hydration);
      window.removeEventListener(OPEN_CONSENT_EVENT, show);
    };
  }, []);

  const save = (next: Exclude<Choice, null>) => {
    window.localStorage.setItem(MARKETING_CONSENT_KEY, next);
    setChoice(next);
    setOpen(false);
    if (next === "granted") initializeMarketing();
    else revokeMarketing();
  };

  if (!open || !marketingConfigured()) return null;
  return <aside className="cookie-panel" role="dialog" aria-modal="false" aria-labelledby="cookie-title">
    <div>
      <strong id="cookie-title">Your privacy, your choice</strong>
      <p>With your permission, Pizza 62 uses Meta and Google measurement to understand which ads lead to orders. Essential ordering and security features always work.</p>
      {choice ? <small>Your current choice is {choice === "granted" ? "allow" : "decline"}.</small> : null}
    </div>
    <div className="cookie-actions">
      <button type="button" className="cookie-decline" onClick={() => save("denied")}>Decline</button>
      <button type="button" className="primary-button" onClick={() => save("granted")}>Allow measurement</button>
    </div>
  </aside>;
}
