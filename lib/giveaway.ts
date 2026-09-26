/**
 * The Pizza 62 Thanksgiving Giveaway: the rules, as pure functions.
 *
 * Pizza 62 turns one this autumn, and the giveaway is how it says thank you:
 * every order of C$10 or more (food before tax, after any discount) placed
 * before closing on Sunday, October 11 earns one entry, and one entry wins a
 * brand-new 55-inch TV on Thanksgiving Monday, October 12.
 *
 * **It is a giveaway, and every word a customer reads says so.** The owner
 * was explicit about the wording, so nothing customer-facing calls it a
 * draw, a raffle or a lottery.
 *
 * Nothing in this file touches the database. What an order is worth, whether
 * it falls inside the window, how an entry number is written and when a nudge
 * goes out are all decided here, so the storefront, the till, the emails and
 * the server can never disagree about them — and so they can be tested without
 * Postgres. The database half is `lib/giveaway-store.ts`.
 *
 * ## Why the minimum is measured on food before tax
 *
 * The owner's rule is "an order of at least $10", and the figure it is measured
 * on is the menu subtotal after any promo discount, before HST, the delivery
 * fee and the tip. That is the usual "$10 before tax" contest wording, and it
 * means a delivery fee or a tip can never be what carries an order over the
 * line. A gift card is a tender, not a discount, so paying with one changes
 * nothing here.
 */

export type GiveawaySetting = {
  /** Owns the entries. Changing it starts a fresh set of entry numbers. */
  id: string;
  enabled: boolean;
  /** "Thanksgiving Giveaway" — the name customers see. */
  title: string;
  /** Written to follow "win": "a brand-new 55-inch TV". */
  prize: string;
  /** Food before tax, after discounts. */
  minimumCents: number;
  /** Orders placed at or after this count. Set to the moment the giveaway went live. */
  startsAt: number;
  /** Orders placed before this count. Midnight at the end of the last day, Toronto time. */
  endsAt: number;
  /** Free text, because "Thanksgiving Monday" is not something a date formatter says. */
  winnerAnnouncedOn: string;
  /** The most nudge emails to release per day. See `planNudgeSchedule`. */
  nudgePerDay: number;
};

export const GIVEAWAY_ID = "thanksgiving-2026";

/**
 * The launch values.
 *
 * `startsAt` is deliberately absent: the giveaway starts when this code goes
 * live, so the data migration that first writes the setting stamps it with the
 * moment it runs. `endsAt` is midnight at the end of Sunday, October 11 in
 * Toronto (EDT, UTC−4) — Sunday closes at 10 p.m., so this covers the last
 * order of the night with room to spare and nothing on the Monday.
 */
export const GIVEAWAY_DEFAULTS: Omit<GiveawaySetting, "startsAt"> = {
  id: GIVEAWAY_ID,
  enabled: true,
  title: "Thanksgiving Giveaway",
  prize: "a brand-new 55-inch TV",
  minimumCents: 1000,
  endsAt: Date.parse("2026-10-12T00:00:00-04:00"),
  winnerAnnouncedOn: "Thanksgiving Monday, October 12",
  nudgePerDay: 80,
};

const TORONTO = "America/Toronto";

/** Reads the stored setting defensively: a hand-edited row must not break checkout. */
export function normalizeGiveaway(raw: unknown): GiveawaySetting | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<Record<keyof GiveawaySetting, unknown>>;
  const startsAt = Number(value.startsAt);
  const endsAt = Number(value.endsAt);
  const minimumCents = Number(value.minimumCents);
  const nudgePerDay = Number(value.nudgePerDay);
  if (!Number.isSafeInteger(startsAt) || !Number.isSafeInteger(endsAt) || endsAt <= startsAt) return null;
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : GIVEAWAY_ID,
    enabled: value.enabled === true,
    title: typeof value.title === "string" && value.title.trim() ? value.title.trim() : GIVEAWAY_DEFAULTS.title,
    prize: typeof value.prize === "string" && value.prize.trim() ? value.prize.trim() : GIVEAWAY_DEFAULTS.prize,
    minimumCents: Number.isSafeInteger(minimumCents) && minimumCents >= 0 ? minimumCents : GIVEAWAY_DEFAULTS.minimumCents,
    startsAt,
    endsAt,
    winnerAnnouncedOn:
      typeof value.winnerAnnouncedOn === "string" && value.winnerAnnouncedOn.trim()
        ? value.winnerAnnouncedOn.trim()
        : GIVEAWAY_DEFAULTS.winnerAnnouncedOn,
    nudgePerDay: Number.isSafeInteger(nudgePerDay) && nudgePerDay > 0 ? nudgePerDay : GIVEAWAY_DEFAULTS.nudgePerDay,
  };
}

