/**
 * How each order channel is named to people.
 *
 * The channel was labelled in five places — the order drawer, order history, the
 * customer directory, the giveaway screen and two kitchen tickets — each with
 * its own copy of the map, and the ticket derived its label by upper-casing the
 * database value. That was tolerable with three channels; a fourth (`ai_phone`)
 * is exactly where a copy gets missed and an AI-taken order is shown as a raw
 * id or, worse, as a staff phone order. One map, used everywhere.
 *
 * Pure and dependency-free so the browser bundles can import it. Keyed by plain
 * strings rather than the schema's tuple so client code does not pull in
 * drizzle; `tests/ai-phone-channel.test.ts` keeps the keys equal to
 * `ORDER_CHANNELS`.
 */

/** The label the owner would use, not the database value. */
export const ORDER_CHANNEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  online: "Website",
  phone: "Phone",
  walk_in: "Walk-in",
  ai_phone: "AI phone",
});

/** Upper-case, for the kitchen ticket and the restaurant alert, where it has to be read at a glance. */
export const ORDER_CHANNEL_TICKET_LABELS: Readonly<Record<string, string>> = Object.freeze({
  online: "WEBSITE",
  phone: "PHONE",
  walk_in: "WALK IN",
  ai_phone: "AI PHONE",
});

/** The order the channels are listed in on screens that show all of them. */
export const ORDER_CHANNEL_DISPLAY_ORDER: readonly string[] = Object.freeze(["online", "phone", "walk_in", "ai_phone"]);

export function orderChannelLabel(channel: unknown): string {
  const key = String(channel ?? "online");
  return ORDER_CHANNEL_LABELS[key] ?? key;
}

export function orderChannelTicketLabel(channel: unknown): string {
  const key = String(channel ?? "online");
  return ORDER_CHANNEL_TICKET_LABELS[key] ?? key.replaceAll("_", " ").toUpperCase();
}

/**
 * True for an order the restaurant took itself — by staff at the till, or by
 * its own phone line — rather than one a customer placed on the website. Such
 * an order never has a campaign to attribute.
 */
export function takenByRestaurant(channel: unknown): boolean {
  return channel === "phone" || channel === "walk_in" || channel === "ai_phone";
}
