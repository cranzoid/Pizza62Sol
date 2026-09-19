"use client";

import { useEffect } from "react";
import { captureCampaignAttribution, initializeMarketing } from "@/lib/marketing";

/**
 * Loads the ad-measurement tags and records the campaign that brought this
 * visitor. Both run on mount for every visitor: measurement is offered under
 * implied consent with the privacy policy as the notice, so there is no banner
 * decision to wait for. See `hasMarketingConsent` on why, and on the opt-out
 * that still suppresses it.
 *
 * `initializeMarketing` keeps its own guards, so mounting this in the root
 * layout is safe: it loads nothing on staff or order-tracking paths, and
 * nothing at all when the deployment leaves the marketing IDs blank — which is
 * how staging stays out of the production pixel.
 *
 * Attribution capture sits outside those guards on purpose. It only writes
 * campaign labels to this browser's own storage for checkout to send with the
 * order, and reaches no third party; an order that came from an ad has to
 * remember that even when no tag is configured to load.
 */
export default function MarketingTags() {
  useEffect(() => {
    captureCampaignAttribution();
    initializeMarketing();
  }, []);
  return null;
}