export type GiveawayStatus = "off" | "upcoming" | "open" | "closed";

export function giveawayStatus(giveaway: GiveawaySetting | null, now: number): GiveawayStatus {
  if (!giveaway || !giveaway.enabled) return "off";
  if (now < giveaway.startsAt) return "upcoming";
  if (now >= giveaway.endsAt) return "closed";
  return "open";
}

/** The figure the minimum is measured on. Never negative. */
export function qualifyingCents(order: { subtotalCents: number; discountCents: number }): number {
  return Math.max(0, Math.round(Number(order.subtotalCents) || 0) - Math.round(Number(order.discountCents) || 0));
}

/**
 * Whether an order placed at `placedAt` for this much food earns an entry.
 *
 * Judged on when the order was *placed*, not when it was paid: a card payment
 * that clears a minute after midnight on the last night is still an order
 * placed on the Sunday.
 */
export function orderQualifies(
  giveaway: GiveawaySetting | null,
  order: { placedAt: number; subtotalCents: number; discountCents: number },
): boolean {
  if (!giveaway || !giveaway.enabled) return false;
  if (order.placedAt < giveaway.startsAt || order.placedAt >= giveaway.endsAt) return false;
  return qualifyingCents(order) >= giveaway.minimumCents;
}

/** How much more food would earn an entry, or 0 when this already does. */
export function centsToQualify(
  giveaway: Pick<GiveawaySetting, "minimumCents">,
  order: { subtotalCents: number; discountCents: number },
): number {
  return Math.max(0, giveaway.minimumCents - qualifyingCents(order));
}

/**
 * `42` → `"0042"`.
 *
 * Four digits so every number on every receipt is the same width, which is
 * what makes one easy to read out, write on a slip, or find in a list. A fifth
 * digit appears on its own if there are ever ten thousand entries.
 */
export function formatEntryNumber(entryNumber: number): string {
  return String(Math.max(0, Math.trunc(entryNumber))).padStart(4, "0");
}

function torontoDate(timestamp: number, options: Intl.DateTimeFormatOptions): string {
  return new Date(timestamp).toLocaleDateString("en-CA", { ...options, timeZone: TORONTO });
}

/**
 * "Sunday, October 11" — the last day orders count.
 *
 * `endsAt` is the midnight *after* that day, so the label is read one
 * millisecond earlier. Written "by closing on Sunday, October 11" in copy,
 * because "before 12:00 a.m. on October 12" is how nobody talks.
 */
export function lastEntryDayLabel(giveaway: GiveawaySetting): string {
  return torontoDate(giveaway.endsAt - 1, { weekday: "long", month: "long", day: "numeric" });
}

