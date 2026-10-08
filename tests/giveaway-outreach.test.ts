import assert from "node:assert/strict";
import test, { before, after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";
const { getPool, closePool } = await import("@/db/pg-driver");
const { planContactImport, importContacts, parseVisit } = await import("@/lib/customer-contacts");
const { planOutreachSchedule, GIVEAWAY_DEFAULTS } = await import("@/lib/giveaway");
const { nudgeAudience, queueNudge, repaceNudge } = await import("@/lib/giveaway-nudges");
const { clearIntegrationSecretCache } = await import("@/lib/integration-secrets");
const { POST: statusRoute } = await import("@/app/api/notifications/sms/status/route");
const { twilioSignature } = await import("@/app/api/notifications/voice/ack/route");
const { dispatchOutbox, dispatchSoon } = await import("@/lib/notifications/dispatcher");
const reachable = await getPool().query("SELECT 1").then(() => true).catch(() => false);
const withDb = (name: string, body: () => Promise<void>) => test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);
const campaign = `outreach-${crypto.randomUUID()}`;
const phone = `9057${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`;
const email = `${campaign}@example.test`;
let original: string | null = null;
const now = Date.parse("2026-10-09T12:00:00-04:00");

before(async () => {
  process.env.EMAIL_API_KEY = "outreach-test"; process.env.EMAIL_FROM = "orders@example.test";
  process.env.TWILIO_ACCOUNT_SID = "AC-test"; process.env.TWILIO_AUTH_TOKEN = "status-test";
  process.env.TWILIO_FROM_NUMBER = "+19055550111"; process.env.MARKETING_SMS_ENABLED = "true";
  clearIntegrationSecretCache();
  if (!reachable) return;
  original = (await getPool().query("SELECT value_json FROM settings WHERE key = 'giveaway'")).rows[0]?.value_json ?? null;
  await getPool().query(`INSERT INTO settings (key, value_json, version, updated_at) VALUES ('giveaway',$1,1,$2)
    ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json`,
    [JSON.stringify({ ...GIVEAWAY_DEFAULTS, id: campaign, startsAt: now - 86_400_000, endsAt: now + 7 * 86_400_000 }), now]);
});
after(async () => {
  for (const key of ["EMAIL_API_KEY", "EMAIL_FROM", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "MARKETING_SMS_ENABLED"]) delete process.env[key];
  clearIntegrationSecretCache();
  if (reachable) {
    if (original) await getPool().query("UPDATE settings SET value_json = $1 WHERE key = 'giveaway'", [original]);
    else await getPool().query("DELETE FROM settings WHERE key = 'giveaway'");
    await getPool().query("DELETE FROM notification_outbox WHERE payload_json::jsonb->>'campaign' = $1", [campaign]);
    await getPool().query("DELETE FROM marketing_sends WHERE campaign = $1", [campaign]);
    await getPool().query("DELETE FROM customer_contacts WHERE email = $1 OR phone = $2", [email, phone]);
  }
  await closePool();
});

test("old POS contacts retain useful history, merge phone variants, and require one valid contact method", () => {
  const plan = planContactImport(`Customer ID,Customer name,Email,Phone,First visit,Last visit,Total visits,Total spent,Address
1,Ada,,9055550142,03/04/2026 13:45,27/09/2026 19:20,3,65.50,55 Parkdale
2,Ada second record,,+1 (905) 555-0142,22/06/2026 21:35,,2,40.00,
3,Email only,ada@example.test,123,,,,,
4,Both,grace@example.test,9055550199,,,,,
5,Neither,,0000000000,,,,,
6,Bad email,bogus,123,,,,,
7,Phone only,,9055550177,,,,,
`);
  assert.equal(plan.contacts.length, 4);
  assert.equal(plan.merged, 1);
  assert.equal(plan.skipped.length - plan.merged, 2);
  assert.equal(plan.contacts[0].legacy?.length, 2);
  assert.equal(plan.contacts[0].legacy?.[0].totalSpentCents, 6550);
  assert.equal(plan.contacts[1].phone, null);
  assert.equal(plan.contacts[1].email, "ada@example.test");
  assert.equal(parseVisit("03/04/2026 13:45"), Date.parse("2026-04-03T13:45:00-04:00"));
  assert.equal(parseVisit("31/02/2026 12:00"), null);
});

