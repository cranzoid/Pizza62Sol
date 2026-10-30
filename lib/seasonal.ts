import { isWithinWeeklyAvailability, type WeeklyAvailability } from "@/lib/domain";

// The menu, popup and decoration share the restaurant's calendar. This is a
// one-off campaign: it must not return on the same weekday or next Halloween.
export const HALLOWEEN_WINGS_PRODUCT_ID = "halloween-dollar-wings-2026";
export const HALLOWEEN_AVAILABILITY: WeeklyAvailability = {
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  startMinute: 0,
  endMinute: 1440,
  timeZone: "America/Toronto",
  startDate: "2026-10-31",
  endDate: "2026-10-31",
  label: "Halloween · Oct 31 · pickup & delivery",
};

export function isHalloween(now = new Date()): boolean {
  return isWithinWeeklyAvailability(HALLOWEEN_AVAILABILITY, now);
}

/** Seasonal items disappear entirely outside their window, including in an open tab. */
export function isStorefrontProductVisible(product: { configuration: Record<string, unknown> }, now = new Date()): boolean {
  return !product.configuration.hideOutsideAvailability
    || isWithinWeeklyAvailability(product.configuration.availability as WeeklyAvailability | undefined, now);
}
