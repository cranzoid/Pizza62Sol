/**
 * The Thanksgiving Giveaway — Pizza 62 turns one.
 *
 * What is worth pinning, in order of what would hurt most if it broke:
 *
 * **An order earns exactly one entry, and only a real one.** A qualifying
 * pay-at-store order gets a number the moment it commits; a card order gets
 * one only once the payment clears; an order under the minimum, or outside the
 * window, gets none. Recording is idempotent, so a redelivered webhook or the
 * cron sweep never mints a second number or a second email.
 *
 * **The numbers are sequential and never shared**, even for orders placed at
 * the same instant — they are what the owner reads out on the day.
 *
 * **The winner comes only from entries still in.** A cancelled order's entry
 * is never picked; picking again skips the same person; and nobody can pick
 * before entries close, or without being the owner.
 *
 * **Marketing email respects consent.** An unsubscribed address is never in a
 * nudge's audience, is skipped at send time even if it was queued before, and
 * an import can never re-subscribe it. Every nudge carries a working
 * unsubscribe link and the RFC 8058 one-click header.
 *
 * **It is a giveaway.** The owner was explicit, so no customer-facing email
 * says "draw".
 *
 * The suite runs against its own giveaway (a fresh id per run, so numbering
 * starts at 1), with a window it controls, and puts the real setting back
 * afterwards. Requires a reachable Postgres for everything but the pure rules.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { getSetting } = await import("@/db/runtime");
const { createPasswordHash } = await import("@/lib/auth");
const { nextOrderSlots } = await import("@/lib/domain");
const giveawayRules = await import("@/lib/giveaway");
const {
  centsToQualify,
  formatEntryNumber,
  GIVEAWAY_DEFAULTS,
  lastEntryDayLabel,
  NUDGE_WINDOW,
  orderQualifies,
  planNudgeSchedule,
} = giveawayRules;
const { pickGiveawayWinner, recordGiveawayEntry, sweepGiveawayEntries, secureRandomIndex } = await import("@/lib/giveaway-store");
const { nudgeAudience, queueNudge } = await import("@/lib/giveaway-nudges");
const { parseBirthday, parseCsv, planContactImport } = await import("@/lib/customer-contacts");
const { isOptedOut, recordOptOut, unsubscribeQuery, verifyUnsubscribe } = await import("@/lib/marketing-consent");
const { renderGiveawayEntry, renderGiveawayNudge } = await import("@/lib/notifications/messages");
const { dispatchOutbox } = await import("@/lib/notifications/dispatcher");
const { applyPaymentApproved } = await import("@/lib/payment-completion");
const { buildPassPrntTicketHtml } = await import("@/lib/passprnt");
const { POST: publicOrderRoute } = await import("@/app/api/orders/route");
const { POST: loginRoute } = await import("@/app/api/auth/login/route");
const { POST: staffOrderRoute } = await import("@/app/api/admin/orders/route");
const { GET: giveawayGet, POST: giveawayPost } = await import("@/app/api/admin/giveaway/route");
const { POST: contactsPost } = await import("@/app/api/admin/contacts/route");
const { POST: unsubscribeRoute } = await import("@/app/api/marketing/unsubscribe/route");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const RUN = crypto.randomUUID().slice(0, 8);
const GIVEAWAY = `test-${RUN}`;
let counter = 0;
const nextClientIp = () => `203.0.113.${(counter += 1) % 250}-${RUN}`;
const uniqueKey = () => `giveaway-${RUN}-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const PASSWORD = "Correct Horse Battery Staple 62";
const realFetch = globalThis.fetch;

let originalSetting: string | null = null;
let windowStart = 0;

/** Points the live `giveaway` setting at this suite's own giveaway. */
async function useGiveaway(overrides: Record<string, unknown> = {}) {
  await getPool().query(
    "UPDATE settings SET value_json = $1, updated_at = $2 WHERE key = 'giveaway'",
    [
      JSON.stringify({
        ...GIVEAWAY_DEFAULTS,
        id: GIVEAWAY,
        startsAt: windowStart,
        endsAt: Date.now() + 7 * 86_400_000,
        ...overrides,
      }),
      Date.now(),
    ],
  );
}

