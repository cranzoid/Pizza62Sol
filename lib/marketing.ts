"use client";

import {
  normalizeAttribution,
  type AttributionTouch,
  type OrderAttribution,
} from "@/lib/attribution";

export type CommerceItem = {
  itemId: string;
  itemName: string;
  category?: string;
  price: number;
  quantity: number;
};

type EventContext = Record<string, unknown> & {
  currency?: string;
  value?: number;
  transactionId?: string;
  items?: CommerceItem[];
};

type Fbq = ((...args: unknown[]) => void) & { queue?: unknown[][]; loaded?: boolean; version?: string; callMethod?: (...args: unknown[]) => void; push?: Fbq };
type Gtag = (...args: unknown[]) => void;

declare global {
  interface Window {
    fbq?: Fbq;
    _fbq?: Fbq;
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

export const MARKETING_CONSENT_KEY = "p62_marketing_consent_v1";
export const OPEN_CONSENT_EVENT = "p62:open-consent";
/**
 * v2 keeps two touches rather than one — see lib/attribution.ts on why first and
 * last contact are both worth having. The v1 key is deliberately not migrated:
 * it held a single flat touch with no way to tell which of the two it was.
 */
const ATTRIBUTION_KEY = "p62_campaign_attribution_v2";
const PURCHASE_KEY_PREFIX = "p62_marketing_purchase_";

const allowedEventNames = new Set([
  "website_visit",
  "fulfilment_selected",
  "delivery_eligibility_checked",
  "menu_viewed",
  "product_viewed",
  "add_to_cart",
  "remove_from_cart",
  "upsell_impression",
  "upsell_selected",
  "upsell_added",
  "upsell_removed",
  "cart_viewed",
  "checkout_started",
  "payment_attempted",
  "purchase_completed",
  "promotion_used",
  "coupon_used",
  "feedback_submitted",
  "google_review_clicked",
  "card_form_unavailable",
  "phone_clicked",
]);

/**
 * Fail closed when the hosted-checkout return page decides whether an online
 * order is a Purchase. `paymentStatus` is the server's authoritative result;
 * the operational order status alone is not proof that Clover was paid.
 */
export function isConfirmedOnlinePurchase(order?: { status?: string; paymentStatus?: string }): boolean {
  return Boolean(
    order?.status
      && order.status !== "awaiting_payment"
      && order.status !== "cancelled"
      && order.paymentStatus === "paid",
  );
}

function clean(value: string | null, maximum = 160): string | undefined {
  const normalized = value?.trim().slice(0, maximum);
  return normalized || undefined;
}

function config() {
  if (typeof document === "undefined") return { metaPixelId: "", ga4Id: "", googleAdsId: "", googleAdsLabel: "" };
  const data = document.documentElement.dataset;
  return {
    metaPixelId: /^\d{5,30}$/.test(data.metaPixelId ?? "") ? data.metaPixelId! : "",
    ga4Id: /^G-[A-Z0-9]+$/i.test(data.ga4Id ?? "") ? data.ga4Id! : "",
    googleAdsId: /^AW-\d+$/i.test(data.googleAdsId ?? "") ? data.googleAdsId! : "",
    googleAdsLabel: /^[A-Za-z0-9_-]+$/.test(data.googleAdsLabel ?? "") ? data.googleAdsLabel! : "",
  };
}

function safeMarketingPath(): boolean {
  if (typeof window === "undefined") return false;
  return !["/track", "/feedback", "/admin", "/kitchen", "/employee", "/kiosk"]
    .some((path) => window.location.pathname === path || window.location.pathname.startsWith(`${path}/`));
}

export function marketingConfigured(): boolean {
  if (!safeMarketingPath()) return false;
  const current = config();
  return Boolean(current.metaPixelId || current.ga4Id || current.googleAdsId);
}

/**
 * Implied consent, with the privacy policy as the notice: measurement runs
 * unless this browser has explicitly opted out. Pizza 62 operates in Ontario
 * under PIPEDA, which does not require the prior opt-in that an EU cookie
 * banner exists to collect — so there is no "undecided" state to wait on, only
 * a recorded "no". `revokeMarketing` is what writes that "no".
 */
export function hasMarketingConsent(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(MARKETING_CONSENT_KEY) !== "denied";
}

/**
 * The campaign record this browser is carrying: where this visitor first came
 * from, and where they came from this time.
 *
 * Exported because checkout sends it with the order — that is the whole point
 * of capturing it. `normalizeAttribution` runs on the way out as well as on the
 * server, so a corrupted or hand-edited localStorage value cannot put arbitrary
 * keys into an order row.
 */
export function orderAttribution(): OrderAttribution | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeAttribution(JSON.parse(window.localStorage.getItem(ATTRIBUTION_KEY) ?? "null"));
  } catch {
    return null;
  }
}

