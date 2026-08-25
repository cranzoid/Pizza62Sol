/**
 * Date-range parsing shared by every owner-facing report that filters on a
 * calendar day — order history, the CSV export and the customer directory.
 *
 * Pulled out of `app/api/admin/records/route.ts` (H-20) so a second report
 * cannot quietly disagree with the first about what "the 21st" means. Dates
 * arrive as YYYY-MM-DD and are interpreted in the restaurant's own time zone,
 * not the viewer's and not UTC: an owner asking for "the 21st" means the day
 * they worked, and a UTC boundary would put the evening's orders on the wrong
 * day — exactly when a restaurant is busiest.
 */

/** Matches the YYYY-MM-DD shape every date-range input arrives in. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Midnight on a YYYY-MM-DD date, in America/Toronto, as epoch ms. */
export function torontoDayStart(date: string): number {
  // Probing both standard and daylight offsets and keeping whichever round-trips
  // to the requested date avoids hardcoding a DST rule that changes.
  for (const offset of ["-05:00", "-04:00"]) {
    const candidate = new Date(`${date}T00:00:00${offset}`).getTime();
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(candidate));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const rendered = `${values.year}-${values.month}-${values.day}`;
    if (rendered === date && values.hour === "00" && values.minute === "00" && values.second === "00") {
      return candidate;
    }
  }
  return new Date(`${date}T00:00:00-05:00`).getTime();
}

/** The next YYYY-MM-DD date without allowing the host time zone to interfere. */
export function nextCalendarDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}
