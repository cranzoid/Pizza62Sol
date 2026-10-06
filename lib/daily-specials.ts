/**
 * The day's special, as the pop-up a visitor meets on arrival shows it.
 *
 * The pop-up used to be written for one product: it looked up the Monday wings
 * by id, carried Monday wording in the markup and a "GAME DAY" watermark in the
 * stylesheet left over from the offer before that. Every other day had nothing,
 * and adding one meant a release.
 *
 * Now a product opts in with `configuration.dailySpecial` (Menu setup → "Day's
 * special pop-up"), and its own weekly availability says which days it is the
 * special. So the pop-up shows whatever is flagged and running right now, and a
 * Tuesday special is a menu edit rather than a deploy.
 *
 * Pure, so it can be tested without a browser, and so the server-rendered page
 * and the browser cannot reach different answers from the same catalogue.
 */
import { isWithinWeeklyAvailability, type WeeklyAvailability } from "@/lib/domain";

type SpecialCandidate = {
  sold_out?: number | boolean;
  setup_required?: number | boolean;
  pickup_eligible: number | boolean;
  delivery_eligible: number | boolean;
  configuration: Record<string, unknown>;
};

/**
 * Flagged products that can be ordered right now, in the order given.
 *
 * Judged against the offer's own hours as well as its day, so a 5–9 PM special
 * is not advertised at noon with a button that opens a closed offer. Something
 * the site cannot sell today — sold out, waiting on setup, or only sold by a
 * method the store has switched off — is left out rather than shown and refused.
 */
export function todaysSpecials<T extends SpecialCandidate>(
  products: T[],
  now: Date,
  methods: { pickupEnabled: boolean; deliveryEnabled: boolean },
): T[] {
  return products.filter((product) => {
    if (!product.configuration.dailySpecial || product.sold_out || product.setup_required) return false;
    if (!isWithinWeeklyAvailability(product.configuration.availability as WeeklyAvailability | undefined, now)) return false;
    return Boolean((product.pickup_eligible && methods.pickupEnabled) || (product.delivery_eligible && methods.deliveryEnabled));
  });
}

/** "Monday", in the restaurant's time zone rather than the visitor's. */
export function weekdayName(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { weekday: "long", timeZone }).format(now);
}
