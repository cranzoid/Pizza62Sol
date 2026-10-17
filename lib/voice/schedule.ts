/**
 * Order times for a phone caller, decided by the website's own rules.
 *
 * A caller says "tomorrow at half eleven" or "5:45 tonight"; the website shows
 * a dropdown. Both have to land on the same answer, so nothing here invents a
 * scheduling rule. The times a caller may choose are exactly the slots
 * `nextOrderSlots` produces for the checkout — inside opening hours, past the
 * current lead time, on the store's 15-minute grid — less any slot a closure
 * covers, judged by the same `closureFor` the order service applies. The
 * caller's words are only *matched* against those slots; a time that is not one
 * of them is refused with the nearest ones that are. `createOrder` still checks
 * the chosen slot again when the order is placed.
 *
 * The model never sends a timestamp. It passes a day ("today", "tomorrow", a
 * weekday or a date) and a local clock time; the server turns them into the
 * slot's own absolute timestamp, in America/Toronto, across daylight saving.
 *
 * Pure: every function takes the clock and the settings it needs.
 */
import { closureFor } from "@/lib/closures";
import {
  nextOrderSlots,
  zonedDateTimeToUtc,
  zonedParts,
  type Fulfilment,
  type StoreClosure,
  type WeeklyHours,
} from "@/lib/domain";

export const VOICE_TIME_ZONE = "America/Toronto";

/**
 * The checkout's grid, for wording only (the step a caller hears). The slots
 * themselves come from `nextOrderSlots`, called as the checkout calls it, so its
 * own defaults (15-minute grid, first 48 slots) are the only definition of
 * which times a customer is offered. There is deliberately no second horizon
 * here: the server's outer bound is 14 days (`validateSchedule`), the website
 * offers far less, and voice follows the website.
 */
export const SCHEDULE_INTERVAL_MINUTES = 15;
/** How many days of opening hours a caller can ask about. Unrelated to scheduling. */
const HOURS_DAYS = 7;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "2026-10-15": the restaurant's calendar date for an instant. */
export function localDate(timestamp: number, timeZone = VOICE_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));
}

/** Noon on a local date: a safe anchor for day arithmetic across daylight saving. */
function localNoon(date: string, timeZone = VOICE_TIME_ZONE): number {
  return zonedDateTimeToUtc(date, 12 * 60, timeZone);
}

/** The local date `offset` days after `now`'s. */
export function localDateAfter(now: number, offset: number, timeZone = VOICE_TIME_ZONE): string {
  return localDate(localNoon(localDate(now, timeZone), timeZone) + offset * 86_400_000, timeZone);
}

