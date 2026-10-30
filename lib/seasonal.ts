import { isWithinWeeklyAvailability, type WeeklyAvailability } from "@/lib/domain";

// The offer and decorations use separate windows in the restaurant's calendar.
// Neither may return on the same weekday or next Halloween.
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

const HALLOWEEN_DECORATION_AVAILABILITY: WeeklyAvailability = {
  ...HALLOWEEN_AVAILABILITY,
  startDate: "2026-10-30",
  label: "Halloween decorations · Oct 30–31",
};

export function halloweenDecorationsActive(now = new Date()): boolean {
  return isWithinWeeklyAvailability(HALLOWEEN_DECORATION_AVAILABILITY, now);
}

/** Seasonal items disappear entirely outside their window, including in an open tab. */
export function isStorefrontProductVisible(product: { configuration: Record<string, unknown> }, now = new Date()): boolean {
  return !product.configuration.hideOutsideAvailability
    || isWithinWeeklyAvailability(product.configuration.availability as WeeklyAvailability | undefined, now);
}
