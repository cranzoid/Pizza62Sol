/**
 * Nudging past customers about the giveaway — sent when the owner presses the
 * button, never on a timer.
 *
 * The owner asked for two: one to say the giveaway is on, and one the day
 * before it closes. Each is a button in Admin → Giveaway, and each goes to
 * everyone at most once: pressing it a second time only reaches people added
 * since (a new customer, a freshly imported list), so a nervous double-click
 * cannot email the whole list twice.
 *
 * ## Who is nudged
 *
 * Everyone with an email address who has bought something — a paid order, or
 * one paid for at the store — plus every customer imported from the old POS,
 * minus everyone who has unsubscribed. See `lib/marketing-consent.ts` on why
 * that is who CASL allows, and why the opt-out is absolute.
 *
 * ## How they go out
 *
 * As ordinary `giveaway_nudge` rows in the notification outbox, so they get
 * the dispatcher's retries, backoff and parking for free — but released at a
 * capped daily pace (`planNudgeSchedule`), because they share the email
 * provider's daily quota with order confirmations. The dispatcher also serves
 * every other kind of email before a nudge, so a nudge can delay nothing.
 *
 * ## The SMS channel
 *
 * The same two nudges can also go out as texts, as `giveaway_nudge_sms` rows.
 * The audience is built from phone numbers rather than emails — everyone who
 * has bought with a phone on the order, plus imported contacts with one —
 * minus anyone who has replied STOP. It is independent of the email audience:
 * a customer may get both. Texts need Twilio and the `MARKETING_SMS_ENABLED`
 * flag; see `lib/notifications/config.ts` for why that flag is its own.
 */
import { getD1 } from "@/db/runtime";
import { planNudgeSchedule, type NudgeKind } from "@/lib/giveaway";
import { ELIGIBLE_ORDER_SQL } from "@/lib/giveaway-store";
import { phone10Sql, toE164 } from "@/lib/customer-contacts";
import { anyProviderConfigured, emailConfig, marketingSmsEnabled, twilioConfig } from "@/lib/notifications/config";
import { normalizeEmail } from "@/lib/marketing-consent";

/** Loose on purpose — the provider is the real validator — but it drops junk. */
const PLAUSIBLE_EMAIL_SQL = `'^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`;

/** Outbox states that mean "this person has been, or is about to be, nudged". */
const LIVE_STATES = `('waiting_payment', 'waiting_completion', 'pending', 'retrying', 'pending_provider_setup', 'sending', 'sent')`;

export type NudgeChannel = "email" | "sms";

export function isNudgeChannel(value: unknown): value is NudgeChannel {
  return value === "email" || value === "sms";
}

/** The outbox kind each channel's rows are written under. */
export function nudgeOutboxKind(channel: NudgeChannel): "giveaway_nudge" | "giveaway_nudge_sms" {
  return channel === "sms" ? "giveaway_nudge_sms" : "giveaway_nudge";
}

/** `contact` is a lower-cased email, or an E.164 number for SMS — whatever goes in `recipient`. */
export type NudgeRecipient = { contact: string; name: string };

type Audience = { recipients: NudgeRecipient[]; optedOut: number; alreadyNudged: number };

function tally(rows: Array<{ contact: string; name: string | null; opted_out: boolean; already: boolean }>): Audience {
  let optedOut = 0;
  let alreadyNudged = 0;
  const recipients: NudgeRecipient[] = [];
  for (const row of rows) {
    if (row.opted_out) optedOut += 1;
    else if (row.already) alreadyNudged += 1;
    else recipients.push({ contact: row.contact, name: row.name ?? "" });
  }
  return { recipients, optedOut, alreadyNudged };
}

/**
 * Everyone this nudge would reach if it were sent now, on this channel.
 *
 * Names come from the customer's most recent order where there is one, then
 * from the import — the name they gave us last is the one to greet them by.
 */
export async function nudgeAudience(
  campaign: string,
  nudge: NudgeKind,
  channel: NudgeChannel = "email",
): Promise<Audience> {
  return channel === "sms" ? smsAudience(campaign, nudge) : emailAudience(campaign, nudge);
}