test("three-minute pacing shares booked capacity, never overlaps, and stops at closing", () => {
  const reserved = [now, now + 3 * 60_000];
  const slots = planOutreachSchedule({ count: 4, perDay: 3, intervalMinutes: 3, now, endsAt: now + 86_400_000, reserved });
  assert.equal(slots[0], now + 6 * 60_000);
  assert.equal(slots.length, 4);
  assert.ok(slots.every((slot) => !reserved.some((taken) => Math.abs(taken - slot) < 3 * 60_000)));
  const close = planOutreachSchedule({ count: 10, perDay: 160, intervalMinutes: 4, now, endsAt: now + 10 * 60_000 });
  assert.deepEqual(close, [now, now + 4 * 60_000, now + 8 * 60_000]);
});

test("send-together releases all 248 texts now while sharing the daily cap and respecting sending hours", () => {
  const start = Date.parse("2026-10-08T16:34:27-04:00");
  const input = { count: 248, perDay: 500, intervalMinutes: 0, now: start, endsAt: start + 86_400_000 };
  const slots = planOutreachSchedule({ ...input, reserved: [start, start - 60_000] });
  assert.equal(slots.length, 248);
  assert.ok(slots.every((slot) => slot === start));

  const capped = planOutreachSchedule({ ...input, perDay: 160, reserved: [start] });
  assert.equal(capped.filter((slot) => slot === start).length, 159);
  assert.equal(capped[159], Date.parse("2026-10-09T11:00:27-04:00"));
  const afterHours = Date.parse("2026-10-08T19:00:00-04:00");
  assert.deepEqual(planOutreachSchedule({ ...input, count: 2, now: afterHours }),
    Array(2).fill(Date.parse("2026-10-09T11:00:00-04:00")));
  assert.deepEqual(planOutreachSchedule({ ...input, now: input.endsAt }), []);
});

withDb("re-import fills existing contacts without duplicating identities, history or opting them back in", async () => {
  await getPool().query(`INSERT INTO customer_contacts (id,email,phone,name,source,sms_opt_out_at,created_at,updated_at)
    VALUES ($1,$2,$3,'Known name','till',$4,$4,$4)`, [crypto.randomUUID(),email,`1${phone}`,now]);
  const plan = planContactImport(`Customer ID,Customer name,Phone,Last visit,Total visits,Total spent\n17,Old name,${phone},27/09/2026 19:20,4,120.50`);
  const first = await importContacts(plan.contacts);
  const second = await importContacts(plan.contacts);
  assert.deepEqual(first, { created: 0, updated: 1 });
  assert.deepEqual(second, { created: 0, updated: 1 });
  const rows = (await getPool().query("SELECT * FROM customer_contacts WHERE email = $1", [email])).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].name, "Known name");
  assert.equal(rows[0].sms_opt_out_at, now);
  assert.equal(JSON.parse(rows[0].legacy_json).length, 1);
  const audience = await nudgeAudience(campaign, "announce", "sms", "imported");
  assert.ok(!audience.recipients.some((row) => row.contact === `+1${phone}`));
  await getPool().query("UPDATE customer_contacts SET sms_opt_out_at = NULL WHERE email = $1", [email]);
});

withDb("concurrent first sends and retried confirmations do not duplicate messages; explicit resends reach only previously sent contacts", async () => {
  const input = { campaign, nudge: "announce" as const, perDay: 160, actorId: "outreach-test", channel: "sms" as const,
    source: "imported" as const, intervalMinutes: 3, now };
  const key = crypto.randomUUID();
  const [first, duplicate] = await Promise.all([queueNudge({ ...input, requestKey: key }), queueNudge({ ...input, requestKey: key })]);
  assert.equal(first.sendId, duplicate.sendId);
  const rows = await getPool().query("SELECT * FROM notification_outbox WHERE payload_json::jsonb->>'sendId' = $1", [first.sendId]);
  assert.equal(rows.rows.length, first.queued);
  assert.equal(rows.rows.filter((row) => row.recipient === `+1${phone}`).length, 1);
  assert.equal((await queueNudge({ ...input, requestKey: crypto.randomUUID() })).queued, 0);
  assert.equal((await nudgeAudience(campaign, "announce", "sms", "imported", "resend")).recipients.length, 0);
  await getPool().query(`UPDATE notification_outbox SET status = 'sent', sent_at = $1 WHERE payload_json::jsonb->>'sendId' = $2`, [now,first.sendId]);
  assert.ok((await nudgeAudience(campaign, "announce", "sms", "imported", "resend")).recipients.some((row) => row.contact === `+1${phone}`));
  const resend = await queueNudge({ ...input, mode: "resend", requestKey: crypto.randomUUID() });
  assert.ok(resend.queued > 0);
  const changed = await repaceNudge(campaign,resend.sendId,4,160,now);
  assert.equal(changed,resend.queued);
  assert.equal((await getPool().query("SELECT status FROM notification_outbox WHERE payload_json::jsonb->>'sendId' = $1 LIMIT 1", [first.sendId])).rows[0].status,"sent");
});

