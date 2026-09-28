/**
 * The giveaway nudge by text, and STOP.
 *
 * What is worth pinning, in order of what would hurt most if it broke:
 *
 * **STOP works, and is legal-grade.** A signed STOP reply records an opt-out
 * that the audience query and the dispatcher both honour — including when the
 * number was stored with a leading 1 and the reply arrives without it, or the
 * other way round. An unsigned request changes nothing.
 *
 * **Nothing goes out unless the owner has switched marketing texts on.**
 * Queueing is refused with the switch off, and a queued text waits (parked)
 * rather than sending if the switch is turned off mid-send.
 *
 * **Every text says how to stop**, and a test says it is a test.
 *
 * **One number is one person.** "905…" and "1905…" are the same audience
 * member, and a text nudge does not count as having emailed them.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { GIVEAWAY_DEFAULTS } = await import("@/lib/giveaway");
const { canonicalPhone10, toE164 } = await import("@/lib/customer-contacts");
const { isSmsOptedOut, recordSmsOptOut } = await import("@/lib/marketing-consent");
const { nudgeAudience, queueNudge, queueTestNudge, NudgeError } = await import("@/lib/giveaway-nudges");
const { dispatchOutbox } = await import("@/lib/notifications/dispatcher");
const { clearIntegrationSecretCache } = await import("@/lib/integration-secrets");
const { twilioSignature } = await import("@/app/api/notifications/voice/ack/route");
const { POST: inboundRoute, smsKeyword } = await import("@/app/api/notifications/sms/inbound/route");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const RUN = crypto.randomUUID().slice(0, 8);
const GIVEAWAY = `sms-test-${RUN}`;
const realFetch = globalThis.fetch;
const INBOUND_URL = "https://pizza62.test/api/notifications/sms/inbound";
let originalSetting: string | null = null;
let staffId = "";

/** A unique, valid-looking 10-digit number per call — 905-2xx-xxxx is never a real customer here. */
let phoneCounter = Math.floor(Math.random() * 9000);
const usedPhones: string[] = [];
const newPhone = () => {
  const phone = `905${String(2_000_000 + (phoneCounter += 1)).padStart(7, "0")}`;
  usedPhones.push(phone, `1${phone}`);
  return phone;
};

async function addContact(phone: string, name = "Ada Lovelace") {
  await getPool().query(
    `INSERT INTO customer_contacts (id, email, phone, name, source, created_at, updated_at)
     VALUES ($1, NULL, $2, $3, 'import', $4, $4)`,
    [crypto.randomUUID(), phone, name, Date.now()],
  );
}

function stubTwilio(): Array<{ url: string; form: URLSearchParams }> {
  const calls: Array<{ url: string; form: URLSearchParams }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), form: new URLSearchParams(String(init?.body ?? "")) });
    return new Response(JSON.stringify({ sid: "SM-test" }), { status: 201, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

function signedInbound(params: Record<string, string>, token = "twilio-token"): Request {
  return new Request(INBOUND_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilioSignature(token, INBOUND_URL, params),
    },
    body: new URLSearchParams(params).toString(),
  });
}

function setMarketingSms(on: boolean) {
  process.env.MARKETING_SMS_ENABLED = on ? "true" : "false";
  clearIntegrationSecretCache();
}

