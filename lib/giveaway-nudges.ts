/** Giveaway outreach: one audience identity, explicit resends, durable progress. */
import { getD1 } from "@/db/runtime";
import { getPool } from "@/db/pg-driver";
import { planOutreachSchedule, type NudgeKind } from "@/lib/giveaway";
import { ELIGIBLE_ORDER_SQL, loadGiveaway } from "@/lib/giveaway-store";
import { phone10Sql, toE164, type LegacyCustomerRecord } from "@/lib/customer-contacts";
import { emailConfig, marketingSmsEnabled, twilioConfig } from "@/lib/notifications/config";
import { normalizeEmail } from "@/lib/marketing-consent";

export type NudgeChannel = "email" | "sms";
export type AudienceSource = "all" | "imported" | "orders";
export type SendMode = "new" | "resend";
export function isNudgeChannel(value: unknown): value is NudgeChannel { return value === "email" || value === "sms"; }
export function isAudienceSource(value: unknown): value is AudienceSource { return value === "all" || value === "imported" || value === "orders"; }
export function isSendMode(value: unknown): value is SendMode { return value === "new" || value === "resend"; }
export function nudgeOutboxKind(channel: NudgeChannel): "giveaway_nudge" | "giveaway_nudge_sms" {
  return channel === "sms" ? "giveaway_nudge_sms" : "giveaway_nudge";
}
export type NudgeRecipient = { contact: string; name: string };
export type AudienceCustomer = NudgeRecipient & {
  imported: boolean; buyer: boolean; opted_out: boolean; already: boolean; sent_before: boolean; active: boolean;
  status: string | null; scheduled_for: number | null; sent_at: number | null; attempt_count: number;
  last_error: string | null; delivery_status: string | null; delivery_error: string | null;
  legacy_json: string | null; last_visit_at: number | null;
};
export type Audience = {
  recipients: NudgeRecipient[]; customers: AudienceCustomer[]; optedOut: number; alreadyNudged: number;
  resendReady: number; waiting: number; total: number;
};