/** "6:15 PM", "noon", "midnight". */
export function minuteLabel(minuteOfDay: number): string {
  const minute = ((minuteOfDay % 1440) + 1440) % 1440;
  if (minute === 0) return "midnight";
  if (minute === 720) return "noon";
  const hour = Math.floor(minute / 60);
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minute % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

export function clockLabel(timestamp: number, timeZone = VOICE_TIME_ZONE): string {
  return minuteLabel(zonedParts(timestamp, timeZone).minute);
}

/** "today", "tomorrow", or "Monday, October 19" — how a person names a day on the phone. */
export function dayLabel(date: string, now: number, timeZone = VOICE_TIME_ZONE): string {
  if (date === localDate(now, timeZone)) return "today";
  if (date === localDateAfter(now, 1, timeZone)) return "tomorrow";
  const noon = localNoon(date, timeZone);
  return new Date(noon).toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric", timeZone });
}

/** "today at 6:15 PM", "tomorrow at 11:00 AM", "Monday, October 19 at noon". */
export function spokenWhen(timestamp: number, now: number, timeZone = VOICE_TIME_ZONE): string {
  return `${dayLabel(localDate(timestamp, timeZone), now, timeZone)} at ${clockLabel(timestamp, timeZone)}`;
}

/**
 * The local date a caller named, or null when it is not a day this can read.
 *
 * Accepts "today"/"tonight", "tomorrow", a weekday (the next one, today
 * included) and an ISO date. Anything else — "next week", "the 15th" — is for
 * the agent to ask about, not for this to guess.
 */
export function parseDay(raw: string, now: number, timeZone = VOICE_TIME_ZONE): string | null {
  const day = raw.trim().toLowerCase().replace(/[.,]/g, "");
  if (day === "today" || day === "tonight" || day === "this evening" || day === "this afternoon") return localDate(now, timeZone);
  if (day === "tomorrow" || day === "tomorrow night") return localDateAfter(now, 1, timeZone);
  const weekday = WEEKDAYS.indexOf(day.replace(/^(this|on)\s+/, ""));
  if (weekday >= 0) {
    const today = zonedParts(now, timeZone).weekday;
    return localDateAfter(now, (weekday - today + 7) % 7, timeZone);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const [year, month, date] = day.split("-").map(Number);
    const check = new Date(Date.UTC(year, month - 1, date));
    if (check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === date) return day;
  }
  return null;
}

/**
 * A local clock time as minutes past midnight, or null.
 *
 * "17:45", "5:45 PM", "5 pm", "noon". A bare "5:45" is read as written, a
 * quarter to six in the morning — the tool asks for 24-hour time, and a time
 * the store is closed at is refused with the slots that exist, so a missing
 * "PM" turns into a question rather than a wrong order.
 */
export function parseTime(raw: string): number | null {
  const time = raw.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
  if (time === "noon" || time === "midday") return 720;
  if (time === "midnight") return 0;
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(time);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3];
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (meridiem === "pm" && hour !== 12) hour += 12;
  } else if (hour > 23 || (match[2] === undefined && hour > 12)) {
    return null;
  }
  return hour * 60 + minute;
}

export type SlotSettings = {
  now: number;
  hours: WeeklyHours;
  closures: StoreClosure[];
  fulfilment: Fulfilment;
  /** The current lead time for this fulfilment: the website's estimate. */
  leadMinutes: number;
  timeZone?: string;
};

/**
 * Every time this fulfilment can be ordered for: exactly the list the website's
 * checkout dropdown shows (same call, same arguments, so same defaults), less any
 * slot a closure covers. The dropdown lists closed slots and lets the order
 * service refuse them; a phone caller is only offered ones that will be accepted.
 */
export function orderSlots(settings: SlotSettings): number[] {
  return nextOrderSlots({
    now: settings.now,
    hours: settings.hours,
    timeZone: settings.timeZone ?? VOICE_TIME_ZONE,
    leadMinutes: settings.leadMinutes,
  }).filter((slot) => !closureFor(slot, settings.closures, settings.fulfilment));
}

export type SlotRefusal =
  | "invalid_day"
  | "invalid_time"
  | "past"
  | "too_soon"
  | "beyond_horizon" // later than the last time the website's checkout offers
  | "closed_that_day"
  | "outside_hours"
  | "closure"
  | "off_grid";

export type SlotResolution =
  | { ok: true; slot: number }
  | { ok: false; reason: SlotRefusal; date: string | null; suggestions: number[]; closure: StoreClosure | null };

/**
 * The slot a caller asked for, or why there is none and the nearest that exist.
 *
 * Matching is by local date and minute against `orderSlots`, so the timestamp
 * returned is always one `nextOrderSlots` produced — never one built here.
 */