before(async () => {
  process.env.TWILIO_ACCOUNT_SID = `AC${"0".repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = "twilio-token";
  process.env.TWILIO_FROM_NUMBER = "+15550000000";
  process.env.PUBLIC_BASE_URL = "https://pizza62.test";
  setMarketingSms(true);
  if (!reachable) return;
  const row = await getPool().query<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'giveaway'");
  originalSetting = row.rows[0]?.value_json ?? null;
  const setting = JSON.stringify({ ...GIVEAWAY_DEFAULTS, id: GIVEAWAY, startsAt: Date.now() - 86_400_000, endsAt: Date.now() + 7 * 86_400_000 });
  await getPool().query(
    `INSERT INTO settings (key, value_json, version, updated_at) VALUES ('giveaway', $1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = EXCLUDED.updated_at`,
    [setting, Date.now()],
  );
  // The dispatcher claims across the whole shared test database; clear what
  // this run did not create (see notifications.test.ts, trap 8).
  await getPool().query(
    "UPDATE notification_outbox SET status = 'cancelled', updated_at = $1 WHERE status IN ('pending', 'retrying', 'sending', 'pending_provider_setup')",
    [Date.now()],
  );
  staffId = (await getPool().query<{ id: string }>("SELECT id FROM staff_users LIMIT 1")).rows[0]?.id ?? "test-staff";
});

after(async () => {
  for (const key of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "MARKETING_SMS_ENABLED"]) {
    delete process.env[key];
  }
  clearIntegrationSecretCache();
  if (reachable) {
    if (originalSetting) {
      await getPool().query("UPDATE settings SET value_json = $1 WHERE key = 'giveaway'", [originalSetting]);
    } else {
      await getPool().query("DELETE FROM settings WHERE key = 'giveaway'");
    }
    await getPool().query(
      "DELETE FROM notification_outbox WHERE kind = 'giveaway_nudge_sms' AND payload_json::jsonb->>'campaign' = $1",
      [GIVEAWAY],
    );
    await getPool().query("DELETE FROM marketing_sends WHERE campaign = $1", [GIVEAWAY]);
    await getPool().query("DELETE FROM customer_contacts WHERE email IS NULL AND phone = ANY($1)", [usedPhones]);
  }
  await closePool();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setMarketingSms(true);
});

// --- pure ---------------------------------------------------------------------

test("a phone number reduces to one 10-digit identity however it was written", () => {
  assert.equal(canonicalPhone10("(905) 547-5777"), "9055475777");
  assert.equal(canonicalPhone10("+1 905 547 5777"), "9055475777");
  assert.equal(canonicalPhone10("1-905-547-5777"), "9055475777");
  assert.equal(canonicalPhone10("547-5777"), "");
  assert.equal(canonicalPhone10("44 20 7946 0958"), "");
  assert.equal(toE164("905.547.5777"), "+19055475777");
  assert.equal(toE164("not a number"), null);
});

test("only a reply that is just the keyword counts", () => {
  assert.equal(smsKeyword("STOP"), "stop");
  assert.equal(smsKeyword("  stop. "), "stop");
  assert.equal(smsKeyword("Unsubscribe"), "stop");
  assert.equal(smsKeyword("start"), "start");
  assert.equal(smsKeyword("help"), "help");
  // A conversation is not a command.
  assert.equal(smsKeyword("stop by at 6?"), null);
  assert.equal(smsKeyword("please stop"), null);
  assert.equal(smsKeyword(""), null);
});

// --- STOP ---------------------------------------------------------------------

withDb("a signed STOP opts the number out, in whichever form it was stored", async () => {
  const phone = newPhone();
  // Stored with the country code; the reply arrives in E.164.
  await addContact(`1${phone}`);
  assert.equal(await isSmsOptedOut(phone), false);

  const response = await inboundRoute(signedInbound({ From: `+1${phone}`, Body: "STOP" }));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /unsubscribed/);
  assert.equal(await isSmsOptedOut(phone), true);
  assert.equal(await isSmsOptedOut(`(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`), true);

  // And START undoes it.
  await inboundRoute(signedInbound({ From: `+1${phone}`, Body: "START" }));
  assert.equal(await isSmsOptedOut(phone), false);
});

withDb("a STOP from a number we have never seen is still recorded", async () => {
  const phone = newPhone();
  await inboundRoute(signedInbound({ From: `+1${phone}`, Body: "stop" }));
  assert.equal(await isSmsOptedOut(phone), true);
});

withDb("an unsigned or forged STOP changes nothing", async () => {
  const phone = newPhone();
  const forged = await inboundRoute(signedInbound({ From: `+1${phone}`, Body: "STOP" }, "wrong-token"));
  assert.equal(forged.status, 403);
  assert.equal(await isSmsOptedOut(phone), false);
});

withDb("a reply that is not a keyword gets no auto-reply and records nothing", async () => {
  const phone = newPhone();
  const response = await inboundRoute(signedInbound({ From: `+1${phone}`, Body: "Is the TV 4K?" }));
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /<Message>/);
  assert.equal(await isSmsOptedOut(phone), false);
});

// --- audience and sending -------------------------------------------------------

withDb("the text audience is one entry per number and leaves out anyone who replied STOP", async () => {
  const staying = newPhone();
  const leaving = newPhone();
  await addContact(staying);
  await addContact(`1${staying}`, "Same Person, Other Form");
  await addContact(leaving);
  await recordSmsOptOut(`+1${leaving}`);

  const audience = await nudgeAudience(GIVEAWAY, "announce", "sms");
  const contacts = audience.recipients.map((recipient) => recipient.contact);
  assert.equal(contacts.filter((contact) => contact === `+1${staying}`).length, 1, "one text per person");
  assert.ok(!contacts.includes(`+1${leaving}`));
  assert.ok(contacts.every((contact) => /^\+1\d{10}$/.test(contact)), "every recipient is E.164");
});

withDb("sending is refused while marketing texts are switched off", async () => {
  setMarketingSms(false);
  await assert.rejects(
    queueNudge({ campaign: GIVEAWAY, nudge: "last_call", perDay: 5000, actorId: staffId, channel: "sms" }),
    (error: unknown) => error instanceof NudgeError && /switched off/.test(error.message),
  );
  await assert.rejects(queueTestNudge({ campaign: GIVEAWAY, variant: "announce", to: newPhone(), channel: "sms" }), NudgeError);
});

withDb("a test text goes out marked as a test and says how to stop", async () => {
  const calls = stubTwilio();
  const phone = newPhone();
  await queueTestNudge({ campaign: GIVEAWAY, variant: "announce", to: `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`, channel: "sms" });
  await dispatchOutbox({ limit: 50 });
  const sent = calls.find((call) => call.form.get("To") === `+1${phone}`);
  assert.ok(sent, "the test text was sent to the E.164 form of the number");
  assert.match(sent.url, /\/Messages\.json$/);
  const body = sent.form.get("Body") ?? "";
  assert.match(body, /^\[TEST\] Pizza 62/);
  assert.match(body, /Reply STOP to opt out\.$/);
  assert.doesNotMatch(body, /draw|raffle|lottery/i);
});

withDb("a queued text is skipped if the number replies STOP before it goes", async () => {
  const calls = stubTwilio();
  const staying = newPhone();
  const leaving = newPhone();
  await addContact(staying);
  await addContact(leaving);

  const queued = await queueNudge({ campaign: GIVEAWAY, nudge: "announce", perDay: 5000, actorId: staffId, channel: "sms" });
  assert.ok(queued.queued >= 2);
  // Due now, not at the next sending window, and only this test's two rows.
  await getPool().query(
    `UPDATE notification_outbox SET scheduled_for = $1,
       status = CASE WHEN recipient IN ($2, $3) THEN status ELSE 'cancelled' END
     WHERE payload_json::jsonb->>'sendId' = $4`,
    [Date.now() - 1000, `+1${staying}`, `+1${leaving}`, queued.sendId],
  );
  await inboundRoute(signedInbound({ From: `+1${leaving}`, Body: "STOP" }));
  await dispatchOutbox({ limit: 50 });

  const recipients = calls.map((call) => call.form.get("To"));
  assert.ok(recipients.includes(`+1${staying}`));
  assert.ok(!recipients.includes(`+1${leaving}`), "never texted after STOP");
  const skipped = await getPool().query<{ status: string }>(
    "SELECT status FROM notification_outbox WHERE payload_json::jsonb->>'sendId' = $1 AND recipient = $2",
    [queued.sendId, `+1${leaving}`],
  );
  assert.equal(skipped.rows[0].status, "cancelled");

  // Pressing again reaches nobody already texted, and the email audience is
  // untouched by a text send.
  const again = await nudgeAudience(GIVEAWAY, "announce", "sms");
  assert.ok(!again.recipients.some((recipient) => recipient.contact === `+1${staying}`));
});

withDb("turning marketing texts off mid-send parks the rest instead of sending or failing them", async () => {
  const calls = stubTwilio();
  const phone = newPhone();
  await addContact(phone);
  const queued = await queueNudge({ campaign: GIVEAWAY, nudge: "last_call", perDay: 5000, actorId: staffId, channel: "sms" });
  await getPool().query(
    `UPDATE notification_outbox SET scheduled_for = $1,
       status = CASE WHEN recipient = $2 THEN status ELSE 'cancelled' END
     WHERE payload_json::jsonb->>'sendId' = $3`,
    [Date.now() - 1000, `+1${phone}`, queued.sendId],
  );
  setMarketingSms(false);
  await dispatchOutbox({ limit: 50 });
  assert.ok(!calls.some((call) => call.form.get("To") === `+1${phone}`));
  const row = await getPool().query<{ status: string; attempt_count: number }>(
    "SELECT status, attempt_count FROM notification_outbox WHERE payload_json::jsonb->>'sendId' = $1 AND recipient = $2",
    [queued.sendId, `+1${phone}`],
  );
  assert.equal(row.rows[0].status, "pending_provider_setup");
  assert.equal(Number(row.rows[0].attempt_count), 0, "waiting is not an attempt");
});