before(async () => {
  process.env.EMAIL_API_KEY = "test-email-key";
  process.env.EMAIL_FROM = "orders@pizza62.test";
  process.env.PUBLIC_BASE_URL = "https://pizza62.test";
  if (!reachable) return;
  const row = await getPool().query<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'giveaway'");
  originalSetting = row.rows[0]?.value_json ?? null;
  if (!originalSetting) {
    await getPool().query(
      "INSERT INTO settings (key, value_json, version, updated_at) VALUES ('giveaway', '{}', 1, $1)",
      [Date.now()],
    );
  }
  // Only orders this file creates fall inside the window, so the sweep and
  // the counts below cannot be disturbed by the rest of the suite.
  windowStart = Date.now();
  await useGiveaway();
  // Trap 8 (see notifications.test.ts): the dispatcher claims a bounded number
  // of due rows across the whole, never-reset test database, so the queue is
  // emptied of anything this run did not create.
  await getPool().query(
    "UPDATE notification_outbox SET status = 'cancelled', updated_at = $1 WHERE status IN ('pending', 'retrying', 'sending', 'pending_provider_setup')",
    [Date.now()],
  );
});

after(async () => {
  if (reachable) {
    if (originalSetting) {
      await getPool().query("UPDATE settings SET value_json = $1 WHERE key = 'giveaway'", [originalSetting]);
    } else {
      await getPool().query("DELETE FROM settings WHERE key = 'giveaway'");
    }
    // Nudges queued by this suite must never be picked up by a later one.
    await getPool().query(
      "DELETE FROM notification_outbox WHERE kind = 'giveaway_nudge' AND payload_json::jsonb->>'campaign' = $1",
      [GIVEAWAY],
    );
  }
  await closePool();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubEmail(): Array<{ url: string; body: Record<string, unknown> }> {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ id: "email-1" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

async function nextSlot(): Promise<number> {
  const hours = await getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours");
  return nextOrderSlots({ now: Date.now(), hours, timeZone: "America/Toronto", leadMinutes: 30, limit: 1 })[0];
}

/** A real pay-at-store order through the public route. Poutine is C$8.99. */
async function placeOrder(quantity: number, email = `buyer-${RUN}-${(counter += 1)}@example.test`) {
  const response = await publicOrderRoute(
    new Request("https://order.pizza62.test/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": nextClientIp() },
      body: JSON.stringify({
        idempotencyKey: uniqueKey(),
        fulfilment: "pickup",
        customer: { name: "Grace Hopper", phone: "905-555-0199", email },
        items: [{ productId: "poutine", quantity }],
        schedule: { type: "scheduled", scheduledFor: await nextSlot() },
        paymentMethod: "pay_at_store",
        tip: { type: "none" },
      }),
    }),
  );
  assert.equal(response.status, 201);
  const result: Record<string, unknown> = { ...((await response.json()) as Record<string, unknown>), email };
  return result;
}

/** An order row written directly, the way the previous release would have. */
async function seedOrder(options: { status?: string; paymentStatus?: string; paymentMethod?: string; subtotalCents?: number; email?: string } = {}) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await getPool().query(
    `INSERT INTO orders (id,order_number,tracking_token_hash,feedback_token_hash,customer_name,customer_phone,
       customer_email,fulfilment,channel,status,payment_status,payment_method,schedule_type,estimated_for,pricing_json,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'Seeded Buyer','9055550100',$5,'pickup','online',$6,$7,$8,'asap',$9,'{}',$10,0,0,0,0,$10,$9,$9)`,
    [
      id,
      `P62-G${RUN}-${(counter += 1)}`,
      `h${id}`,
      `f${id}`,
      options.email ?? `seeded-${RUN}-${counter}@example.test`,
      options.status ?? "received",
      options.paymentStatus ?? "pending_at_store",
      options.paymentMethod ?? "pay_at_store",
      now,
      options.subtotalCents ?? 1500,
    ],
  );
  return id;
}