export function resolveSlot(day: string, time: string, settings: SlotSettings): SlotResolution {
  const timeZone = settings.timeZone ?? VOICE_TIME_ZONE;
  const date = parseDay(day, settings.now, timeZone);
  const minute = parseTime(time);
  const slots = orderSlots(settings);
  const nearest = (target: number, pool = slots) =>
    [...pool].sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b).slice(0, 2).sort((a, b) => a - b);
  if (!date) return { ok: false, reason: "invalid_day", date: null, suggestions: slots.slice(0, 1), closure: null };
  if (minute === null) return { ok: false, reason: "invalid_time", date, suggestions: [], closure: null };

  const found = slots.find((slot) => localDate(slot, timeZone) === date && zonedParts(slot, timeZone).minute === minute);
  if (found !== undefined) return { ok: true, slot: found };

  const requested = zonedDateTimeToUtc(date, minute, timeZone);
  const sameDay = slots.filter((slot) => localDate(slot, timeZone) === date);
  const refuse = (reason: SlotRefusal, suggestions: number[], closure: StoreClosure | null = null): SlotResolution =>
    ({ ok: false, reason, date, suggestions, closure });

  if (requested <= settings.now) return refuse("past", slots.slice(0, 1));
  if (requested < settings.now + settings.leadMinutes * 60_000) return refuse("too_soon", slots.slice(0, 1));
  // A closure is the better answer for a time it covers, wherever that time falls.
  const closure = closureFor(requested, settings.closures, settings.fulfilment);
  if (closure) return refuse("closure", nearest(requested), closure);
  if (slots.length && requested > slots[slots.length - 1]) return refuse("beyond_horizon", slots.slice(-1));
  const weekday = zonedParts(localNoon(date, timeZone), timeZone).weekday;
  const hours = settings.hours.find((entry) => entry.weekday === weekday);
  if (!hours) return refuse("closed_that_day", slots.filter((slot) => slot > requested).slice(0, 1));
  if (minute < hours.openMinute || minute > Math.min(hours.closeMinute, 1439)) {
    // That day's first and last slot when it has any, so the refusal can say the range.
    const range = sameDay.length > 1 ? [sameDay[0], sameDay[sameDay.length - 1]] : sameDay;
    return refuse("outside_hours", range.length ? range : slots.filter((slot) => slot > requested).slice(0, 1));
  }
  return refuse("off_grid", nearest(requested, sameDay.length ? sameDay : slots));
}

export type DaySummary = {
  date: string;
  label: string;
  weekday: string;
  /** Null when the store has no hours that day. */
  opensAt: string | null;
  closesAt: string | null;
  /** When new orders stop that day (the last-order cutoff before closing). */
  lastOrdersAt: string | null;
  /** True when a closure covers the whole of that day's opening hours, or there are none. */
  closed: boolean;
  /** A closure's own customer message, when one touches that day. */
  closureMessage: string | null;
};

/** The next `days` days' hours as a caller would ask about them, closures included. */
export function upcomingDays(input: {
  now: number;
  hours: WeeklyHours;
  closures: StoreClosure[];
  lastOrderCutoffMinutes: number;
  closureMessage: (closure: StoreClosure) => string;
  days?: number;
  timeZone?: string;
}): DaySummary[] {
  const timeZone = input.timeZone ?? VOICE_TIME_ZONE;
  const summaries: DaySummary[] = [];
  for (let offset = 0; offset < (input.days ?? HOURS_DAYS); offset += 1) {
    const date = localDateAfter(input.now, offset, timeZone);
    const weekday = zonedParts(localNoon(date, timeZone), timeZone).weekday;
    const hours = input.hours.find((entry) => entry.weekday === weekday);
    const base = { date, label: dayLabel(date, input.now, timeZone), weekday: WEEKDAY_NAMES[weekday] };
    if (!hours) {
      summaries.push({ ...base, opensAt: null, closesAt: null, lastOrdersAt: null, closed: true, closureMessage: null });
      continue;
    }
    const opens = zonedDateTimeToUtc(date, hours.openMinute, timeZone);
    const closes = zonedDateTimeToUtc(date, hours.closeMinute, timeZone);
    const touching = input.closures.filter((closure) => closure.startsAt < closes && closure.endsAt > opens);
    const whole = touching.find((closure) => closure.scope === "both" && closure.startsAt <= opens && closure.endsAt >= closes);
    const cutoff = Math.max(0, input.lastOrderCutoffMinutes);
    summaries.push({
      ...base,
      opensAt: minuteLabel(hours.openMinute),
      closesAt: minuteLabel(hours.closeMinute),
      lastOrdersAt: minuteLabel(Math.max(hours.openMinute, hours.closeMinute - cutoff)),
      closed: Boolean(whole),
      closureMessage: touching.length ? input.closureMessage(whole ?? touching[0]) : null,
    });
  }
  return summaries;
}
