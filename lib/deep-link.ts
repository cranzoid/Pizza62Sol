/**
 * One advertised offer, one URL, one landing that already did the clicking.
 *
 * An ad for the $11.99 large pizza used to have nowhere honest to point. The
 * homepage anchors are the closest thing the site had to a deep link, and they
 * are not one: `#category-pickup-specials` is rendered only while the visitor's
 * remembered method is pickup, because the menu hides categories that have
 * nothing in them for the current fulfilment. So the customer who ordered
 * delivery last week clicked a pickup-special ad and landed on a page with no
 * such anchor, scrolled nowhere, and was then asked delivery-or-pickup by a
 * modal before they could see the thing they were promised.
 *
 * This module turns a query string into a decision: which method to select, and
 * which product's customizer to open. It is pure — no `window`, no React, no
 * catalogue fetch — so the rules below can be tested directly, which matters
 * because they are the rules that spend money.
 *
 * Two of those rules are load-bearing and easy to lose later:
 *
 * 1. A deep link never adds anything to the cart. It opens a customizer, or it
 *    falls back to the menu. An ad click is a statement of interest, not an
 *    order, and a product that silently appeared in the bag is how a customer
 *    ends up paying for something they never chose.
 * 2. The URL is the only thing that decides the ordering method, and a product
 *    opens only if it can actually be had that way. The delivery-or-pickup
 *    prompt exists because a silently assumed method reached the payment step
 *    as a surprise address form and a surprise fee; skipping it is only safe
 *    when the link said which method it meant.
 *
 * So an advertising URL carries both parameters, always:
 *
 *     /?fulfilment=pickup&product=pickup-large-one
 *     /?fulfilment=pickup&product=pickup-two-large-six
 *     /?fulfilment=delivery
 *
 * `product` on its own is treated as under-specified and lands on the menu with
 * the prompt intact. Deriving the method from the product instead would be one
 * more place that quietly decides how someone is getting their food, and the
 * point of the prompt was to stop having those. A mismatched pair — a delivery
 * link to a pickup-only pizza — lands on the menu too, rather than opening a
 * customizer whose item the cart would refuse to quote.
 */

import { isWithinWeeklyAvailability, type WeeklyAvailability } from "@/lib/domain";

export type Fulfilment = "pickup" | "delivery";

/**
 * The catalogue fields a deep link reads, and no more.
 *
 * Structural rather than an import of `lib/catalog-types`, for the same reason
 * the customizer's own product type is: the storefront's rows, the staff
 * dashboard's, and a test fixture all satisfy this without anyone converting
 * anything.
 */
export type DeepLinkProduct = {
  id: string;
  product_type: string;
  pickup_eligible: number;
  delivery_eligible: number;
  sold_out: number;
  setup_required: number;
  configuration: Record<string, unknown>;
};

/**
 * The parameters this module consumes, and the only ones it will remove.
 *
 * Everything else in the query string is left exactly as it arrived. That is
 * not tidiness: `utm_*`, `gclid`, `gbraid`, `wbraid` and `fbclid` are read by
 * `captureCampaignAttribution`, which runs in `MarketingConsent` — a sibling
 * mounted *after* the storefront in the root layout, so its effect fires second.
 * A deep link that cleaned the whole query string would erase the attribution
 * for the very click that paid to arrive.
 */
export const DEEP_LINK_PARAMS = ["fulfilment", "product"] as const;

export type DeepLinkRequest = { fulfilment: Fulfilment | null; productId: string | null };

/** Reads `?fulfilment=&product=`; anything unrecognised is simply absent. */
export function parseDeepLink(search: string): DeepLinkRequest {
  const query = new URLSearchParams(search);
  const method = query.get("fulfilment")?.trim().toLowerCase();
  const productId = query.get("product")?.trim();
  return {
    fulfilment: method === "pickup" || method === "delivery" ? method : null,
    productId: productId ? productId : null,
  };
}

/**
 * Returns the same URL without the deep-link parameters, or null when it had
 * none and there is nothing worth calling `replaceState` for.
 *
 * The parameters are stripped so the address the customer can bookmark, share
 * or reload is the plain homepage rather than one that re-opens a customizer
 * every time. The campaign parameters stay: they are the ad's receipt.
 */
export function withoutDeepLinkParams(href: string): string | null {
  const url = new URL(href);
  if (!DEEP_LINK_PARAMS.some((name) => url.searchParams.has(name))) return null;
  for (const name of DEEP_LINK_PARAMS) url.searchParams.delete(name);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Whether choosing this product opens a customizer or drops it straight in the
 * bag.
 *
 * Exported because the storefront's own `openProduct` branches on exactly this,
 * and the two must not drift: the promise that a deep link never adds to the
 * cart is only true while this predicate is the one thing deciding it.
 */
export function hasCustomizer(product: DeepLinkProduct): boolean {
  const sections = product.configuration.sections;
  return product.product_type === "pizza" || (Array.isArray(sections) && sections.length > 0);
}

export type DeepLinkOutcome<P extends DeepLinkProduct> = {
  /** The method the URL asked for, once checked against what is being offered. */
  fulfilment: Fulfilment | null;
  /** The product whose customizer should open; null means fall back to the menu. */
  product: P | null;
};

/**
 * Decides what an arriving deep link should do.
 *
 * A method the restaurant has switched off is dropped rather than selected,
 * matching the storefront's own correction of a remembered method that is no
 * longer offered — and dropping it closes the product too, because a link to a
 * pickup special is worth nothing on a day pickup is off.
 */
export function resolveDeepLink<P extends DeepLinkProduct>(input: {
  request: DeepLinkRequest;
  products: readonly P[];
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  now?: Date;
}): DeepLinkOutcome<P> {
  const { request, products, pickupEnabled, deliveryEnabled, now = new Date() } = input;
  const offered = request.fulfilment === "pickup"
    ? pickupEnabled
    : request.fulfilment === "delivery" ? deliveryEnabled : false;
  const fulfilment = offered ? request.fulfilment : null;
  if (!fulfilment || !request.productId) return { fulfilment, product: null };

  const product = products.find((candidate) => candidate.id === request.productId);
  if (!product) return { fulfilment, product: null };

  // Everything the offer card's own disabled button already covers, plus the
  // eligibility the URL has to agree with. A deep link arrives from outside
  // that card and would otherwise walk straight past all of it.
  const eligible = fulfilment === "pickup" ? product.pickup_eligible : product.delivery_eligible;
  if (!eligible || product.sold_out || product.setup_required) return { fulfilment, product: null };
  const availability = product.configuration.availability as WeeklyAvailability | undefined;
  if (!isWithinWeeklyAvailability(availability, now)) return { fulfilment, product: null };

  return { fulfilment, product: hasCustomizer(product) ? product : null };
}