async function signedInAs(role: "owner" | "manager", permissions: string[] = []): Promise<string> {
  const id = crypto.randomUUID();
  const email = `giveaway-${id}@example.test`;
  const hash = await createPasswordHash(PASSWORD);
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_users (id,email,name,role,password_hash,password_salt,password_iterations,permissions_json,active,created_at,updated_at)
     VALUES ($1,$2,'Giveaway Tester',$3,$4,$5,$6,$7,1,$8,$8)`,
    [id, email, role, hash.hash, hash.salt, hash.iterations, JSON.stringify(permissions), now],
  );
  const response = await loginRoute(
    new Request("https://order.pizza62.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": nextClientIp() },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  assert.equal(response.status, 200);
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

const adminPost = (route: (request: Request) => Promise<Response>, path: string, cookie: string, body: unknown) =>
  route(
    new Request(`https://order.pizza62.test${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const entryFor = async (orderId: string) =>
  (await getPool().query<{ entry_number: number; giveaway_id: string }>(
    "SELECT entry_number, giveaway_id FROM giveaway_entries WHERE order_id = $1",
    [orderId],
  )).rows;

const outboxFor = async (orderId: string, kind: string) =>
  (await getPool().query<{ id: string; status: string; scheduled_for: number }>(
    "SELECT id, status, scheduled_for FROM notification_outbox WHERE kind = $1 AND payload_json::jsonb->>'orderId' = $2",
    [kind, orderId],
  )).rows;

// --- the rules, without a database ---------------------------------------------

const RULES = { ...GIVEAWAY_DEFAULTS, startsAt: Date.parse("2026-09-27T12:00:00-04:00") };

test("the minimum is C$10 of food after discounts, before tax, and inclusive", () => {
  const placedAt = Date.parse("2026-10-01T18:00:00-04:00");
  assert.equal(orderQualifies(RULES, { placedAt, subtotalCents: 1000, discountCents: 0 }), true);
  assert.equal(orderQualifies(RULES, { placedAt, subtotalCents: 999, discountCents: 0 }), false);
  // A promo that takes the food under C$10 takes the entry with it.
  assert.equal(orderQualifies(RULES, { placedAt, subtotalCents: 1200, discountCents: 300 }), false);
  assert.equal(centsToQualify(RULES, { subtotalCents: 899, discountCents: 0 }), 101);
  assert.equal(centsToQualify(RULES, { subtotalCents: 2500, discountCents: 0 }), 0);
});

test("only orders placed inside the window count, and the last night counts in full", () => {
  const food = { subtotalCents: 2000, discountCents: 0 };
  assert.equal(orderQualifies(RULES, { placedAt: RULES.startsAt - 1, ...food }), false);
  assert.equal(orderQualifies(RULES, { placedAt: RULES.startsAt, ...food }), true);
  // Sunday, October 11, 9:59 p.m. — the last order of the night.
  assert.equal(orderQualifies(RULES, { placedAt: Date.parse("2026-10-11T21:59:00-04:00"), ...food }), true);
  // Thanksgiving Monday does not.
  assert.equal(orderQualifies(RULES, { placedAt: Date.parse("2026-10-12T00:00:00-04:00"), ...food }), false);
  assert.equal(orderQualifies({ ...RULES, enabled: false }, { placedAt: RULES.startsAt, ...food }), false);
  assert.equal(lastEntryDayLabel(RULES), "Sunday, October 11");
});

test("entry numbers are four digits, so every receipt reads the same way", () => {
  assert.equal(formatEntryNumber(1), "0001");
  assert.equal(formatEntryNumber(42), "0042");
  assert.equal(formatEntryNumber(12345), "12345");
});

test("nudges are paced: never more than the daily limit, only in sending hours, in order", () => {
  const now = Date.parse("2026-09-28T09:30:00-04:00");
  const slots = planNudgeSchedule(200, 80, now);
  assert.equal(slots.length, 200);
  assert.ok(slots[0] >= now);
  assert.deepEqual([...slots].sort((left, right) => left - right), slots);
  const perDay = new Map<string, number>();
  for (const slot of slots) {
    const date = new Date(slot).toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
    perDay.set(date, (perDay.get(date) ?? 0) + 1);
    const time = new Date(slot).toLocaleTimeString("en-GB", { timeZone: "America/Toronto", hour12: false });
    const minute = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    assert.ok(minute >= NUDGE_WINDOW.startMinute && minute < NUDGE_WINDOW.endMinute, `${time} is outside sending hours`);
  }
  assert.deepEqual([...perDay.values()], [80, 80, 40]);
  // Pressed after hours, it waits for the next morning rather than going at night.
  const late = planNudgeSchedule(1, 80, Date.parse("2026-09-28T21:00:00-04:00"));
  assert.equal(new Date(late[0]).toLocaleDateString("en-CA", { timeZone: "America/Toronto" }), "2026-09-29");
});

test("picking is uniform and never out of range", () => {
  const seen = new Set<number>();
  for (let index = 0; index < 400; index += 1) {
    const pick = secureRandomIndex(5);
    assert.ok(pick >= 0 && pick < 5);
    seen.add(pick);
  }
  assert.equal(seen.size, 5);
  assert.throws(() => secureRandomIndex(0));
});

test("a POS export is read whatever it calls its columns", () => {
  const loyverse = planContactImport(
    '﻿Customer name,Email,Phone,Note,Last visit\r\n"Lovelace, Ada",ADA@Example.test,(905) 555-0142,"Likes ""extra"" cheese",2026-08-01\r\nNo Contact,,,,\r\nBad Email,not-an-email,,,\r\nDuplicate,ada@example.test,,,\r\n',
  );
  assert.deepEqual(Object.keys(loyverse.columns).sort(), ["email", "lastVisit", "name", "notes", "phone"]);
  assert.equal(loyverse.contacts.length, 1);
  assert.deepEqual(
    { ...loyverse.contacts[0], lastVisitAt: typeof loyverse.contacts[0].lastVisitAt },
    { name: "Lovelace, Ada", email: "ada@example.test", phone: "9055550142", birthday: null, notes: 'Likes "extra" cheese', lastVisitAt: "number" },
  );
  assert.equal(loyverse.skipped.length, 3);

  const clover = planContactImport("First Name,Last Name,Mobile,Birthday\nGrace,Hopper,905 555 0199,12/09\n");
  assert.deepEqual(clover.contacts[0].birthday, { month: 12, day: 9 });
  assert.equal(clover.contacts[0].name, "Grace Hopper");
  assert.equal(clover.contacts[0].phone, "9055550199");

  assert.throws(() => planContactImport("Name,Notes\nAda,hi\n"), /No email or phone column/);
});

test("birthdays keep the month and day and throw the year away", () => {
  assert.deepEqual(parseBirthday("1990-03-04"), { month: 3, day: 4 });
  assert.deepEqual(parseBirthday("03/04"), { month: 3, day: 4 });
  assert.deepEqual(parseBirthday("25/12/1985"), { month: 12, day: 25 });
  assert.deepEqual(parseBirthday("July 4"), { month: 7, day: 4 });
  assert.deepEqual(parseBirthday("4 Jul"), { month: 7, day: 4 });
  assert.deepEqual(parseBirthday("--02-29"), { month: 2, day: 29 });
  assert.equal(parseBirthday("02/30"), null);
  assert.equal(parseBirthday("someday"), null);
  assert.deepEqual(parseCsv('a,"b\nc",d\n'), [["a", "b\nc", "d"]]);
});

test("the giveaway emails say giveaway, never draw, and the nudge can be unsubscribed from", async () => {
  const order = {
    id: "o1", order_number: "P62-1234", customer_name: "Ada Lovelace", customer_email: "ada@example.test",
    customer_phone: "", fulfilment: "pickup", channel: "online", status: "received", payment_status: "paid",
    payment_method: "online", schedule_type: "asap", scheduled_for: null, estimated_for: Date.now(),
    subtotal_cents: 1500, discount_cents: 0, tax_cents: 195, delivery_fee_cents: 0, tip_cents: 0,
    total_cents: 1695, gift_card_applied_cents: 0, address_json: null, instructions: null,
    acknowledged_at: null, created_at: Date.now(),
  };
  const entry = await renderGiveawayEntry(order, { entryNumber: 42, giveaway: RULES, totalEntries: 2 });
  assert.match(entry.emailSubject, /entry 0042/);
  assert.match(entry.emailHtml, /0042/);
  assert.match(entry.emailText, /Your entry number: 0042/);
  assert.match(entry.emailText, /55-inch TV/);
  assert.match(entry.emailText, /2 so far/);

  const nudge = await renderGiveawayNudge({
    name: "Grace Hopper", variant: "announce", giveaway: RULES, entries: 0,
    unsubscribeHref: "https://pizza62.test/unsubscribe?e=abc&t=def", now: Date.parse("2026-09-28T12:00:00-04:00"),
  });
  assert.match(nudge.emailHtml, /unsubscribe\?e=abc&amp;t=def/);
  assert.match(nudge.emailText, /Unsubscribe: https:\/\/pizza62\.test\/unsubscribe\?e=abc&t=def/);
  assert.match(nudge.emailText, /55 Parkdale Ave N/);

  const lastCall = await renderGiveawayNudge({
    name: "", variant: "last_call", giveaway: RULES, entries: 3,
    unsubscribeHref: "https://pizza62.test/unsubscribe", now: Date.parse("2026-10-10T12:00:00-04:00"),
  });
  assert.match(lastCall.emailSubject, /entries close tomorrow/);
  assert.match(lastCall.emailText, /3 entries/);

  for (const message of [entry, nudge, lastCall]) {
    for (const part of [message.emailSubject, message.emailText, message.emailHtml, message.smsBody]) {
      assert.doesNotMatch(part, /\bdraw/i, "the owner asked for giveaway, not draw");
    }
  }
});

test("the printed ticket carries the entry number, and only when there is one", () => {
  const order = { order_number: "P62-1234", fulfilment: "pickup", customer_name: "Ada", items: [], created_at: Date.now() };
  assert.match(buildPassPrntTicketHtml({ ...order, giveaway_entry_number: 7 }, new Map(), Date.now()), /THANKSGIVING GIVEAWAY<br><b>ENTRY #0007<\/b>/);
  assert.doesNotMatch(buildPassPrntTicketHtml(order, new Map(), Date.now()), /GIVEAWAY/);
});

// --- entries --------------------------------------------------------------------

withDb("a qualifying pay-at-store order gets the next number and a you're-in email", async () => {
  const first = await placeOrder(2);
  const second = await placeOrder(3);
  assert.equal(first.giveawayEntryNumber, 1);
  assert.equal(second.giveawayEntryNumber, 2);
  assert.deepEqual(await entryFor(String(first.orderId)), [{ entry_number: 1, giveaway_id: GIVEAWAY }]);
  const emails = await outboxFor(String(first.orderId), "giveaway_entry");
  assert.equal(emails.length, 1);
  // A beat after the receipt, so the order confirmation lands first.
  assert.ok(Number(emails[0].scheduled_for) > Date.now() - 5_000);
});

withDb("an order under the minimum gets no entry and no email", async () => {
  const small = await placeOrder(1);
  assert.equal(small.giveawayEntryNumber, null);
  assert.deepEqual(await entryFor(String(small.orderId)), []);
  assert.deepEqual(await outboxFor(String(small.orderId), "giveaway_entry"), []);
});

withDb("recording again — a redelivered webhook, the sweep — never mints a second number or email", async () => {
  const order = await placeOrder(2);
  const again = await recordGiveawayEntry(String(order.orderId));
  assert.equal(again, order.giveawayEntryNumber);
  assert.equal((await entryFor(String(order.orderId))).length, 1);
  assert.equal((await outboxFor(String(order.orderId), "giveaway_entry")).length, 1);
});

withDb("orders placed at the same instant get distinct, gapless numbers", async () => {
  const ids = await Promise.all(Array.from({ length: 6 }, () => seedOrder()));
  const numbers = await Promise.all(ids.map((id) => recordGiveawayEntry(id)));
  const sorted = [...numbers].map(Number).sort((left, right) => left - right);
  assert.equal(new Set(sorted).size, 6);
  assert.equal(sorted.at(-1)! - sorted[0], 5, "no number was skipped");
});

withDb("a card order earns its entry when the payment clears, not before", async () => {
  const id = await seedOrder({ status: "awaiting_payment", paymentStatus: "awaiting_checkout", paymentMethod: "online" });
  assert.equal(await recordGiveawayEntry(id), null);
  await applyPaymentApproved({ orderId: id, note: "test payment" });
  assert.equal((await entryFor(id)).length, 1);
});

withDb("the cron sweep catches a qualifying order the previous release took without an entry", async () => {
  const missed = await seedOrder();
  const cancelled = await seedOrder({ status: "cancelled", paymentStatus: "cancelled" });
  const small = await seedOrder({ subtotalCents: 500 });
  const result = await sweepGiveawayEntries();
  assert.ok(result.recorded >= 1);
  assert.equal((await entryFor(missed)).length, 1);
  assert.equal((await entryFor(cancelled)).length, 0);
  assert.equal((await entryFor(small)).length, 0);
});

withDb("an order placed after entries close earns nothing", async () => {
  await useGiveaway({ endsAt: windowStart + 1 });
  try {
    const late = await seedOrder();
    assert.equal(await recordGiveawayEntry(late), null);
  } finally {
    await useGiveaway();
  }
});

withDb("the till says the entry number and files a birthday against the customer", async () => {
  const owner = await signedInAs("owner");
  const email = `walkin-${RUN}@example.test`;
  const response = await adminPost(staffOrderRoute, "/api/admin/orders", owner, {
    channel: "walk_in",
    idempotencyKey: uniqueKey(),
    fulfilment: "pickup",
    customer: { name: "Walk In", phone: "", email },
    items: [{ productId: "poutine", quantity: 2 }],
    schedule: { type: "scheduled", scheduledFor: await nextSlot() },
    paymentMethod: "pay_at_store",
    tip: { type: "none" },
    birthday: { month: 10, day: 12 },
  });
  assert.equal(response.status, 201);
  const result = (await response.json()) as Record<string, unknown>;
  assert.ok(Number(result.giveawayEntryNumber) > 0);
  assert.equal(result.birthdaySaved, true);
  assert.equal((result.printOrder as Record<string, unknown>).giveaway_entry_number, result.giveawayEntryNumber);
  const contact = await getPool().query("SELECT birth_month, birth_day, source FROM customer_contacts WHERE email = $1", [email]);
  assert.deepEqual(contact.rows[0], { birth_month: 10, birth_day: 12, source: "till" });
});

// --- picking the winner -------------------------------------------------------

withDb("only the owner can pick, and only once entries have closed", async () => {
  const owner = await signedInAs("owner");
  const manager = await signedInAs("manager", ["view_orders", "manage_promotions"]);
  assert.equal((await adminPost(giveawayPost, "/api/admin/giveaway", owner, { action: "winner.pick" })).status, 409);
  await useGiveaway({ endsAt: Date.now() - 1 });
  try {
    assert.equal((await adminPost(giveawayPost, "/api/admin/giveaway", manager, { action: "winner.pick" })).status, 403);
    const picked = await adminPost(giveawayPost, "/api/admin/giveaway", owner, { action: "winner.pick" });
    assert.equal(picked.status, 200);
    const winner = ((await picked.json()) as { winner: { entry_label: string; eligible: boolean } }).winner;
    assert.match(winner.entry_label, /^\d{4}$/);
    assert.equal(winner.eligible, true);
  } finally {
    await useGiveaway();
  }
});

withDb("a cancelled order is never picked, and picking again skips the same person", async () => {
  const pool = getPool();
  // A fresh giveaway so the pool is exactly these entries.
  const isolated = `${GIVEAWAY}-pick`;
  await useGiveaway({ id: isolated });
  try {
    const keeper = await seedOrder({ email: `keeper-${RUN}@example.test` });
    const keeperAgain = await seedOrder({ email: `keeper-${RUN}@example.test` });
    const cancelled = await seedOrder({ email: `cancelled-${RUN}@example.test` });
    for (const id of [keeper, keeperAgain, cancelled]) await recordGiveawayEntry(id);
    await pool.query("UPDATE orders SET status = 'cancelled', payment_status = 'cancelled' WHERE id = $1", [cancelled]);

    const staff = (await pool.query<{ id: string }>("SELECT id FROM staff_users LIMIT 1")).rows[0].id;
    const first = await pickGiveawayWinner(isolated, staff);
    assert.equal(first?.customer_email, `keeper-${RUN}@example.test`);
    // The only other eligible entry belongs to the same person, so there is
    // nobody left — and the cancelled order is never an option.
    assert.equal(await pickGiveawayWinner(isolated, staff), null);
  } finally {
    await useGiveaway();
  }
});

// --- consent and nudges --------------------------------------------------------

withDb("an unsubscribe link works for exactly one address, and only by POST", async () => {
  const email = `unsub-${RUN}@example.test`;
  const query = await unsubscribeQuery(email);
  assert.equal(await verifyUnsubscribe(new URLSearchParams(query).get("e"), new URLSearchParams(query).get("t")), email);
  const forged = (await unsubscribeQuery(`someone-else-${RUN}@example.test`)).replace(/t=.*/, new URLSearchParams(query).get("t") ?? "");
  assert.equal(await verifyUnsubscribe(new URLSearchParams(forged).get("e"), new URLSearchParams(forged).get("t")), null);

  const response = await unsubscribeRoute(new Request(`https://pizza62.test/api/marketing/unsubscribe?${query}`, { method: "POST" }));
  assert.equal(response.status, 200);
  assert.equal(await isOptedOut(email), true);
  const bad = await unsubscribeRoute(new Request(`https://pizza62.test/api/marketing/unsubscribe?e=x&t=${"a".repeat(22)}`, { method: "POST" }));
  assert.equal(bad.status, 400);
});

withDb("a nudge reaches buyers and imported customers, never the unsubscribed, and never twice", async () => {
  const owner = await signedInAs("owner");
  const buyer = `nudge-buyer-${RUN}@example.test`;
  const imported = `nudge-import-${RUN}@example.test`;
  const leaver = `nudge-leaver-${RUN}@example.test`;
  await placeOrder(1, buyer);
  await placeOrder(1, leaver);
  await recordOptOut(leaver);

  // Importing the leaver again must not re-subscribe them.
  const csv = `Customer name,Email\nImported Person,${imported}\nThe Leaver,${leaver}\n`;
  const preview = await adminPost(contactsPost, "/api/admin/contacts", owner, { action: "import.preview", csv });
  assert.equal(((await preview.json()) as { ready: number }).ready, 2);
  const commit = await adminPost(contactsPost, "/api/admin/contacts", owner, { action: "import.commit", csv });
  assert.equal(commit.status, 200);
  assert.equal(await isOptedOut(leaver), true);

  const before = await nudgeAudience(GIVEAWAY, "announce");
  const emails = new Set(before.recipients.map((recipient) => recipient.email));
  assert.ok(emails.has(buyer));
  assert.ok(emails.has(imported));
  assert.ok(!emails.has(leaver));

  const staff = (await getPool().query<{ id: string }>("SELECT id FROM staff_users LIMIT 1")).rows[0].id;
  const queued = await queueNudge({ campaign: GIVEAWAY, nudge: "announce", perDay: 5000, actorId: staff });
  assert.equal(queued.queued, before.recipients.length);
  const afterward = await nudgeAudience(GIVEAWAY, "announce");
  assert.equal(afterward.recipients.length, 0, "pressing the button again reaches nobody new");
  // The last-call nudge is its own send: everyone is still reachable for it.
  assert.equal((await nudgeAudience(GIVEAWAY, "last_call")).recipients.length, before.recipients.length);
});

withDb("a queued nudge is skipped at send time if its recipient has since unsubscribed", async () => {
  const calls = stubEmail();
  const staying = `still-here-${RUN}@example.test`;
  const leaving = `changed-mind-${RUN}@example.test`;
  const now = Date.now();
  for (const email of [staying, leaving]) {
    await getPool().query(
      `INSERT INTO notification_outbox (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
       VALUES ($1, 'giveaway_nudge', $2, $3, 'pending', 0, $4, $4, $4)`,
      [crypto.randomUUID(), email, JSON.stringify({ campaign: GIVEAWAY, nudge: "last_call", sendId: `send-${RUN}`, name: "Ada" }), now],
    );
  }
  await recordOptOut(leaving);
  await dispatchOutbox({ limit: 50 });

  const sent = calls.filter((call) => (call.body.to as string[])[0] === staying);
  assert.equal(sent.length, 1);
  assert.equal(calls.filter((call) => (call.body.to as string[])[0] === leaving).length, 0);
  const headers = sent[0].body.headers as Record<string, string>;
  assert.match(headers["List-Unsubscribe"], /^<https:\/\/pizza62\.test\/api\/marketing\/unsubscribe\?e=.+&t=.+>$/);
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  const skipped = await getPool().query<{ status: string }>(
    "SELECT status FROM notification_outbox WHERE kind = 'giveaway_nudge' AND recipient = $1",
    [leaving],
  );
  assert.equal(skipped.rows[0].status, "cancelled");
});

withDb("the admin screen masks contact details for staff without the contact permission", async () => {
  await placeOrder(2, `masked-${RUN}@example.test`);
  const manager = await signedInAs("manager", ["view_orders", "manage_promotions"]);
  const response = await giveawayGet(
    new Request(`https://order.pizza62.test/api/admin/giveaway?q=masked-${RUN}`, { headers: { cookie: manager } }),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { entries: Array<{ customer_email: string }>; canViewContact: boolean };
  assert.equal(body.canViewContact, false);
  assert.equal(body.entries.length, 0, "a masked email cannot be searched by, either");
  const all = await giveawayGet(new Request("https://order.pizza62.test/api/admin/giveaway", { headers: { cookie: manager } }));
  const listed = (await all.json()) as { entries: Array<{ customer_email: string }> };
  assert.ok(listed.entries.every((entry) => !entry.customer_email.includes("@")));
});
