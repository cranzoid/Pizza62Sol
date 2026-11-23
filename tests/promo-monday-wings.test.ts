/**
 * The Monday Wings promotion by text and email.
 *
 * What is worth pinning, in order of what would hurt most if it broke:
 *
 * **Nothing goes out after midnight or on the wrong day.** The message says
 * "today"; a text still queued on Tuesday must be skipped, and nothing is
 * scheduled past the end of the Toronto day.
 *
 * **Sending hours still hold.** Nothing is queued for the middle of the night.
 *
 * **It works with the giveaway over.** The first version of this machinery
 * refused to send once the giveaway had closed; a promo must not depend on it.
 *
 * **STOP and the one-segment text.** Every text says how to stop, is plain
 * ASCII (a single curly quote would triple the cost) and a test says [TEST].
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { queueNudge, queueTestNudge, nudgeAudience } = await import("@/lib/giveaway-nudges");
const { dispatchOutbox } = await import("@/lib/notifications/dispatcher");
const { renderMondayWingsPromo } = await import("@/lib/notifications/messages");
const { endOfTorontoDay, isMondayWingsCampaign, mondayWingsCampaign, mondayWingsIsOn, torontoWeekday } =
  await import("@/lib/promo-campaigns");
const { clearIntegrationSecretCache } = await import("@/lib/integration-secrets");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

// A past Monday, so a queued row is "not today" whenever this suite runs.
const CAMPAIGN = "promo:monday-wings:2026-11-23";
// Monday 3:00 pm Toronto (EST, UTC-5).
const MONDAY_3PM = Date.parse("2026-11-23T20:00:00Z");
const MONDAY_8PM = Date.parse("2026-11-24T01:00:00Z");
const realFetch = globalThis.fetch;
let staffId = "";
const usedPhones: string[] = [];
let phoneCounter = Math.floor(Math.random() * 9000);
const newPhone = () => {
  const phone = `905${String(3_000_000 + (phoneCounter += 1)).padStart(7, "0")}`;
  usedPhones.push(phone);
  return phone;
};

function stubTwilio(): Array<{ form: URLSearchParams }> {
  const calls: Array<{ form: URLSearchParams }> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ form: new URLSearchParams(String(init?.body ?? "")) });
    return new Response(JSON.stringify({ sid: "SM-test" }), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

before(async () => {
  process.env.TWILIO_ACCOUNT_SID = `AC${"0".repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = "twilio-token";
  process.env.TWILIO_FROM_NUMBER = "+15550000000";
  process.env.PUBLIC_BASE_URL = "https://pizza62.test";
  process.env.MARKETING_SMS_ENABLED = "true";
  process.env.EMAIL_API_KEY = "re_test";
  process.env.EMAIL_FROM = "orders@pizza62.test";
  clearIntegrationSecretCache();
  if (!reachable) return;
  await getPool().query(
    "UPDATE notification_outbox SET status = 'cancelled', updated_at = $1 WHERE status IN ('pending', 'retrying', 'sending', 'pending_provider_setup')",
    [Date.now()],
  );
  staffId = (await getPool().query<{ id: string }>("SELECT id FROM staff_users LIMIT 1")).rows[0]?.id ?? "test-staff";
});

after(async () => {
  for (const key of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "MARKETING_SMS_ENABLED", "EMAIL_API_KEY", "EMAIL_FROM"]) {
    delete process.env[key];
  }
  clearIntegrationSecretCache();
  if (reachable) {
    await getPool().query("DELETE FROM notification_outbox WHERE payload_json::jsonb->>'campaign' = ANY($1)", [[CAMPAIGN, "promo:monday-wings:2026-11-16"]]);
    await getPool().query("DELETE FROM marketing_sends WHERE campaign = $1", [CAMPAIGN]);
    await getPool().query("DELETE FROM customer_contacts WHERE email IS NULL AND phone = ANY($1)", [usedPhones]);
  }
  await closePool();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- pure ---------------------------------------------------------------------

test("a campaign id is dated, and only a Monday's offer is on", () => {
  assert.equal(mondayWingsCampaign(MONDAY_3PM), CAMPAIGN);
  assert.ok(isMondayWingsCampaign(CAMPAIGN));
  assert.ok(!isMondayWingsCampaign("giveaway-1"));
  assert.ok(!isMondayWingsCampaign("promo:monday-wings:tomorrow"));
  assert.equal(torontoWeekday(MONDAY_3PM), "Monday");
  assert.ok(mondayWingsIsOn(CAMPAIGN, MONDAY_3PM));
  // Eight in the evening is still Monday in Toronto, though it is Tuesday UTC.
  assert.ok(mondayWingsIsOn(CAMPAIGN, MONDAY_8PM));
  // Midnight Toronto ends it, and a different Monday is a different campaign.
  assert.ok(!mondayWingsIsOn(CAMPAIGN, endOfTorontoDay(MONDAY_3PM)));
  assert.ok(!mondayWingsIsOn(CAMPAIGN, MONDAY_3PM + 7 * 86_400_000));
});

test("the end of the Toronto day is local midnight", () => {
  assert.equal(new Date(endOfTorontoDay(MONDAY_3PM)).toISOString(), "2026-11-24T05:00:00.000Z");
});

withDb("the text is one plain-ASCII segment that says how to stop", async () => {
  const message = await renderMondayWingsPromo({ name: "", unsubscribeHref: "" });
  assert.match(message.smsBody, /^Pizza 62: Monday Wings are \$1 each today!/);
  assert.match(message.smsBody, /Reply STOP to opt out\.$/);
  assert.match(message.smsBody, /pickup only/);
  assert.match(message.smsBody, /^[\x20-\x7e]+$/, "ASCII only, so it stays one 160-character segment");
  assert.ok(message.smsBody.length <= 170, `text is ${message.smsBody.length} characters`);
  const test = await renderMondayWingsPromo({ name: "", unsubscribeHref: "", test: true });
  assert.match(test.smsBody, /^\[TEST\] /);
  assert.match(test.emailSubject, /^\[TEST\] /);
});

withDb("the email names the offer and carries the unsubscribe link", async () => {
  const message = await renderMondayWingsPromo({ name: "Ada Lovelace", unsubscribeHref: "https://pizza62.test/unsubscribe?e=x" });
  assert.match(message.emailSubject, /Monday Wings/);
  assert.match(message.emailText, /Hi Ada/);
  assert.match(message.emailHtml, /unsubscribe\?e=x/);
  assert.match(message.emailHtml, /\$1/);
});

// --- queueing -----------------------------------------------------------------

withDb("texts queue with the giveaway closed, all inside the sending window and the day", async () => {
  await getPool().query("DELETE FROM customer_contacts WHERE email IS NULL AND phone = ANY($1)", [usedPhones]);
  for (let index = 0; index < 3; index += 1) {
    await getPool().query(
      `INSERT INTO customer_contacts (id, email, phone, name, source, created_at, updated_at) VALUES ($1, NULL, $2, 'Ada', 'import', $3, $3)`,
      [crypto.randomUUID(), newPhone(), Date.now()],
    );
  }
  const result = await queueNudge({
    campaign: CAMPAIGN, nudge: "announce", perDay: 5000, actorId: staffId, channel: "sms", now: MONDAY_3PM,
    intervalMinutes: 0, endsAt: endOfTorontoDay(MONDAY_3PM),
  });
  assert.ok(result.queued >= 3, "reaches the imported contacts");
  assert.ok(result.firstSendAt !== null && result.firstSendAt >= MONDAY_3PM);
  assert.ok(result.lastSendAt !== null && result.lastSendAt < endOfTorontoDay(MONDAY_3PM), "nothing after midnight");
  const rows = await getPool().query<{ kind: string; scheduled_for: string }>(
    "SELECT kind, scheduled_for FROM notification_outbox WHERE payload_json::jsonb->>'sendId' = $1",
    [result.sendId],
  );
  assert.ok(rows.rows.every((row) => row.kind === "giveaway_nudge_sms"));

  // A second press the same day reaches nobody already queued.
  const again = await nudgeAudience(CAMPAIGN, "announce", "sms");
  assert.equal(again.recipients.length, 0);

  // Park these so they cannot crowd a later test's dispatch batch.
  await getPool().query("UPDATE notification_outbox SET status = 'cancelled' WHERE payload_json::jsonb->>'sendId' = $1", [result.sendId]);
});

withDb("after the sending window closes, nothing is queued", async () => {
  const result = await queueNudge({
    campaign: "promo:monday-wings:2026-11-30", nudge: "announce", perDay: 5000, actorId: staffId, channel: "sms",
    now: MONDAY_8PM + 6 * 86_400_000, intervalMinutes: 0, endsAt: endOfTorontoDay(MONDAY_8PM + 6 * 86_400_000),
  });
  assert.equal(result.queued, 0);
  await getPool().query("DELETE FROM marketing_sends WHERE campaign = 'promo:monday-wings:2026-11-30'");
});

// --- delivery -----------------------------------------------------------------

withDb("a test text goes out as [TEST], and a stale-day row is skipped, not sent", async () => {
  const calls = stubTwilio();
  const phone = newPhone();
  await queueTestNudge({ campaign: CAMPAIGN, variant: "announce", to: phone, channel: "sms" });
  await dispatchOutbox({ limit: 50 });
  const sent = calls.find((call) => call.form.get("To") === `+1${phone}`);
  assert.ok(sent, "the test text was sent");
  assert.match(sent.form.get("Body") ?? "", /^\[TEST\] Pizza 62: Monday Wings/);

  // A real (non-test) row for a Monday that is not today is skipped.
  const STALE = "promo:monday-wings:2026-11-16";
  const stale = newPhone();
  await getPool().query(
    `INSERT INTO notification_outbox (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
     VALUES ($1, 'giveaway_nudge_sms', $2, $3, 'pending', 0, $4, $4, $4)`,
    [crypto.randomUUID(), `+1${stale}`, JSON.stringify({ campaign: STALE, nudge: "announce", name: "" }), Date.now() - 1000],
  );
  await dispatchOutbox({ limit: 50 });
  assert.ok(!calls.some((call) => call.form.get("To") === `+1${stale}`), "never texted on the wrong day");
  const row = await getPool().query<{ status: string }>(
    "SELECT status FROM notification_outbox WHERE recipient = $1 AND payload_json::jsonb->>'campaign' = $2",
    [`+1${stale}`, STALE],
  );
  assert.equal(row.rows[0].status, "cancelled");
});
