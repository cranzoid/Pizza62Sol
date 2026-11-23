/**
 * One-day promotions sent by email and text — today, the Monday Wings offer.
 *
 * Reuses the giveaway outreach machinery (audience, pacing, STOP/unsubscribe,
 * delivery tracking) but is not tied to the giveaway being open. A promo
 * campaign id is `promo:monday-wings:<Toronto date>`: dated, so each Monday is
 * its own campaign and "already sent" never carries over from last week.
 *
 * The offer's wording is here rather than read from the catalogue so what
 * customers are told is reviewed in code. If the offer changes (price, cap,
 * pickup-only), change it here and in the menu together.
 */
const TORONTO = "America/Toronto";

export const MONDAY_WINGS_PREFIX = "promo:monday-wings:";

export const MONDAY_WINGS_OFFER = {
  name: "Monday Wings",
  priceLabel: "$1 each",
  cap: 40,
  style: "classic (non-breaded) or breaded",
  how: "Pickup only",
} as const;

export function torontoDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-CA", { timeZone: TORONTO });
}

export function torontoWeekday(timestamp: number): string {
  return new Intl.DateTimeFormat("en-CA", { weekday: "long", timeZone: TORONTO }).format(new Date(timestamp));
}

export function mondayWingsCampaign(timestamp: number): string {
  return `${MONDAY_WINGS_PREFIX}${torontoDate(timestamp)}`;
}

export function isMondayWingsCampaign(value: unknown): value is string {
  return typeof value === "string" && /^promo:monday-wings:\d{4}-\d{2}-\d{2}$/.test(value);
}

/** The campaign's own date, so a text still queued after midnight is not sent claiming "today". */
export function campaignDate(campaign: string): string {
  return campaign.slice(MONDAY_WINGS_PREFIX.length);
}

/** The first instant of the next Toronto calendar day after `timestamp`. */
export function endOfTorontoDay(timestamp: number): number {
  const today = torontoDate(timestamp);
  let low = timestamp;
  let high = timestamp + 26 * 3_600_000;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (torontoDate(mid) === today) low = mid;
    else high = mid;
  }
  return high;
}

/** Whether a queued message for `campaign` may still go out at `now`. */
export function mondayWingsIsOn(campaign: string, now: number): boolean {
  return torontoDate(now) === campaignDate(campaign) && torontoWeekday(now) === "Monday";
}
