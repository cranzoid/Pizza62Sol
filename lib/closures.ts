/**
 * Store closures — holidays, one-off shutdowns, and "back in an hour" (H-08).
 *
 * The only control that existed was an indefinite `ordering.paused` toggle,
 * which someone has to remember to turn back off. The predictable outcomes are
 * both bad: the store stays shut for a day after the holiday, or it takes orders
 * during it. A closure is a window with an end, which is what makes it safe to
 * set on the way out of the door.
 *
 * Two things this module is careful about:
 *
 * **Scope.** Closing delivery while the counter keeps selling is the ordinary
 * case — the driver is off, the kitchen is not. So a closure names what it
 * closes rather than closing everything.
 *
 * **Scheduled orders.** Enforcement is against the time the order is *for*, not
 * the time it was placed. Otherwise a customer can order on Monday for a
 * Christmas Day pickup and nothing objects until Christmas Day.
 */
import { getD1 } from "@/db/runtime";
import type { Fulfilment, StoreClosure } from "@/lib/domain";

/**
 * Closures that could still matter: anything not already finished.
 *
 * Past closures are left in the table as a record of what happened, but they are
 * never loaded — a holiday from last year has no bearing on today and would only
 * grow the set every check has to scan.
 */
export async function loadActiveClosures(now: number = Date.now()): Promise<StoreClosure[]> {
  const result = await getD1()
    .prepare(
      `SELECT id, starts_at, ends_at, scope, reason, customer_message
       FROM store_closures WHERE ends_at > ? ORDER BY starts_at`,
    )
    .bind(now)
    .all<{
      id: string;
      starts_at: number;
      ends_at: number;
      scope: string;
      reason: string;
      customer_message: string | null;
    }>();
  return result.results.map((row) => ({
    id: row.id,
    startsAt: Number(row.starts_at),
    endsAt: Number(row.ends_at),
    scope: (row.scope === "pickup" || row.scope === "delivery" ? row.scope : "both") as StoreClosure["scope"],
    reason: row.reason,
    customerMessage: row.customer_message,
  }));
}

/** The message a customer should see, falling back to something truthful. */
export function closureMessage(closure: StoreClosure, timeZone = "America/Toronto"): string {
  if (closure.customerMessage?.trim()) return closure.customerMessage.trim();
  const back = new Date(closure.endsAt).toLocaleString("en-CA", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
  const what =
    closure.scope === "delivery" ? "Delivery is" : closure.scope === "pickup" ? "Pickup is" : "We are";
  return `${what} closed right now — ${closure.reason}. Back ${back}.`;
}

/**
 * Whether this fulfilment can be promised for this moment.
 *
 * Callers pass the time the order is *for*: `estimatedFor` for an ASAP order and
 * `scheduledFor` for a scheduled one.
 */
export function closureFor(
  at: number,
  closures: StoreClosure[],
  fulfilment: Fulfilment,
): StoreClosure | null {
  const matches = closures.filter(
    (closure) => at >= closure.startsAt && at < closure.endsAt && (closure.scope === "both" || closure.scope === fulfilment),
  );
  if (!matches.length) return null;
  return matches.reduce((soonest, closure) => (closure.endsAt < soonest.endsAt ? closure : soonest));
}