/** Latest status is displayed; all history is checked when deciding eligibility. */
export async function nudgeAudience(campaign: string, nudge: NudgeKind, channel: NudgeChannel = "email",
  source: AudienceSource = "all", mode: SendMode = "new"): Promise<Audience> {
  const orderContact = channel === "sms" ? phone10Sql("o.customer_phone") : "lower(o.customer_email)";
  const contactColumn = channel === "sms" ? phone10Sql("c.phone") : "lower(c.email)";
  const historyContact = channel === "sms" ? phone10Sql("n.recipient") : "lower(n.recipient)";
  const valid = channel === "sms" ? "contact ~ '^[2-9][0-9]{2}[2-9][0-9]{6}$' AND contact !~ '^([0-9])\\1{9}$'"
    : "contact ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'";
  const optout = channel === "sms" ? "c.sms_opt_out_at" : "c.marketing_opt_out_at";
  const rows = await getD1().prepare(`
    WITH buyers AS (
      SELECT DISTINCT ON (${orderContact}) ${orderContact} AS contact, o.customer_name AS name,
             0 AS rank, true AS buyer, false AS imported, NULL::text AS legacy_json, o.created_at AS last_visit_at
      FROM orders o WHERE ${ELIGIBLE_ORDER_SQL} ORDER BY ${orderContact}, o.created_at DESC
    ), people AS (
      SELECT * FROM buyers UNION ALL
      SELECT ${contactColumn}, c.name, 1, false, (c.source = 'import' OR c.legacy_json IS NOT NULL), c.legacy_json, c.last_visit_at
      FROM customer_contacts c WHERE c.source <> 'unsubscribe' OR c.legacy_json IS NOT NULL
    ), everyone AS (
      SELECT contact, (array_agg(name ORDER BY rank))[1] AS name, bool_or(buyer) AS buyer, bool_or(imported) AS imported,
             (array_agg(legacy_json ORDER BY (legacy_json IS NULL), rank))[1] AS legacy_json, max(last_visit_at) AS last_visit_at
      FROM people WHERE ${valid} GROUP BY contact
    ), history AS MATERIALIZED (
      SELECT n.*, ${historyContact} AS contact FROM notification_outbox n
      WHERE n.kind = ? AND n.payload_json::jsonb->>'campaign' = ? AND n.payload_json::jsonb->>'nudge' = ?
    ), history_flags AS (
      SELECT contact, bool_or(status = 'sent') AS sent_before,
        bool_or(status IN ('pending', 'retrying', 'sending', 'pending_provider_setup')) AS active
      FROM history GROUP BY contact
    ), latest AS (
      SELECT DISTINCT ON (contact) * FROM history ORDER BY contact, created_at DESC, id DESC
    ), optouts AS (
      SELECT DISTINCT ${contactColumn} AS contact FROM customer_contacts c WHERE ${optout} IS NOT NULL
    )
    SELECT e.*, optouts.contact IS NOT NULL AS opted_out,
      COALESCE(h.sent_before, false) AS sent_before, COALESCE(h.active, false) AS active,
      latest.status, latest.scheduled_for, latest.sent_at, COALESCE(latest.attempt_count, 0) AS attempt_count,
      latest.last_error, latest.delivery_status, latest.delivery_error
    FROM everyone e LEFT JOIN history_flags h ON h.contact = e.contact
      LEFT JOIN latest ON latest.contact = e.contact LEFT JOIN optouts ON optouts.contact = e.contact
    WHERE (? = 'all' OR (? = 'imported' AND e.imported) OR (? = 'orders' AND e.buyer)) ORDER BY e.name, e.contact
  `).bind(nudgeOutboxKind(channel), campaign, nudge, source, source, source)
    .all<AudienceCustomer>();
  const customers = rows.results.map((row) => ({ ...row, contact: channel === "sms" ? toE164(row.contact)! : row.contact,
    already: row.sent_before || row.active }));
  const available = customers.filter((row) => !row.opted_out && !row.active);
  return {
    customers, total: customers.length,
    recipients: available.filter((row) => mode === "resend" ? row.sent_before : !row.sent_before).map(({ contact, name }) => ({ contact, name })),
    optedOut: customers.filter((row) => row.opted_out).length,
    alreadyNudged: customers.filter((row) => !row.opted_out && row.already).length,
    resendReady: available.filter((row) => row.sent_before).length,
    waiting: customers.filter((row) => row.active).length,
  };
}

export class NudgeError extends Error {}
export async function nudgeChannelBlocker(channel: NudgeChannel): Promise<string | null> {
  if (channel === "email") return (await emailConfig()) ? null : "Email is not set up yet. Open Integrations to connect it.";
  if (!(await twilioConfig())) return "Twilio is not set up yet. Open Integrations to connect texts.";
  if (!(await marketingSmsEnabled())) return "Marketing texts are switched off. Enable them in Integrations → Calls and texts.";
  return null;
}

export type QueueResult = { sendId: string; queued: number; skipped: number; notQueued: number; firstSendAt: number | null; lastSendAt: number | null };

