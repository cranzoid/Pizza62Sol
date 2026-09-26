/**
 * Admin → Giveaway.
 *
 * Everything the owner needs for the Thanksgiving Giveaway on one screen: how
 * many entries there are, whose each number is, the two nudge buttons and how
 * far each has got, and — once entries close — picking the winner.
 *
 * Gated on `manage_promotions`, the same as every other offer. Two things are
 * tighter:
 *
 * - **Picking the winner is owner-only.** It decides who gets the TV, and it
 *   is recorded on the entry the moment it is made.
 * - **Contact details follow `view_customer_contact`**, exactly as order
 *   history does: without it, names and entry numbers are shown and emails and
 *   phones are masked.
 */
import { AuthError, authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1, writeAudit } from "@/db/runtime";
import { hasPermission } from "@/lib/domain";
import { emailConfig } from "@/lib/notifications/config";
import { dispatchSoon } from "@/lib/notifications/dispatcher";
import { logFailure } from "@/lib/log";
import { giveawayStatus, isNudgeKind, NUDGES, type GiveawaySetting } from "@/lib/giveaway";
import {
  allGiveawayEntries,
  giveawayStats,
  listGiveawayEntries,
  loadGiveaway,
  pickedEntries,
  pickGiveawayWinner,
  type GiveawayEntryRow,
} from "@/lib/giveaway-store";
import {
  cancelNudge,
  NudgeError,
  nudgeAudience,
  nudgeSends,
  queueNudge,
  queueTestNudge,
  recentEmailVolume,
} from "@/lib/giveaway-nudges";
import { ISO_DATE_RE, nextCalendarDate, torontoDayStart } from "@/lib/report-dates";

const PAGE_SIZE = 50;

async function requireGiveawayStaff(request: Request) {
  const user = await requireStaff(request, "view_orders");
  if (!hasPermission(user.role, user.permissions, "manage_promotions")) {
    throw new AuthError(403, "You do not have permission to manage the giveaway.");
  }
  return user;
}

function canSeeContact(user: { role: string; permissions: string[] }): boolean {
  return user.role === "owner" || user.permissions.includes("view_customer_contact");
}

function masked(entry: GiveawayEntryRow, canViewContact: boolean): GiveawayEntryRow {
  if (canViewContact) return entry;
  return {
    ...entry,
    customer_email: entry.customer_email ? "•••" : "",
    customer_phone: entry.customer_phone ? `•••${entry.customer_phone.replace(/\D/g, "").slice(-2)}` : "",
  };
}

