/**
 * Where an order came from.
 *
 * Meta and Google send traffic here with campaign parameters on the URL, and
 * until now those parameters lived in the browser: `captureCampaignAttribution`
 * stashed them in localStorage and `trackEvent` copied them onto analytics
 * events. That answers "how many people who clicked the ad reached the menu".
 * It cannot answer the only question the restaurant actually pays to have
 * answered — **did this order come from the ad** — because no order carried the
 * campaign it came from, and an analytics event and an order row had nothing to
 * join on.
 *
 * So attribution is now written on the order itself, once, at creation. This
 * module is the shared vocabulary for that: the fields worth keeping, the
 * sanitiser every write goes through, and the classification the staff screens,
 * the CSV export and anyone reading the raw row all use, so "Meta Ads" means
 * the same thing everywhere it appears.
 *
 * **Two touches, not one.** A customer clicks a Meta ad on Tuesday, comes back
 * on Friday by typing the address, and orders. Crediting Meta (first touch) and
 * crediting nobody (last touch) are both defensible and both incomplete, so
 * both are kept and the staff screen shows when they differ.
 *
 * **Campaign labels only.** Everything here comes from the query string, the
 * path and the referrer's origin — never the referrer's full URL, never form
 * fields, never anything the customer typed. The list below is exhaustive, and
 * a write carrying anything else has the extra keys dropped rather than stored,
 * because this row is read back by staff and exported to spreadsheets.
 */

/** The five UTM labels every ad platform agrees on. */
export const CAMPAIGN_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

/**
 * Per-click identifiers. They are opaque to us — we never call an ad platform's
 * API with them — but they are how a platform's own reporting recognises the
 * click, so they are the evidence when Meta and the till disagree.
 */
export const CLICK_IDS = ["gclid", "gbraid", "wbraid", "fbclid", "msclkid", "ttclid"] as const;

/** Where they landed, who sent them, and when we saw it. */
export const CONTEXT_FIELDS = ["landing_path", "referrer_origin", "captured_at"] as const;

export const TOUCH_FIELDS = [...CAMPAIGN_PARAMS, ...CLICK_IDS, ...CONTEXT_FIELDS] as const;

export type TouchField = (typeof TOUCH_FIELDS)[number];
export type AttributionTouch = Partial<Record<TouchField, string>>;

/** First contact and the visit that placed the order. Either may be missing. */
export type OrderAttribution = { first?: AttributionTouch; last?: AttributionTouch };

const FIELD_LIMIT: Partial<Record<TouchField, number>> = { landing_path: 300 };
const DEFAULT_LIMIT = 160;

function cleanValue(raw: unknown, field: TouchField): string | undefined {
  if (typeof raw !== "string") return undefined;
  // Control characters are replaced rather than escaped: this value is rendered
  // in the staff drawer and written into a CSV, and a newline inside a campaign
  // name breaks a spreadsheet row in a way quoting alone does not prevent.
  const trimmed = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, FIELD_LIMIT[field] ?? DEFAULT_LIMIT);
  return trimmed || undefined;
}

/** One visit's labels, with anything not on the list above discarded. */
export function normalizeTouch(raw: unknown): AttributionTouch | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const touch: AttributionTouch = {};
  for (const field of TOUCH_FIELDS) {
    const value = cleanValue(source[field], field);
    if (value) touch[field] = value;
  }
  // A touch that is only a timestamp records nothing about where anyone came
  // from, and storing it would make every direct order look like it had data.
  return Object.keys(touch).some((key) => key !== "captured_at") ? touch : null;
}

/**
 * The value stored on an order, from whatever the browser sent.
 *
 * Accepts the `{ first, last }` shape the current storefront sends and a bare
 * touch object (what an older tab, still running the previous build, would
 * post) — the latter is recorded as the last touch, which is what it is.
 */
export function normalizeAttribution(raw: unknown): OrderAttribution | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const hasTouches = "first" in source || "last" in source;
  const first = hasTouches ? normalizeTouch(source.first) : null;
  const last = hasTouches ? normalizeTouch(source.last) : normalizeTouch(source);
  if (!first && !last) return null;
  return { ...(first ? { first } : {}), ...(last ? { last } : {}) };
}

/** Reads the column back. A row written before this feature returns null. */
export function parseAttribution(json: unknown): OrderAttribution | null {
  if (!json || typeof json !== "string") return null;
  try {
    return normalizeAttribution(JSON.parse(json));
  } catch {
    return null;
  }
}

export type AttributionChannel =
  | "meta_ads"
  | "google_ads"
  | "microsoft_ads"
  | "tiktok_ads"
  | "other_paid"
  | "email"
  | "social"
  | "organic_search"
  | "referral"
  | "direct";

/** The words the owner would use, not the ones the query string used. */
export const CHANNEL_LABELS: Record<AttributionChannel, string> = {
  meta_ads: "Meta Ads",
  google_ads: "Google Ads",
  microsoft_ads: "Microsoft Ads",
  tiktok_ads: "TikTok Ads",
  other_paid: "Paid campaign",
  email: "Email",
  social: "Social",
  organic_search: "Search",
  referral: "Referral",
  direct: "Direct",
};