/** Serializes the entire channel so overlapping sends share capacity and cannot duplicate a first nudge. */
export async function queueNudge(input: {
  campaign: string; nudge: NudgeKind; perDay: number; actorId: string; channel?: NudgeChannel;
  source?: AudienceSource; mode?: SendMode; intervalMinutes?: number; requestKey?: string; now?: number;
}): Promise<QueueResult> {
  const channel = input.channel ?? "email";
  const blocker = await nudgeChannelBlocker(channel);
  if (blocker) throw new NudgeError(blocker);
  const kind = nudgeOutboxKind(channel);
  const now = input.now ?? Date.now();
  const perDay = Math.max(1, Math.min(5000, Math.trunc(input.perDay)));
  const intervalMinutes = input.intervalMinutes ?? 1;
  if (channel === "email" && intervalMinutes === 0) throw new NudgeError("Leave at least one minute between emails to protect order receipts.");
  const source = input.source ?? "all";
  const mode = input.mode ?? "new";
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`giveaway-channel:${channel}`]);
    if (input.requestKey) {
      const prior = await client.query("SELECT * FROM marketing_sends WHERE request_key = $1", [input.requestKey]);
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.campaign !== input.campaign || row.channel !== channel || row.created_by !== input.actorId) throw new NudgeError("This request was already used. Refresh and review your send again.");
        await client.query("COMMIT");
        return { sendId: row.id, queued: Number(row.recipient_count), skipped: Number(row.skipped_count), notQueued: 0,
          firstSendAt: row.first_send_at, lastSendAt: row.last_send_at };
      }
    }
    const giveaway = await loadGiveaway();
    const audience = await nudgeAudience(input.campaign, input.nudge, channel, source, mode);
    const reserved = await client.query<{ at: number }>(`SELECT CASE WHEN status = 'sent' THEN sent_at ELSE scheduled_for END AS at
      FROM notification_outbox WHERE kind = $1 AND (status IN ('pending', 'retrying', 'sending', 'pending_provider_setup')
        OR (status = 'sent' AND sent_at >= $2))`, [kind, now - 86_400_000]);
    const schedule = planOutreachSchedule({ count: audience.recipients.length, perDay, intervalMinutes, now,
      endsAt: giveaway?.endsAt ?? now + 30 * 86_400_000, reserved: reserved.rows.map((row) => Number(row.at)) });
    const recipients = audience.recipients.slice(0, schedule.length);
    const sendId = crypto.randomUUID();
    const skipped = audience.total - audience.recipients.length;
    await client.query(`INSERT INTO marketing_sends
      (id, campaign, nudge, channel, recipient_count, skipped_count, per_day, interval_minutes, audience_source, send_mode, request_key,
       first_send_at, last_send_at, created_by, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [sendId, input.campaign, input.nudge, channel, recipients.length, skipped, perDay, intervalMinutes, source, mode,
        input.requestKey ?? null, schedule[0] ?? null, schedule.at(-1) ?? null, input.actorId, now]);
    await client.query(`INSERT INTO notification_outbox
      (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
      SELECT gen_random_uuid()::text, $1, r.contact,
        json_build_object('sendId',$2::text,'campaign',$3::text,'nudge',$4::text,'name',r.name)::text,
        'pending',0,r.at,$5,$5 FROM unnest($6::text[],$7::text[],$8::bigint[]) AS r(contact,name,at)`,
      [kind,sendId,input.campaign,input.nudge,now,recipients.map((r) => r.contact),recipients.map((r) => r.name),schedule]);
    await client.query("COMMIT");
    return { sendId, queued: recipients.length, skipped, notQueued: audience.recipients.length - recipients.length,
      firstSendAt: schedule[0] ?? null, lastSendAt: schedule.at(-1) ?? null };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Safe metadata for customer rows, never used as new website order totals. */
export function legacySummary(json: string | null): { visits: number; spentCents: number; records: number } | null {
  if (!json) return null;
  const records = JSON.parse(json) as LegacyCustomerRecord[];
  return { records: records.length, visits: records.reduce((sum, row) => sum + (row.visits ?? 0), 0),
    spentCents: records.reduce((sum, row) => sum + (row.totalSpentCents ?? 0), 0) };
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

/** Re-time only the unsent part of an existing batch, without sending it again. */
export async function repaceNudge(campaign: string, sendId: string, intervalMinutes: number, perDay: number, now = Date.now()): Promise<number> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const send = (await client.query("SELECT channel FROM marketing_sends WHERE id = $1 AND campaign = $2", [sendId, campaign])).rows[0];
    if (!send) throw new NudgeError("That send could not be found.");
    if (send.channel === "email" && intervalMinutes === 0) throw new NudgeError("Leave at least one minute between emails to protect order receipts.");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`giveaway-channel:${send.channel}`]);
    const rows = await client.query<{ id: string }>(`SELECT id FROM notification_outbox
      WHERE payload_json::jsonb->>'sendId' = $1 AND status IN ('pending', 'retrying', 'pending_provider_setup')
      ORDER BY scheduled_for, id FOR UPDATE`, [sendId]);
    const reserved = await client.query<{ at: number }>(`SELECT CASE WHEN status = 'sent' THEN sent_at ELSE scheduled_for END AS at
      FROM notification_outbox WHERE kind = $1
        AND (status IN ('pending', 'retrying', 'sending', 'pending_provider_setup') OR (status = 'sent' AND sent_at >= $2))
        AND NOT (id = ANY($3::text[]))`, [nudgeOutboxKind(send.channel), now - 86_400_000, rows.rows.map((row) => row.id)]);
    const giveaway = await loadGiveaway();
    const slots = planOutreachSchedule({ count: rows.rows.length, perDay, intervalMinutes, now,
      endsAt: giveaway?.endsAt ?? now, reserved: reserved.rows.map((row) => Number(row.at)) });
    if (slots.length < rows.rows.length) throw new NudgeError("The remaining messages do not fit before closing at this pace. Choose a faster pace or a higher daily cap.");
    await client.query(`UPDATE notification_outbox n SET scheduled_for = r.at, updated_at = $1
      FROM unnest($2::text[], $3::bigint[]) AS r(id, at) WHERE n.id = r.id`, [now, rows.rows.map((row) => row.id), slots]);
    await client.query(`UPDATE marketing_sends SET interval_minutes = $1, per_day = $2,
      first_send_at = (SELECT min(scheduled_for) FROM notification_outbox WHERE payload_json::jsonb->>'sendId' = $3),
      last_send_at = (SELECT max(scheduled_for) FROM notification_outbox WHERE payload_json::jsonb->>'sendId' = $3) WHERE id = $3`,
      [intervalMinutes, perDay, sendId]);
    await client.query("COMMIT");
    return rows.rows.length;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export type NudgeSendRow = {
  id: string;
  nudge: string;
  channel: NudgeChannel;
  recipient_count: number;
  skipped_count: number;
  per_day: number;
  interval_minutes: number | null;
  audience_source: AudienceSource;
  send_mode: SendMode;
  first_send_at: number | null;
  last_send_at: number | null;
  created_at: number;
  created_by_name: string | null;
  sent: number;
  waiting: number;
  failed: number;
  stopped: number;
  delivered: number;
  undelivered: number;
};

/** Every press of a nudge button, with how far each has got. */
export async function nudgeSends(campaign: string): Promise<NudgeSendRow[]> {
  const rows = await getD1()
    .prepare(
      `SELECT s.id, s.nudge, s.channel, s.recipient_count, s.skipped_count, s.per_day, s.interval_minutes, s.audience_source, s.send_mode, s.first_send_at, s.last_send_at,
              s.created_at, u.name AS created_by_name,
              COUNT(n.id) FILTER (WHERE n.status = 'sent') AS sent,
              COUNT(n.id) FILTER (WHERE n.status IN ('pending', 'retrying', 'sending', 'pending_provider_setup')) AS waiting,
              COUNT(n.id) FILTER (WHERE n.status = 'failed') AS failed,
              COUNT(n.id) FILTER (WHERE n.status = 'cancelled') AS stopped
              , COUNT(n.id) FILTER (WHERE n.delivery_status = 'delivered') AS delivered
              , COUNT(n.id) FILTER (WHERE n.delivery_status IN ('undelivered', 'failed')) AS undelivered
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
    delivered: Number(row.delivered),
    undelivered: Number(row.undelivered),
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