async function emailAudience(campaign: string, nudge: NudgeKind): Promise<Audience> {
  const rows = await getD1()
    .prepare(
      `WITH buyers AS (
         SELECT DISTINCT ON (lower(o.customer_email)) lower(o.customer_email) AS email, o.customer_name AS name, 0 AS rank
         FROM orders o
         WHERE o.customer_email <> '' AND ${ELIGIBLE_ORDER_SQL}
         ORDER BY lower(o.customer_email), o.created_at DESC
       ),
       imported AS (
         SELECT email, name, 1 AS rank FROM customer_contacts WHERE email IS NOT NULL
       ),
       everyone AS (
         SELECT DISTINCT ON (email) email, name FROM (SELECT * FROM buyers UNION ALL SELECT * FROM imported) people
         WHERE email ~ ${PLAUSIBLE_EMAIL_SQL}
         ORDER BY email, rank
       )
       SELECT everyone.email AS contact, everyone.name,
              EXISTS (SELECT 1 FROM customer_contacts c WHERE c.email = everyone.email AND c.marketing_opt_out_at IS NOT NULL) AS opted_out,
              EXISTS (
                SELECT 1 FROM notification_outbox n
                WHERE n.kind = 'giveaway_nudge' AND lower(n.recipient) = everyone.email
                  AND n.payload_json::jsonb->>'campaign' = ? AND n.payload_json::jsonb->>'nudge' = ?
                  AND n.status IN ${LIVE_STATES}
              ) AS already
       FROM everyone ORDER BY everyone.email`,
    )
    .bind(campaign, nudge)
    .all<{ contact: string; name: string; opted_out: boolean; already: boolean }>();
  return tally(rows.results);
}

/**
 * The phone audience: every buyer with a phone on an order, plus imported or
 * till contacts with one, keyed on the 10-digit number so "905…" and
 * "1905…" are one person. `contact` comes back as E.164, ready for Twilio.
 */
async function smsAudience(campaign: string, nudge: NudgeKind): Promise<Audience> {
  const orderPhone = phone10Sql("o.customer_phone");
  const rows = await getD1()
    .prepare(
      `WITH buyers AS (
         SELECT DISTINCT ON (${orderPhone}) ${orderPhone} AS phone, o.customer_name AS name, 0 AS rank
         FROM orders o
         WHERE ${orderPhone} <> '' AND ${ELIGIBLE_ORDER_SQL}
         ORDER BY ${orderPhone}, o.created_at DESC
       ),
       imported AS (
         SELECT ${phone10Sql("c.phone")} AS phone, c.name, 1 AS rank FROM customer_contacts c WHERE c.phone IS NOT NULL
       ),
       everyone AS (
         SELECT DISTINCT ON (phone) phone, name FROM (SELECT * FROM buyers UNION ALL SELECT * FROM imported) people
         WHERE length(phone) = 10
         ORDER BY phone, rank
       )
       SELECT everyone.phone AS contact, everyone.name,
              EXISTS (
                SELECT 1 FROM customer_contacts c
                WHERE ${phone10Sql("c.phone")} = everyone.phone AND c.sms_opt_out_at IS NOT NULL
              ) AS opted_out,
              EXISTS (
                SELECT 1 FROM notification_outbox n
                WHERE n.kind = 'giveaway_nudge_sms' AND ${phone10Sql("n.recipient")} = everyone.phone
                  AND n.payload_json::jsonb->>'campaign' = ? AND n.payload_json::jsonb->>'nudge' = ?
                  AND n.status IN ${LIVE_STATES}
              ) AS already
       FROM everyone ORDER BY everyone.phone`,
    )
    .bind(campaign, nudge)
    .all<{ contact: string; name: string; opted_out: boolean; already: boolean }>();
  const audience = tally(rows.results);
  // Always non-null: the query only returns 10-digit numbers.
  audience.recipients = audience.recipients.map((recipient) => ({ ...recipient, contact: toE164(recipient.contact) as string }));
  return audience;
}

export class NudgeError extends Error {}

/**
 * Why a channel cannot send right now, or null when it can.
 *
 * Refused rather than parked: a parked row is released the moment
 * credentials arrive, all at once, which is exactly the burst pacing exists
 * to prevent.
 */
export async function nudgeChannelBlocker(channel: NudgeChannel): Promise<string | null> {
  if (channel === "email") {
    return (await emailConfig()) ? null : "Email is not set up yet (Admin → Integrations), so nothing can be sent.";
  }
  if (!(await twilioConfig())) return "Twilio is not set up yet (Admin → Integrations), so no texts can be sent.";
  if (!(await marketingSmsEnabled())) {
    return "Marketing texts are switched off (Admin → Integrations → Calls and texts). Turn them on to send an SMS nudge.";
  }
  return null;
}