/** The current visit's labels, flattened, for a first-party analytics event. */
function attribution(): Record<string, string> {
  const stored = orderAttribution();
  return { ...(stored?.last ?? stored?.first ?? {}) };
}

/** This visit, read off the URL and the referrer. Nothing else is looked at. */
function currentTouch(): AttributionTouch {
  const query = new URLSearchParams(window.location.search);
  const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid"];
  const found = Object.fromEntries(keys.flatMap((key) => {
    const value = clean(query.get(key));
    return value ? [[key, value]] : [];
  }));
  let referrerOrigin: string | undefined;
  try {
    // The origin only. A referrer's full URL can carry the search terms someone
    // typed, or a private page they came from; the host is what says "Instagram
    // sent them" and is the most this needs.
    const origin = document.referrer ? new URL(document.referrer).origin : "";
    referrerOrigin = origin && origin !== window.location.origin ? origin : undefined;
  } catch {
    referrerOrigin = undefined;
  }
  return {
    ...found,
    landing_path: window.location.pathname.slice(0, 300),
    ...(referrerOrigin ? { referrer_origin: referrerOrigin } : {}),
    captured_at: new Date().toISOString(),
  };
}

/**
 * Captures only campaign labels—never contact, address, or checkout form data.
 *
 * The first visit is always recorded, campaign parameters or not, so a direct
 * customer still has a first touch to show rather than an empty panel. After
 * that the last touch is only replaced when this visit actually says something
 * new — an ad click or an external referrer. Without that guard, a customer who
 * clicked a Meta ad and then reloaded the page would have Meta overwritten by a
 * visit from nowhere, and the ad would lose the order it paid for.
 */
export function captureCampaignAttribution(): void {
  if (typeof window === "undefined") return;
  const touch = currentTouch();
  const campaignSignal = Object.keys(touch).some((key) => key !== "landing_path" && key !== "captured_at");
  const stored = orderAttribution();
  if (stored && !campaignSignal) return;
  const next: OrderAttribution = { first: stored?.first ?? touch, last: touch };
  window.localStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(next));
}

function loadScript(id: string, src: string): void {
  if (document.getElementById(id)) return;
  const script = document.createElement("script");
  script.id = id;
  script.async = true;
  script.src = src;
  document.head.appendChild(script);
}

function initializeMeta(pixelId: string): void {
  if (!pixelId) return;
  if (window.fbq) {
    window.fbq("consent", "grant");
    if (document.documentElement.dataset.metaPixelInitialized !== pixelId) {
      window.fbq("init", pixelId);
      window.fbq("track", "PageView");
      document.documentElement.dataset.metaPixelInitialized = pixelId;
    }
    return;
  }
  const fbq = function (...args: unknown[]) {
    if (fbq.callMethod) fbq.callMethod(...args);
    else (fbq.queue ??= []).push(args);
  } as Fbq;
  fbq.loaded = true;
  fbq.version = "2.0";
  fbq.push = fbq;
  window.fbq = fbq;
  window._fbq = fbq;
  loadScript("p62-meta-pixel", "https://connect.facebook.net/en_US/fbevents.js");
  fbq("consent", "grant");
  fbq("init", pixelId);
  fbq("track", "PageView");
  document.documentElement.dataset.metaPixelInitialized = pixelId;
}