const META_SOURCES = ["facebook", "fb", "instagram", "ig", "meta", "messenger", "audience_network"];
const SEARCH_HOSTS = ["google.", "bing.", "duckduckgo.", "yahoo.", "ecosia.", "search.brave"];
const SOCIAL_HOSTS = ["facebook.", "instagram.", "tiktok.", "twitter.", "x.com", "reddit.", "pinterest.", "youtube.", "linkedin."];
const PAID_MEDIUMS = ["cpc", "ppc", "paid", "paidsocial", "paid_social", "paid-social", "display", "cpm", "retargeting"];

const includesAny = (value: string, needles: string[]) => needles.some((needle) => value.includes(needle));

/**
 * Which channel one visit belongs to.
 *
 * Click ids win over UTMs: a `fbclid` is written by Meta itself, while
 * `utm_source` is whatever the person who built the link typed, and the two
 * disagree often enough that the platform's own evidence has to be trusted
 * first. The referrer is consulted only when neither is present, so an ad click
 * that happens to arrive from a Google domain is still counted as the ad.
 */
export function touchChannel(touch: AttributionTouch | null | undefined): AttributionChannel {
  if (!touch) return "direct";
  const source = (touch.utm_source ?? "").toLowerCase();
  const medium = (touch.utm_medium ?? "").toLowerCase();
  if (touch.fbclid || META_SOURCES.includes(source)) {
    // An organic Instagram post tagged `utm_medium=social` is not an ad. A
    // click id, or a paid medium, is.
    return touch.fbclid || !medium || PAID_MEDIUMS.includes(medium) ? "meta_ads" : "social";
  }
  if (touch.gclid || touch.gbraid || touch.wbraid) return "google_ads";
  if (touch.msclkid) return "microsoft_ads";
  if (touch.ttclid || source.includes("tiktok")) return "tiktok_ads";
  if (source === "google" && PAID_MEDIUMS.includes(medium)) return "google_ads";
  if (source.includes("bing") && PAID_MEDIUMS.includes(medium)) return "microsoft_ads";
  if (medium.includes("email") || source.includes("newsletter") || source.includes("klaviyo") || source.includes("mailchimp")) return "email";
  if (PAID_MEDIUMS.includes(medium)) return "other_paid";
  if (medium.includes("social")) return "social";
  if (source || medium || touch.utm_campaign) return "referral";
  const referrer = (touch.referrer_origin ?? "").toLowerCase();
  if (!referrer) return "direct";
  if (includesAny(referrer, SEARCH_HOSTS)) return "organic_search";
  if (includesAny(referrer, SOCIAL_HOSTS)) return "social";
  return "referral";
}

/** The channel of the visit that actually placed the order. */
export function attributionChannel(attribution: OrderAttribution | null | undefined): AttributionChannel {
  if (!attribution) return "direct";
  return touchChannel(attribution.last ?? attribution.first);
}

/** `Meta Ads · game-day-2026`, or just `Meta Ads` when the link carried no campaign. */
export function touchLabel(touch: AttributionTouch | null | undefined): string {
  const channel = CHANNEL_LABELS[touchChannel(touch)];
  const campaign = touch?.utm_campaign;
  return campaign ? `${channel} · ${campaign}` : channel;
}

/**
 * One line for a table cell or a spreadsheet column.
 *
 * `channel` is the order's own channel (`online`, `phone`, `walk_in`), because
 * a phone order has no campaign to report and labelling it "Direct" would put
 * it in the same bucket as a website visitor who typed the address in — one of
 * those is a marketing result and the other is a telephone.
 */
export function orderSourceLabel(
  attribution: OrderAttribution | null | undefined,
  channel?: string | null,
): string {
  if (channel === "phone") return "Phone order";
  if (channel === "walk_in") return "Walk-in";
  return touchLabel(attribution?.last ?? attribution?.first);
}

const TOUCH_LABELS: Record<TouchField, string> = {
  utm_source: "Source",
  utm_medium: "Medium",
  utm_campaign: "Campaign",
  utm_content: "Ad / content",
  utm_term: "Keyword",
  gclid: "Google click id",
  gbraid: "Google click id (gbraid)",
  wbraid: "Google click id (wbraid)",
  fbclid: "Meta click id",
  msclkid: "Microsoft click id",
  ttclid: "TikTok click id",
  landing_path: "Landed on",
  referrer_origin: "Referred by",
  captured_at: "Seen",
};

/** Every field of one visit, labelled, in the order a person reads them. */
export function touchRows(touch: AttributionTouch | null | undefined): Array<{ label: string; value: string }> {
  if (!touch) return [];
  return TOUCH_FIELDS.filter((field) => touch[field]).map((field) => ({
    label: TOUCH_LABELS[field],
    value: touch[field] as string,
  }));
}

/**
 * True when first and last contact are genuinely different visits, so the staff
 * screen only spends space on the earlier one when it says something new.
 */
export function touchesDiffer(attribution: OrderAttribution | null | undefined): boolean {
  const first = attribution?.first;
  const last = attribution?.last;
  if (!first || !last) return false;
  return TOUCH_FIELDS.filter((field) => field !== "captured_at").some((field) => first[field] !== last[field]);
}
