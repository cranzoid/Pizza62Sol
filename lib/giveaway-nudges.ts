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
 */
import { getD1 } from "@/db/runtime";
import { planNudgeSchedule, type NudgeKind } from "@/lib/giveaway";
import { ELIGIBLE_ORDER_SQL } from "@/lib/giveaway-store";
import { anyProviderConfigured, emailConfig } from "@/lib/notifications/config";
import { normalizeEmail } from "@/lib/marketing-consent";

/** Loose on purpose — the provider is the real validator — but it drops junk. */
const PLAUSIBLE_EMAIL_SQL = `'^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`;

/** Outbox states that mean "this person has been, or is about to be, nudged". */
const LIVE_STATES = `('waiting_payment', 'waiting_completion', 'pending', 'retrying', 'pending_provider_setup', 'sending', 'sent')`;

export type NudgeRecipient = { email: string; name: string };

/**
 * Everyone this nudge would reach if it were sent now.
 *
 * Names come from the customer's most recent order where there is one, then
 * from the import — the name they gave us last is the one to greet them by.
 */
export async function nudgeAudience(campaign: string, nudge: NudgeKind): Promise<{
  recipients: NudgeRecipient[];
  optedOut: number;
  alreadyNudged: number;
}> {
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
       SELECT everyone.email, everyone.name,
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
    .all<{ email: string; name: string; opted_out: boolean; already: boolean }>();
  let optedOut = 0;
  let alreadyNudged = 0;
  const recipients: NudgeRecipient[] = [];
  for (const row of rows.results) {
    if (row.opted_out) optedOut += 1;
    else if (row.already) alreadyNudged += 1;
    else recipients.push({ email: row.email, name: row.name ?? "" });
  }
  return { recipients, optedOut, alreadyNudged };
}

export class NudgeError extends Error {}

/**
 * Queues a nudge to everyone in its audience, paced at `perDay`.
 *
 * One transaction: the log row and every email go in together or not at all.
 * The advisory lock makes two presses of the same button take turns, and the
 * insert re-checks "already nudged" inside the lock, so the second press
 * finds everyone already queued and adds nobody.
 */
export async function queueNudge(input: {
  campaign: string;
  nudge: NudgeKind;
  perDay: number;
  actorId: string;
  now?: number;
}): Promise<{ sendId: string; queued: number; skipped: number; firstSendAt: number | null; lastSendAt: number | null }> {
  // Refused rather than parked: a parked row is released the moment
  // credentials arrive, all at once, which is exactly the burst pacing exists
  // to prevent.
  if (!(await emailConfig())) {
    throw new NudgeError("Email is not set up yet (Admin → Integrations), so nothing can be sent.");
  }
  const now = input.now ?? Date.now();
  const perDay = Math.max(1, Math.min(5000, Math.trunc(input.perDay)));
  const { recipients, optedOut, alreadyNudged } = await nudgeAudience(input.campaign, input.nudge);
  const schedule = planNudgeSchedule(recipients.length, perDay, now);
  const sendId = crypto.randomUUID();
  const status = (await anyProviderConfigured()) ? "pending" : "pending_provider_setup";

  await getD1().batch([
    getD1().prepare("SELECT pg_advisory_xact_lock(hashtext(?))").bind(`giveaway_nudge:${input.campaign}:${input.nudge}`),
    getD1()
      .prepare(
        `INSERT INTO marketing_sends
         (id, campaign, nudge, recipient_count, skipped_count, per_day, first_send_at, last_send_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        sendId,
        input.campaign,
        input.nudge,
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
         SELECT gen_random_uuid()::text, 'giveaway_nudge', r.email,
                json_build_object('sendId', ?::text, 'campaign', ?::text, 'nudge', ?::text, 'name', r.name)::text,
                ?, 0, r.at, ?, ?
         FROM unnest(?::text[], ?::text[], ?::bigint[]) AS r(email, name, at)
         WHERE NOT EXISTS (
           SELECT 1 FROM notification_outbox n
           WHERE n.kind = 'giveaway_nudge' AND lower(n.recipient) = r.email
             AND n.payload_json::jsonb->>'campaign' = ? AND n.payload_json::jsonb->>'nudge' = ?
             AND n.status IN ${LIVE_STATES}
         )`,
      )
      .bind(
        sendId,
        input.campaign,
        input.nudge,
        status,
        now,
        now,
        recipients.map((recipient) => recipient.email),
        recipients.map((recipient) => recipient.name),
        schedule,
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
  email: string;
  name?: string;
  now?: number;
}): Promise<void> {
  if (!(await emailConfig())) {
    throw new NudgeError("Email is not set up yet (Admin → Integrations), so nothing can be sent.");
  }
  const email = normalizeEmail(input.email);
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) throw new NudgeError("Enter a valid email address for the test.");
  const now = input.now ?? Date.now();
  await getD1()
    .prepare(
      `INSERT INTO notification_outbox
       (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
       VALUES (?, 'giveaway_nudge', ?, ?, 'pending', 0, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      email,
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
       WHERE kind = 'giveaway_nudge' AND payload_json::jsonb->>'sendId' = ?
         AND status IN ('pending', 'retrying', 'pending_provider_setup')`,
    )
    .bind(now, sendId)
    .run();
  return result.meta.changes ?? 0;
}

export type NudgeSendRow = {
  id: string;
  nudge: string;
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
      `SELECT s.id, s.nudge, s.recipient_count, s.skipped_count, s.per_day, s.first_send_at, s.last_send_at,
              s.created_at, u.name AS created_by_name,
              COUNT(n.id) FILTER (WHERE n.status = 'sent') AS sent,
              COUNT(n.id) FILTER (WHERE n.status IN ('pending', 'retrying', 'sending', 'pending_provider_setup')) AS waiting,
              COUNT(n.id) FILTER (WHERE n.status = 'failed') AS failed,
              COUNT(n.id) FILTER (WHERE n.status = 'cancelled') AS stopped
       FROM marketing_sends s
       LEFT JOIN staff_users u ON u.id = s.created_by
       LEFT JOIN notification_outbox n ON n.kind = 'giveaway_nudge' AND n.payload_json::jsonb->>'sendId' = s.id
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
       WHERE updated_at >= ?`,
    )
    .bind(now - 86_400_000, now - 86_400_000, now - 86_400_000)
    .first<{ sent: number; rate_limited: number }>();
  return { sent: Number(row?.sent ?? 0), rateLimited: Number(row?.rate_limited ?? 0) };
}