/**
 * Queues a nudge to everyone in its audience, paced at `perDay`.
 *
 * One transaction: the log row and every message go in together or not at
 * all. The advisory lock makes two presses of the same button take turns, and
 * the insert re-checks "already nudged" inside the lock, so the second press
 * finds everyone already queued and adds nobody.
 */
export async function queueNudge(input: {
  campaign: string;
  nudge: NudgeKind;
  perDay: number;
  actorId: string;
  channel?: NudgeChannel;
  now?: number;
}): Promise<{ sendId: string; queued: number; skipped: number; firstSendAt: number | null; lastSendAt: number | null }> {
  const channel = input.channel ?? "email";
  const blocker = await nudgeChannelBlocker(channel);
  if (blocker) throw new NudgeError(blocker);
  const kind = nudgeOutboxKind(channel);
  const now = input.now ?? Date.now();
  const perDay = Math.max(1, Math.min(5000, Math.trunc(input.perDay)));
  const { recipients, optedOut, alreadyNudged } = await nudgeAudience(input.campaign, input.nudge, channel);
  const schedule = planNudgeSchedule(recipients.length, perDay, now);
  const sendId = crypto.randomUUID();
  const status = (await anyProviderConfigured()) ? "pending" : "pending_provider_setup";
  // The same identity the audience was built on, so the in-lock re-check
  // agrees with it: lower-cased email, or the 10-digit number.
  const existing =
    channel === "sms" ? `${phone10Sql("n.recipient")} = ${phone10Sql("r.contact")}` : "lower(n.recipient) = r.contact";

  await getD1().batch([
    getD1().prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`${kind}:${input.campaign}:${input.nudge}`),
    getD1()
      .prepare(
        `INSERT INTO marketing_sends
         (id, campaign, nudge, channel, recipient_count, skipped_count, per_day, first_send_at, last_send_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        sendId,
        input.campaign,
        input.nudge,
        channel,
        recipients.length,
        optedOut + alreadyNudged,
        perDay,
        schedule[0] ?? null,
        schedule.at(-1) ?? null,
        input.actorId,
        now,
      ),
    getD1()
      .prepare(
        `INSERT INTO notification_outbox
         (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
         SELECT gen_random_uuid()::text, ?, r.contact,
                json_build_object('sendId', ?::text, 'campaign', ?::text, 'nudge', ?::text, 'name', r.name)::text,
                ?, 0, r.at, ?, ?
         FROM unnest(?::text[], ?::text[], ?::bigint[]) AS r(contact, name, at)
         WHERE NOT EXISTS (
           SELECT 1 FROM notification_outbox n
           WHERE n.kind = ? AND ${existing}
             AND n.payload_json::jsonb->>'campaign' = ? AND n.payload_json::jsonb->>'nudge' = ?
             AND n.status IN ${LIVE_STATES}
         )`,
      )
      .bind(
        kind,
        sendId,
        input.campaign,
        input.nudge,
        status,
        now,
        now,
        recipients.map((recipient) => recipient.contact),
        recipients.map((recipient) => recipient.name),
        schedule,
        kind,
        input.campaign,
        input.nudge,
      ),
  ]);

  return {
    sendId,
    queued: recipients.length,
    skipped: optedOut + alreadyNudged,
    firstSendAt: schedule[0] ?? null,
    lastSendAt: schedule.at(-1) ?? null,
  };
}

/**
 * One nudge to one address, right now — so the owner sees exactly what
 * customers will get before sending it to all of them.
 *
 * Marked `test`, so it neither counts as that person's nudge nor appears in
 * the send log.
 */
export async function queueTestNudge(input: {
  campaign: string;
  variant: NudgeKind;
  /** An email address, or for SMS a phone number in any format. */
  to: string;
  name?: string;
  channel?: NudgeChannel;
  now?: number;
}): Promise<void> {
  const channel = input.channel ?? "email";
  const blocker = await nudgeChannelBlocker(channel);
  if (blocker) throw new NudgeError(blocker);
  let recipient: string;
  if (channel === "sms") {
    const phone = toE164(input.to);
    if (!phone) throw new NudgeError("Enter a 10-digit phone number for the test.");
    recipient = phone;
  } else {
    recipient = normalizeEmail(input.to);
    if (!/^\S+@\S+\.\S+$/.test(recipient) || recipient.length > 254) {
      throw new NudgeError("Enter a valid email address for the test.");
    }
  }
  const now = input.now ?? Date.now();
  await getD1()
    .prepare(
      `INSERT INTO notification_outbox
       (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      nudgeOutboxKind(channel),
      recipient,
      JSON.stringify({ campaign: input.campaign, nudge: "test", variant: input.variant, name: input.name ?? "", test: true }),
      now,
      now,
      now,
    )
    .run();
}

/**
 * Stops whatever of a nudge has not gone yet. Anything already delivered
 * stays delivered; the rest is marked cancelled, which the audience query
 * treats as "not nudged", so a later press can still reach them.
 */
export async function cancelNudge(sendId: string, now: number = Date.now()): Promise<number> {
  const result = await getD1()
    .prepare(
      `UPDATE notification_outbox SET status = 'cancelled', last_error = 'Stopped from Admin → Giveaway', updated_at = ?
       WHERE kind IN ('giveaway_nudge', 'giveaway_nudge_sms') AND payload_json::jsonb->>'sendId' = ?
         AND status IN ('pending', 'retrying', 'pending_provider_setup')`,
    )
    .bind(now, sendId)
    .run();
  return result.meta.changes ?? 0;
}

export type NudgeSendRow = {
  id: string;
  nudge: string;
  channel: NudgeChannel;
  recipient_count: number;
  skipped_count: number;
  per_day: number;
  first_send_at: number | null;
  last_send_at: number | null;
  created_at: number;
  created_by_name: string | null;
  sent: number;
  waiting: number;
  failed: number;
  stopped: number;
};

/** Every press of a nudge button, with how far each has got. */
export async function nudgeSends(campaign: string): Promise<NudgeSendRow[]> {
  const rows = await getD1()
    .prepare(
      `SELECT s.id, s.nudge, s.channel, s.recipient_count, s.skipped_count, s.per_day, s.first_send_at, s.last_send_at,
              s.created_at, u.name AS created_by_name,
              COUNT(n.id) FILTER (WHERE n.status = 'sent') AS sent,
              COUNT(n.id) FILTER (WHERE n.status IN ('pending', 'retrying', 'sending', 'pending_provider_setup')) AS waiting,
              COUNT(n.id) FILTER (WHERE n.status = 'failed') AS failed,
              COUNT(n.id) FILTER (WHERE n.status = 'cancelled') AS stopped
       FROM marketing_sends s
       LEFT JOIN staff_users u ON u.id = s.created_by
       LEFT JOIN notification_outbox n
         ON n.kind = CASE WHEN s.channel = 'sms' THEN 'giveaway_nudge_sms' ELSE 'giveaway_nudge' END
        AND n.payload_json::jsonb->>'sendId' = s.id
       WHERE s.campaign = ?
       GROUP BY s.id, u.name
       ORDER BY s.created_at DESC`,
    )
    .bind(campaign)
    .all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    ...(row as unknown as NudgeSendRow),
    recipient_count: Number(row.recipient_count),
    skipped_count: Number(row.skipped_count),
    per_day: Number(row.per_day),
    first_send_at: row.first_send_at === null ? null : Number(row.first_send_at),
    last_send_at: row.last_send_at === null ? null : Number(row.last_send_at),
    created_at: Number(row.created_at),
    sent: Number(row.sent),
    waiting: Number(row.waiting),
    failed: Number(row.failed),
    stopped: Number(row.stopped),
  }));
}

/**
 * Emails of every kind that left in the last 24 hours, and how many the
 * provider refused for being over its limit.
 *
 * Shown beside the nudge buttons because it is the number that tells the owner
 * how much of the daily allowance order emails are already using — which is
 * what the daily nudge limit has to leave room for.
 */
export async function recentEmailVolume(now: number = Date.now()): Promise<{ sent: number; rateLimited: number }> {
  const row = await getD1()
    .prepare(
      `SELECT COUNT(*) FILTER (WHERE status = 'sent' AND sent_at >= ?) AS sent,
              COUNT(*) FILTER (WHERE updated_at >= ? AND last_error LIKE '% 429:%') AS rate_limited
       FROM notification_outbox
       -- Texts do not draw on the email allowance this number is shown against.
       WHERE updated_at >= ? AND kind <> 'giveaway_nudge_sms'`,
    )
    .bind(now - 86_400_000, now - 86_400_000, now - 86_400_000)
    .first<{ sent: number; rate_limited: number }>();
  return { sent: Number(row?.sent ?? 0), rateLimited: Number(row?.rate_limited ?? 0) };
}