/** "C$10" rather than "C$10.00" when the minimum is a round number, which it is. */
export function minimumLabel(giveaway: GiveawaySetting): string {
  const dollars = giveaway.minimumCents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/**
 * The one-sentence version of the rules, used wherever there is room for only
 * one: the storefront strip, email small print, the till hint.
 */
export function giveawaySummary(giveaway: GiveawaySetting): string {
  return `Every order of ${minimumLabel(giveaway)} or more (before tax) placed by closing on ${lastEntryDayLabel(giveaway)} gets an entry to win ${giveaway.prize}.`;
}

/** What an anonymous storefront visitor may know, and only while it is running. */
export type PublicGiveaway = {
  status: "upcoming" | "open";
  title: string;
  prize: string;
  minimumCents: number;
  startsAt: number;
  endsAt: number;
  lastEntryDay: string;
  winnerAnnouncedOn: string;
};

export function publicGiveaway(giveaway: GiveawaySetting | null, now: number): PublicGiveaway | null {
  const status = giveawayStatus(giveaway, now);
  if (!giveaway || (status !== "open" && status !== "upcoming")) return null;
  return {
    status,
    title: giveaway.title,
    prize: giveaway.prize,
    minimumCents: giveaway.minimumCents,
    startsAt: giveaway.startsAt,
    endsAt: giveaway.endsAt,
    lastEntryDay: lastEntryDayLabel(giveaway),
    winnerAnnouncedOn: giveaway.winnerAnnouncedOn,
  };
}

// --- nudges ------------------------------------------------------------------

/** The two nudges the owner asked for, and a test send to themselves. */
export const NUDGES = {
  announce: { label: "First nudge", description: "Tells past customers the giveaway is on." },
  last_call: { label: "Last-call nudge", description: "The day before entries close." },
} as const;

export type NudgeKind = keyof typeof NUDGES;

export function isNudgeKind(value: unknown): value is NudgeKind {
  return typeof value === "string" && Object.hasOwn(NUDGES, value);
}

/**
 * Sending hours, Toronto time: 11 a.m. to 7 p.m.
 *
 * A pizza email is worth most just before someone decides what is for lunch or
 * dinner, and worth least at 3 a.m. under forty others. It also keeps a nudge
 * from landing on a phone in the middle of the night.
 */
export const NUDGE_WINDOW = { startMinute: 11 * 60, endMinute: 19 * 60 } as const;

function torontoMinuteOfDay(timestamp: number): number {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: TORONTO,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/**
 * When each of `count` nudge emails should be released.
 *
 * **Why nudges are paced at all.** The emails go through the same provider
 * account as order confirmations, and the provider's free plan stops at 100 a
 * day. A nudge that went out in one burst would spend the whole day's quota in
 * a minute, and every order confirmation after it would bounce off the limit —
 * the customer who has just paid hears nothing. So at most `perDay` are
 * released per day, and the rest roll on to the next day's sending hours. The
 * owner raises `perDay` on a paid plan.
 *
 * Within a day they are released about a minute apart rather than all at once,
 * so there is never a backlog of due nudges sitting in the outbox ahead of an
 * order confirmation that has just been queued.
 *
 * Minute-of-day arithmetic rather than day boundaries: the result only needs to
 * be right to within a DST hour, and none of the giveaway falls on a change.
 */
export function planNudgeSchedule(count: number, perDay: number, now: number): number[] {
  const safePerDay = Math.max(1, Math.trunc(perDay));
  const slots: number[] = [];
  const windowLength = (NUDGE_WINDOW.endMinute - NUDGE_WINDOW.startMinute) * 60_000;
  const minuteNow = torontoMinuteOfDay(now);
  // The start of today's window as an absolute time, found by walking back
  // from now by the minutes already elapsed (seconds dropped).
  const nowFloor = now - (now % 60_000);
  let windowStart = nowFloor + (NUDGE_WINDOW.startMinute - minuteNow) * 60_000;
  let cursor = Math.max(now, windowStart);
  while (slots.length < count) {
    const windowEnd = windowStart + windowLength;
    if (cursor >= windowEnd) {
      windowStart += 24 * 60 * 60_000;
      cursor = windowStart;
      continue;
    }
    const today = Math.min(safePerDay, count - slots.length);
    // A minute apart, or closer when today's batch would not otherwise fit in
    // what is left of the window.
    const spacing = Math.min(60_000, Math.floor((windowEnd - cursor) / today));
    for (let index = 0; index < today; index += 1) slots.push(cursor + index * spacing);
    windowStart += 24 * 60 * 60_000;
    cursor = windowStart;
  }
  return slots;
}