function initializeGoogle(ga4Id: string, adsId: string): void {
  const primary = ga4Id || adsId;
  if (!primary) return;
  window.dataLayer ??= [];
  window.gtag ??= (...args: unknown[]) => { window.dataLayer!.push(args); };
  const firstLoad = !document.getElementById("p62-google-tag");
  if (firstLoad) {
    window.gtag("consent", "default", {
      ad_storage: "denied",
      analytics_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied",
    });
  }
  loadScript("p62-google-tag", `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(primary)}`);
  if (firstLoad) {
    window.gtag("js", new Date());
    if (ga4Id) window.gtag("config", ga4Id);
    if (adsId) window.gtag("config", adsId);
  }
  window.gtag("consent", "update", {
    ad_storage: "granted",
    analytics_storage: "granted",
    ad_user_data: "granted",
    ad_personalization: "granted",
  });
}

export function initializeMarketing(): void {
  if (typeof window === "undefined" || !safeMarketingPath() || !hasMarketingConsent()) return;
  const current = config();
  initializeMeta(current.metaPixelId);
  initializeGoogle(current.ga4Id, current.googleAdsId);
}

export function revokeMarketing(): void {
  window.localStorage.setItem(MARKETING_CONSENT_KEY, "denied");
  window.fbq?.("consent", "revoke");
  window.gtag?.("consent", "update", {
    ad_storage: "denied",
    analytics_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
}

function ecommerceItems(items: CommerceItem[] = []) {
  return items.map((item) => ({
    item_id: item.itemId,
    item_name: item.itemName,
    item_category: item.category,
    price: item.price,
    quantity: item.quantity,
  }));
}

function sendExternal(eventName: string, context: EventContext): void {
  if (!hasMarketingConsent()) return;
  initializeMarketing();
  const currency = context.currency ?? "CAD";
  const value = Number(context.value ?? 0);
  const items = context.items ?? [];
  const transactionId = clean(String(context.transactionId ?? ""), 64);
  if (eventName === "purchase_completed" && transactionId) {
    const key = `${PURCHASE_KEY_PREFIX}${transactionId}`;
    if (window.localStorage.getItem(key) === "sent") return;
    window.localStorage.setItem(key, "sent");
  }

  const metaName: Record<string, string> = {
    product_viewed: "ViewContent",
    add_to_cart: "AddToCart",
    checkout_started: "InitiateCheckout",
    purchase_completed: "Purchase",
    phone_clicked: "Contact",
  };
  const googleName: Record<string, string> = {
    product_viewed: "view_item",
    add_to_cart: "add_to_cart",
    remove_from_cart: "remove_from_cart",
    cart_viewed: "view_cart",
    checkout_started: "begin_checkout",
    purchase_completed: "purchase",
    phone_clicked: "generate_lead",
  };
  if (window.fbq && metaName[eventName]) {
    const metaItems = items.map((item) => ({ id: item.itemId, quantity: item.quantity, item_price: item.price }));
    window.fbq(
      "track",
      metaName[eventName],
      {
        content_ids: items.map((item) => item.itemId),
        contents: metaItems,
        content_type: "product",
        currency,
        value,
      },
      transactionId ? { eventID: transactionId } : undefined,
    );
  }
  if (window.gtag && googleName[eventName]) {
    window.gtag("event", googleName[eventName], {
      currency,
      value,
      transaction_id: transactionId,
      items: ecommerceItems(items),
    });
    const current = config();
    if (eventName === "purchase_completed" && current.googleAdsId && current.googleAdsLabel) {
      window.gtag("event", "conversion", {
        send_to: `${current.googleAdsId}/${current.googleAdsLabel}`,
        currency,
        value,
        transaction_id: transactionId,
      });
    }
  }
}

/** Sends the existing first-party event and, with consent, its ad-platform equivalent. */
export function trackEvent(eventName: string, context: EventContext = {}): void {
  if (typeof window === "undefined" || !allowedEventNames.has(eventName)) return;
  const sessionKey = "p62_analytics_session";
  let sessionId = window.sessionStorage.getItem(sessionKey);
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    window.sessionStorage.setItem(sessionKey, sessionId);
  }
  const firstPartyContext = { ...attribution(), ...context };
  void fetch("/api/analytics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventName, sessionId, context: firstPartyContext }),
    keepalive: true,
  });
  if (hasMarketingConsent()) sendExternal(eventName, context);
}

export function openCookieChoices(): void {
  window.dispatchEvent(new Event(OPEN_CONSENT_EVENT));
}