function torontoMidnight(now: number): number {
  return torontoDayStart(new Date(now).toLocaleDateString("en-CA", { timeZone: "America/Toronto" }));
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireGiveawayStaff(request);
    const url = new URL(request.url);
    const giveaway = await loadGiveaway();
    if (!giveaway) return Response.json({ giveaway: null });
    const contact = canSeeContact(user);

    if (url.searchParams.get("format") === "csv") {
      if (!contact) {
        return Response.json({ error: "Exporting entries needs the customer contact permission." }, { status: 403 });
      }
      const entries = await allGiveawayEntries(giveaway.id);
      // Contact data leaving the building — audited like every other export.
      await writeAudit({
        actorId: user.id,
        action: "giveaway.export",
        targetType: "giveaway",
        targetId: giveaway.id,
        next: { rows: entries.length },
      });
      return new Response(entriesCsv(entries), {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="pizza62-${giveaway.id}-entries.csv"`,
          "cache-control": "no-store",
        },
      });
    }

    const now = Date.now();
    const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);
    const query = url.searchParams.get("q") ?? "";
    const [stats, list, picks, sends, announce, lastCall, volume, email] = await Promise.all([
      giveawayStats(giveaway.id, torontoMidnight(now)),
      listGiveawayEntries(giveaway.id, { query, limit: PAGE_SIZE, offset: page * PAGE_SIZE, searchContact: contact }),
      pickedEntries(giveaway.id),
      nudgeSends(giveaway.id),
      nudgeAudience(giveaway.id, "announce"),
      nudgeAudience(giveaway.id, "last_call"),
      recentEmailVolume(now),
      emailConfig(),
    ]);
    const audience = (result: Awaited<ReturnType<typeof nudgeAudience>>) => ({
      ready: result.recipients.length,
      optedOut: result.optedOut,
      alreadyNudged: result.alreadyNudged,
    });
    return Response.json({
      giveaway,
      status: giveawayStatus(giveaway, now),
      now,
      stats,
      entries: list.entries.map((entry) => masked(entry, contact)),
      total: list.total,
      page,
      pageSize: PAGE_SIZE,
      picks: picks.map((entry) => masked(entry, contact)),
      nudges: { announce: audience(announce), last_call: audience(lastCall) },
      sends,
      emailVolume: volume,
      emailReady: email !== null,
      canPick: user.role === "owner",
      canViewContact: contact,
      me: { email: user.email, name: user.name },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

type Body =
  | {
      action: "settings";
      enabled?: boolean;
      title?: string;
      prize?: string;
      minimumCents?: number;
      lastDay?: string;
      winnerAnnouncedOn?: string;
      nudgePerDay?: number;
    }
  | { action: "nudge.send"; nudge?: string; perDay?: number }
  | { action: "nudge.test"; variant?: string; email?: string }
  | { action: "nudge.stop"; sendId?: string }
  | { action: "winner.pick" };

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean && clean.length <= max ? clean : null;
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireGiveawayStaff(request);
    const body = (await request.json()) as Body;
    const giveaway = await loadGiveaway();
    if (!giveaway) return Response.json({ error: "The giveaway has not been set up." }, { status: 404 });
    const now = Date.now();

    switch (body.action) {
      case "settings": {
        const next: GiveawaySetting = { ...giveaway };
        if (typeof body.enabled === "boolean") next.enabled = body.enabled;
        if (body.title !== undefined) {
          const title = cleanText(body.title, 80);
          if (!title) return Response.json({ error: "Give the giveaway a name." }, { status: 422 });
          next.title = title;
        }
        if (body.prize !== undefined) {
          const prize = cleanText(body.prize, 120);
          if (!prize) return Response.json({ error: "Describe the prize." }, { status: 422 });
          next.prize = prize;
        }
        if (body.winnerAnnouncedOn !== undefined) {
          const announced = cleanText(body.winnerAnnouncedOn, 80);
          if (!announced) return Response.json({ error: "Say when the winner is announced." }, { status: 422 });
          next.winnerAnnouncedOn = announced;
        }
        if (body.minimumCents !== undefined) {
          const minimum = Number(body.minimumCents);
          if (!Number.isSafeInteger(minimum) || minimum < 0 || minimum > 100_000) {
            return Response.json({ error: "The minimum must be between $0 and $1,000." }, { status: 422 });
          }
          next.minimumCents = minimum;
        }
        if (body.lastDay !== undefined) {
          if (typeof body.lastDay !== "string" || !ISO_DATE_RE.test(body.lastDay)) {
            return Response.json({ error: "Choose the last day orders count." }, { status: 422 });
          }
          // The last day counts in full: entries close at the midnight after it.
          const endsAt = torontoDayStart(nextCalendarDate(body.lastDay));
          if (endsAt <= next.startsAt) {
            return Response.json({ error: "The last day has to be after the giveaway started." }, { status: 422 });
          }
          next.endsAt = endsAt;
        }
        if (body.nudgePerDay !== undefined) {
          const perDay = Number(body.nudgePerDay);
          if (!Number.isSafeInteger(perDay) || perDay < 1 || perDay > 5000) {
            return Response.json({ error: "The daily nudge limit must be between 1 and 5,000." }, { status: 422 });
          }
          next.nudgePerDay = perDay;
        }
        await saveGiveaway(next, user.id);
        await writeAudit({
          actorId: user.id,
          action: "giveaway.settings",
          targetType: "giveaway",
          targetId: giveaway.id,
          previous: giveaway,
          next,
        });
        return Response.json({ ok: true, giveaway: next });
      }

      case "nudge.send": {
        if (!isNudgeKind(body.nudge)) return Response.json({ error: "Choose which nudge to send." }, { status: 400 });
        if (giveawayStatus(giveaway, now) !== "open") {
          return Response.json({ error: "The giveaway is not open, so there is nothing to nudge people about." }, { status: 409 });
        }
        const perDay = Number(body.perDay ?? giveaway.nudgePerDay);
        if (!Number.isSafeInteger(perDay) || perDay < 1 || perDay > 5000) {
          return Response.json({ error: "The daily limit must be between 1 and 5,000." }, { status: 422 });
        }
        const result = await queueNudge({ campaign: giveaway.id, nudge: body.nudge, perDay, actorId: user.id, now });
        // Remember the pace, so the next press starts from what was used last.
        if (perDay !== giveaway.nudgePerDay) await saveGiveaway({ ...giveaway, nudgePerDay: perDay }, user.id);
        await writeAudit({
          actorId: user.id,
          action: "giveaway.nudge",
          targetType: "giveaway",
          targetId: giveaway.id,
          next: { nudge: body.nudge, label: NUDGES[body.nudge].label, ...result, perDay },
        });
        dispatchSoon();
        return Response.json({ ok: true, ...result });
      }

      case "nudge.test": {
        const variant = isNudgeKind(body.variant) ? body.variant : "announce";
        await queueTestNudge({ campaign: giveaway.id, variant, email: String(body.email ?? user.email), name: user.name, now });
        dispatchSoon();
        return Response.json({ ok: true });
      }

      case "nudge.stop": {
        const sendId = typeof body.sendId === "string" ? body.sendId : "";
        if (!sendId) return Response.json({ error: "Which nudge?" }, { status: 400 });
        const stopped = await cancelNudge(sendId, now);
        await writeAudit({
          actorId: user.id,
          action: "giveaway.nudge_stop",
          targetType: "giveaway",
          targetId: sendId,
          next: { stopped },
        });
        return Response.json({ ok: true, stopped });
      }

      case "winner.pick": {
        if (user.role !== "owner") throw new AuthError(403, "Only the owner can pick the winner.");
        // Not before entries close: an entry that has not been made yet deserves
        // the same chance as one that has.
        if (now < giveaway.endsAt) {
          return Response.json(
            { error: "Entries are still open. The winner can be picked once they close." },
            { status: 409 },
          );
        }
        const winner = await pickGiveawayWinner(giveaway.id, user.id, now);
        if (!winner) return Response.json({ error: "There are no eligible entries left to pick from." }, { status: 409 });
        await writeAudit({
          actorId: user.id,
          action: "giveaway.pick",
          targetType: "giveaway_entry",
          targetId: winner.id,
          next: { entry: winner.entry_label, orderNumber: winner.order_number },
        });
        return Response.json({ ok: true, winner: masked(winner, canSeeContact(user)) });
      }

      default:
        return Response.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof NudgeError) return Response.json({ error: error.message }, { status: 409 });
    if (error instanceof AuthError) return authErrorResponse(error);
    const reference = logFailure("admin.giveaway", error);
    return Response.json({ error: "That did not work. Nothing was changed.", reference }, { status: 500 });
  }
}

async function saveGiveaway(value: GiveawaySetting, actorId: string): Promise<void> {
  await getD1()
    .prepare("UPDATE settings SET value_json = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE key = 'giveaway'")
    .bind(JSON.stringify(value), actorId, Date.now())
    .run();
}

/** Same formula-injection guard as the other exports. */
function csvField(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${guarded.replaceAll('"', '""')}"`;
}

function entriesCsv(entries: GiveawayEntryRow[]): string {
  const stamp = (value: number | null) =>
    value ? new Date(value).toLocaleString("en-CA", { timeZone: "America/Toronto", hour12: false }) : "";
  const lines = [
    ["Entry", "Order", "Name", "Phone", "Email", "Food before tax", "Where", "Entered", "Still eligible", "Picked"]
      .map(csvField)
      .join(","),
  ];
  for (const entry of entries) {
    lines.push(
      [
        entry.entry_label,
        entry.order_number,
        entry.customer_name,
        entry.customer_phone,
        entry.customer_email,
        (entry.qualifying_cents / 100).toFixed(2),
        `${entry.channel === "online" ? "website" : entry.channel.replace("_", "-")} ${entry.fulfilment}`,
        stamp(entry.created_at),
        entry.eligible ? "yes" : "no (cancelled or refunded)",
        stamp(entry.picked_at),
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