withDb("SMS delivery tracking rejects unsigned callbacks and cannot regress a delivered receipt", async () => {
  const id = crypto.randomUUID();
  const url = `https://pizza62.test/api/notifications/sms/status?id=${id}`;
  await getPool().query(`INSERT INTO notification_outbox (id,kind,recipient,payload_json,status,scheduled_for,created_at,updated_at)
    VALUES ($1,'giveaway_nudge_sms',$2,$3,'sent',$4,$4,$4)`,[id,`+1${phone}`,JSON.stringify({campaign,nudge:"announce"}),now]);
  const request = (status: string, signed = true) => {
    const params = { MessageSid: "SM-status-test", MessageStatus: status };
    return new Request(url,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded", "x-twilio-signature":signed ? twilioSignature("status-test",url,params) : "bad"},body:new URLSearchParams(params)});
  };
  assert.equal((await statusRoute(request("delivered",false))).status,403);
  assert.equal((await statusRoute(request("delivered"))).status,204);
  await statusRoute(request("sent"));
  const row = (await getPool().query("SELECT delivery_status,provider_reference FROM notification_outbox WHERE id = $1",[id])).rows[0];
  assert.equal(row.delivery_status,"delivered"); assert.equal(row.provider_reference,"SM-status-test");
});

withDb("a delayed dispatcher sends one paced text at a time instead of bursting overdue messages", async () => {
  await getPool().query("UPDATE notification_outbox SET status = 'cancelled' WHERE status IN ('pending','retrying','sending','pending_provider_setup')");
  const sendId = crypto.randomUUID();
  await getPool().query(`INSERT INTO marketing_sends
    (id,campaign,nudge,channel,recipient_count,per_day,interval_minutes,created_by,created_at)
    VALUES ($1,$2,'last_call','sms',2,160,3,'test',$3)`, [sendId,campaign,now]);
  for (const to of ["+19057770001", "+19057770002"]) await getPool().query(`INSERT INTO notification_outbox
    (id,kind,recipient,payload_json,status,scheduled_for,created_at,updated_at)
    VALUES ($1,'giveaway_nudge_sms',$2,$3,'pending',$4,$4,$4)`,
    [crypto.randomUUID(),to,JSON.stringify({sendId,campaign,nudge:"last_call"}),now-60_000]);
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let calls = 0;
  let time = now + 4 * 60_000;
  Date.now = () => time;
  globalThis.fetch = (async () => { calls += 1; return new Response(JSON.stringify({sid:`SM-paced-${calls}`})); }) as typeof fetch;
  try {
    assert.equal((await dispatchOutbox({now:time})).sent,1);
    time += 2 * 60_000;
    assert.equal((await dispatchOutbox({now:time})).sent,0);
    time += 60_000;
    assert.equal((await dispatchOutbox({now:time})).sent,1);
    assert.equal(calls,2);
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
});

withDb("send-together drains more than one dispatch batch immediately", async () => {
  await getPool().query("UPDATE notification_outbox SET status = 'cancelled' WHERE status IN ('pending','retrying','sending','pending_provider_setup')");
  const sendId = crypto.randomUUID();
  await getPool().query(`INSERT INTO marketing_sends
    (id,campaign,nudge,channel,recipient_count,per_day,interval_minutes,created_by,created_at)
    VALUES ($1,$2,'last_call','sms',26,500,0,'test',$3)`, [sendId,campaign,now]);
  await getPool().query(`INSERT INTO notification_outbox
    (id,kind,recipient,payload_json,status,scheduled_for,created_at,updated_at)
    SELECT gen_random_uuid()::text,'giveaway_nudge_sms','+1905777' || lpad(i::text,4,'0'),$1,'pending',$2,$2,$2
    FROM generate_series(1,26) AS i`, [JSON.stringify({sendId,campaign,nudge:"last_call"}),now]);
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let calls = 0;
  Date.now = () => now;
  globalThis.fetch = (async () => { calls += 1; return new Response(JSON.stringify({sid:`SM-together-${calls}`})); }) as typeof fetch;
  try {
    await dispatchSoon({ drain: true });
    assert.equal(calls,26);
    const statuses = (await getPool().query("SELECT status FROM notification_outbox WHERE payload_json::jsonb->>'sendId' = $1", [sendId])).rows;
    assert.ok(statuses.every((row) => row.status === "sent"));
    assert.equal((await dispatchOutbox({now})).sent,0);
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
});
