/**
 * Admin → one-day promotions (today: Monday Wings), by email and text.
 *
 * The same audience, pacing, opt-out and delivery tracking as the giveaway
 * nudges (lib/giveaway-nudges.ts), pointed at a dated promo campaign instead
 * of the giveaway. Needs `manage_promotions`, like importing the customer list.
 *
 * - GET  → who would be reached on each channel, the send schedule, past sends
 * - POST test  → one message to one address, marked [TEST]
 * - POST send  → queue the whole audience (once per channel per Monday)
 * - POST stop  → cancel whatever of a send has not gone yet
 *
 * Nothing is scheduled past midnight Toronto time, and a message still queued
 * after midnight is skipped by the dispatcher rather than saying "today" on
 * the wrong day.
 */
import { AuthError, authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1, writeAudit } from "@/db/runtime";
import { hasPermission } from "@/lib/domain";
import { planOutreachSchedule } from "@/lib/giveaway";
import {
  cancelNudge,
  isAudienceSource,
  isNudgeChannel,
  NudgeError,
  nudgeAudience,
  nudgeChannelBlocker,
  nudgeOutboxKind,
  nudgeSends,
  queueNudge,
  queueTestNudge,
} from "@/lib/giveaway-nudges";
import { dispatchSoon } from "@/lib/notifications/dispatcher";
import { endOfTorontoDay, mondayWingsCampaign, torontoWeekday } from "@/lib/promo-campaigns";

async function requirePromoStaff(request: Request) {
  const user = await requireStaff(request, "view_orders");
  if (!hasPermission(user.role, user.permissions, "manage_promotions")) {
    throw new AuthError(403, "You do not have permission to send promotions.");
  }
  return user;
}

type ChannelPlan = {
  channel: "email" | "sms";
  blocker: string | null;
  audienceTotal: number;
  ready: number;
  optedOut: number;
  alreadySent: number;
  waiting: number;
  queued: number;
  notQueued: number;
  firstSendAt: number | null;
  lastSendAt: number | null;
};

async function planChannel(campaign: string, channel: "email" | "sms", perDay: number, intervalMinutes: number, now: number, source: "all" | "imported" | "orders"): Promise<ChannelPlan> {
  const [audience, blocker, reserved] = await Promise.all([
    nudgeAudience(campaign, "announce", channel, source, "new"),
    nudgeChannelBlocker(channel),
    getD1()
      .prepare(`SELECT CASE WHEN status = 'sent' THEN sent_at ELSE scheduled_for END AS at
        FROM notification_outbox WHERE kind = ? AND (status IN ('pending', 'retrying', 'sending', 'pending_provider_setup')
        OR (status = 'sent' AND sent_at >= ?))`)
      .bind(nudgeOutboxKind(channel), now - 86_400_000)
      .all<{ at: number }>(),
  ]);
  const schedule = planOutreachSchedule({
    count: audience.recipients.length, perDay, intervalMinutes, now, endsAt: endOfTorontoDay(now),
    reserved: reserved.results.map((row) => Number(row.at)),
  });
  return {
    channel, blocker, audienceTotal: audience.total, ready: audience.recipients.length, optedOut: audience.optedOut,
    alreadySent: audience.alreadyNudged, waiting: audience.waiting, queued: schedule.length,
    notQueued: audience.recipients.length - schedule.length, firstSendAt: schedule[0] ?? null, lastSendAt: schedule.at(-1) ?? null,
  };
}

function readSource(value: unknown): "all" | "imported" | "orders" {
  return isAudienceSource(value) ? value : "all";
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    await requirePromoStaff(request);
    const url = new URL(request.url);
    const now = Date.now();
    const campaign = mondayWingsCampaign(now);
    const source = readSource(url.searchParams.get("source"));
    const emailPerDay = Math.max(1, Math.min(5000, Math.trunc(Number(url.searchParams.get("emailPerDay")) || 80)));
    const emailInterval = Math.max(1, Math.min(60, Math.trunc(Number(url.searchParams.get("emailInterval")) || 1)));
    const [sms, email, sends] = await Promise.all([
      planChannel(campaign, "sms", 5000, 0, now, source),
      planChannel(campaign, "email", emailPerDay, emailInterval, now, source),
      nudgeSends(campaign),
    ]);
    return Response.json({ campaign, today: torontoWeekday(now), sms, email, sends }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return authErrorResponse(error);
  }
}

type Body =
  | { action: "test"; channel?: string; email?: string; phone?: string }
  | { action: "send"; channel?: string; perDay?: number; intervalMinutes?: number; source?: string; requestKey?: string }
  | { action: "stop"; sendId?: string };

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const user = await requirePromoStaff(request);
    const body = (await request.json()) as Body;
    const now = Date.now();
    const campaign = mondayWingsCampaign(now);

    switch (body.action) {
      case "test": {
        const channel = isNudgeChannel(body.channel) ? body.channel : "email";
        const to = channel === "sms" ? String(body.phone ?? "") : String(body.email ?? user.email);
        await queueTestNudge({ campaign, variant: "announce", to, name: user.name, channel, now });
        dispatchSoon();
        return Response.json({ ok: true });
      }

      case "send": {
        if (torontoWeekday(now) !== "Monday") {
          return Response.json({ error: "Monday Wings is only promoted on a Monday (Toronto time)." }, { status: 409 });
        }
        if (!isNudgeChannel(body.channel)) return Response.json({ error: "Choose email or SMS." }, { status: 422 });
        const channel = body.channel;
        const perDay = Number(body.perDay ?? (channel === "sms" ? 5000 : 80));
        if (!Number.isSafeInteger(perDay) || perDay < 1 || perDay > 5000) {
          return Response.json({ error: "The daily limit must be between 1 and 5,000." }, { status: 422 });
        }
        const intervalMinutes = Number(body.intervalMinutes ?? (channel === "sms" ? 0 : 1));
        if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < (channel === "sms" ? 0 : 1) || intervalMinutes > 60) {
          return Response.json({ error: "Choose a valid pace. Texts can go together; emails need a minute between messages." }, { status: 422 });
        }
        if (body.source !== undefined && !isAudienceSource(body.source)) {
          return Response.json({ error: "Choose a customer audience." }, { status: 422 });
        }
        const result = await queueNudge({
          campaign, nudge: "announce", perDay, actorId: user.id, channel, now, intervalMinutes,
          source: readSource(body.source), mode: "new", endsAt: endOfTorontoDay(now),
          requestKey: typeof body.requestKey === "string" ? body.requestKey.slice(0, 80) : undefined,
        });
        await writeAudit({
          actorId: user.id, action: "promo.send", targetType: "promo", targetId: campaign,
          next: { channel, perDay, intervalMinutes, ...result },
        });
        dispatchSoon({ drain: channel === "sms" && intervalMinutes === 0 });
        return Response.json({ ok: true, ...result });
      }

      case "stop": {
        const sendId = typeof body.sendId === "string" ? body.sendId : "";
        if (!sendId) return Response.json({ error: "Which send?" }, { status: 400 });
        const stopped = await cancelNudge(sendId, now);
        await writeAudit({ actorId: user.id, action: "promo.stop", targetType: "promo", targetId: sendId, next: { stopped } });
        return Response.json({ ok: true, stopped });
      }

      default:
        return Response.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (error) {
    if (error instanceof NudgeError) return Response.json({ error: error.message }, { status: 409 });
    return authErrorResponse(error);
  }
}
