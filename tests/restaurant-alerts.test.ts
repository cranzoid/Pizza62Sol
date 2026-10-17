/**
 * Channel-aware restaurant alerts and voice-only re-calls (Phase 1E).
 *
 * Two things changed in the existing `restaurant_new_order` delivery, and no
 * second notification system was added:
 *
 * 1. **Wording.** The alert call opened "New order from the Pizza 62 website"
 *    for every order, so a phone order keyed in at the till was announced as a
 *    website order. Each channel is now named, and an order the AI phone line
 *    took says so in the call, the email and the text.
 * 2. **Re-calls.** `requeueUnacknowledgedOrders` re-ran the whole delivery, so
 *    every two-minute re-call also re-sent the email. A re-call now places only
 *    the call; so does the retry after a call that failed once the email had
 *    already gone. The first alert still sends the email and places the call,
 *    and still never texts the landline.
 *
 * `fetch` is stubbed: nothing here talks to Twilio or the email provider. Each
 * test uses its own alert number and recipient so another file's rows cannot
 * land in its assertions.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { getSetting } = await import("@/db/runtime");
const { nextOrderSlots } = await import("@/lib/domain");
const { dispatchOutbox, requeueUnacknowledgedOrders } = await import("@/lib/notifications/dispatcher");
const { renderRestaurantNewOrder } = await import("@/lib/notifications/messages");
const { createOrder } = await import("@/lib/order-service");
const { aiPhoneOrderContext, staffOrderContext } = await import("@/lib/order-policy");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const realFetch = globalThis.fetch;
const RUN = crypto.randomUUID().slice(0, 8);
let seq = 0;
const uniqueId = () => `alert-${RUN}-${(seq += 1)}-${crypto.randomUUID()}`;

const ENV = {
  EMAIL_API_KEY: "test-email-key",
  EMAIL_FROM: "orders@pizza62.test",
  PUBLIC_BASE_URL: "https://pizza62.test",
  TWILIO_ACCOUNT_SID: "AC-test",
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_FROM_NUMBER: "+15550000000",
};

/** Clears the queue of everything this file did not create — see notifications.test.ts, trap 8. */
async function quietQueue() {
  await getPool().query(
    "UPDATE notification_outbox SET status = 'cancelled', updated_at = $1 WHERE status IN ('pending', 'retrying', 'sending', 'pending_provider_setup')",
    [Date.now()],
  );
}

before(async () => {
  Object.assign(process.env, ENV);
  if (reachable) await quietQueue();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.RESTAURANT_ALERT_PHONE;
});

type ProviderCall = { url: string; body: string };

/** Records every outbound provider call; Twilio Calls answer with `callStatus`. */
function stubProviders(callStatus = 201): ProviderCall[] {
  const calls: ProviderCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? "") });
    const status = /\/Calls\.json$/.test(url) ? callStatus : 202;
    return new Response(status < 300 ? "{}" : JSON.stringify({ message: "provider said no" }), {
      status,
      headers: { "content-type": "application/json", "x-message-id": "msg-123" },
    });
  }) as typeof fetch;
  return calls;
}

const alertNumber = () => `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
const callsFor = (calls: ProviderCall[], orderId: string) =>
  calls.filter((call) => /\/Calls\.json$/.test(call.url) && call.body.includes(encodeURIComponent(orderId)));
const textsTo = (calls: ProviderCall[], number: string) =>
  calls.filter((call) => /\/Messages\.json$/.test(call.url) && new URLSearchParams(call.body).get("To") === number);
const emailsTo = (calls: ProviderCall[], recipient: string) =>
  calls.filter((call) => !/twilio/.test(call.url) && call.body.includes(recipient));
const spoken = (call: ProviderCall) => new URLSearchParams(call.body).get("Twiml") ?? "";

/** A real order row on `channel`, plus its restaurant alert addressed to a unique recipient. */
async function seedAlert(channel: string, options: { status?: string; attemptCount?: number; acknowledged?: boolean } = {}) {
  const orderId = uniqueId();
  const outboxId = uniqueId();
  const orderNumber = `P62-A${RUN}-${(seq += 1)}`;
  const now = Date.now();
  await getPool().query(
    `INSERT INTO orders (id,order_number,tracking_token_hash,feedback_token_hash,customer_name,customer_phone,
       customer_email,fulfilment,channel,status,payment_status,payment_method,schedule_type,estimated_for,pricing_json,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,acknowledged_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'Jordan Caller','9055550177','','pickup',$5,'received','pending_at_store','pay_at_store','asap',
       $6,'{}',899,0,117,0,0,1016,$7,$6,$6)`,
    [orderId, orderNumber, `h${orderId}`, `f${orderId}`, channel, now, options.acknowledged ? now : null],
  );
  await getPool().query(
    `INSERT INTO order_items (id,order_id,product_id,product_name,variation_name,quantity,unit_price_cents,
       line_total_cents,taxable,snapshot_json,instructions,created_at)
     VALUES ($1,$2,'poutine','Poutine',NULL,1,899,899,1,'{}',NULL,$3)`,
    [uniqueId(), orderId, now],
  );
  const recipient = `kitchen+${outboxId}@example.test`;
  await getPool().query(
    `INSERT INTO notification_outbox (id,kind,recipient,payload_json,status,attempt_count,scheduled_for,created_at,updated_at)
     VALUES ($1,'restaurant_new_order',$2,$3,$4,$5,$6,$6,$6)`,
    [outboxId, recipient, JSON.stringify({ orderId, orderNumber }), options.status ?? "pending", options.attemptCount ?? 0, now],
  );
  return { orderId, outboxId, orderNumber, recipient };
}

const readRow = async (outboxId: string) =>
  (
    await getPool().query<{ status: string; attempt_count: number; payload_json: string; last_error: string | null }>(
      "SELECT status, attempt_count, payload_json, last_error FROM notification_outbox WHERE id = $1",
      [outboxId],
    )
  ).rows[0];

async function snapshotOf(orderId: string) {
  return (
    await getPool().query(
      `SELECT id, order_number, customer_name, customer_email, customer_phone, fulfilment, channel, status, payment_status,
              payment_method, schedule_type, scheduled_for, estimated_for, subtotal_cents, discount_cents, tax_cents,
              delivery_fee_cents, tip_cents, total_cents, gift_card_applied_cents, address_json, instructions,
              acknowledged_at, created_at
       FROM orders WHERE id = $1`,
      [orderId],
    )
  ).rows[0] as never;
}

// --- wording -------------------------------------------------------------------

withDb("a website order is still announced as a website order", async () => {
  const { orderId, orderNumber } = await seedAlert("online");
  const message = await renderRestaurantNewOrder(await snapshotOf(orderId));
  assert.match(message.voiceSay ?? "", /^New order from the Pizza 62 website\. Pickup order, number/);
  assert.equal(message.emailSubject, `NEW pickup order ${orderNumber} — $10.16`);
  assert.match(message.emailText, /PICKUP · WEBSITE/);
  assert.match(message.smsBody, /^Pizza 62 NEW pickup /);
});

withDb("a staff phone order is no longer announced as a website order", async () => {
  const { orderId, orderNumber } = await seedAlert("phone");
  const message = await renderRestaurantNewOrder(await snapshotOf(orderId));
  assert.match(message.voiceSay ?? "", /^New phone order\. Pickup order, number/);
  assert.doesNotMatch(message.voiceSay ?? "", /website/i);
  assert.equal(message.emailSubject, `NEW pickup order ${orderNumber} — $10.16`);
  assert.match(message.emailText, /PICKUP · PHONE/);
  assert.doesNotMatch(message.emailText, /AI PHONE/);
});

withDb("a walk-in raises no alert at all, and would be named if one were rendered", async () => {
  const schedule = {
    type: "scheduled" as const,
    scheduledFor: nextOrderSlots({
      now: Date.now(),
      hours: await getSetting("hours"),
      timeZone: "America/Toronto",
      leadMinutes: 45,
      limit: 1,
    })[0],
  };
  const order = await createOrder(
    {
      fulfilment: "pickup",
      items: [{ productId: "poutine", quantity: 1 }],
      paymentMethod: "pay_at_store",
      schedule,
      customer: { name: "Blue cap" },
      idempotencyKey: uniqueId(),
    },
    staffOrderContext("walk_in"),
  );
  const kinds = (
    await getPool().query<{ kind: string }>("SELECT kind FROM notification_outbox WHERE payload_json::jsonb->>'orderId' = $1", [order.orderId])
  ).rows.map((row) => row.kind);
  assert.ok(!kinds.includes("restaurant_new_order"));
  const { orderId } = await seedAlert("walk_in");
  const message = await renderRestaurantNewOrder(await snapshotOf(orderId));
  assert.match(message.voiceSay ?? "", /^New walk-in order\./);
  assert.match(message.emailText, /PICKUP · WALK IN/);
});

withDb("an AI phone order says AI PHONE ORDER in the call, the email and the text", async () => {
  const { orderId, orderNumber } = await seedAlert("ai_phone");
  const message = await renderRestaurantNewOrder(await snapshotOf(orderId));
  assert.match(message.voiceSay ?? "", /^New A\.I\. phone order, taken by the automated phone line\. Pickup order, number/);
  assert.equal(message.emailSubject, `AI PHONE ORDER — NEW pickup order ${orderNumber} — $10.16`);
  assert.match(message.emailText, /PICKUP · AI PHONE/);
  assert.match(message.emailHtml, /AI phone order · pickup/);
  assert.match(message.smsBody, new RegExp(`^AI PHONE ORDER ${orderNumber} · PICKUP · Jordan Caller 9055550177 · 1 item\\(s\\) · \\$10\\.16 COLLECT · `));
});

// --- the first alert and the re-calls ------------------------------------------

withDb("the first alert emails the restaurant and calls it, and never texts the landline", async () => {
  const number = alertNumber();
  process.env.RESTAURANT_ALERT_PHONE = number;
  await quietQueue();
  const { outboxId, orderId, recipient } = await seedAlert("ai_phone");
  const calls = stubProviders();
  await dispatchOutbox({ limit: 50 });
  assert.equal((await readRow(outboxId)).status, "sent");
  assert.equal(emailsTo(calls, recipient).length, 1, "one email");
  const placed = callsFor(calls, orderId);
  assert.equal(placed.length, 1, "one call");
  assert.match(spoken(placed[0]), /New A\.I\. phone order/);
  assert.equal(textsTo(calls, number).length, 0, "no text to the landline");
});

withDb("a re-call places only the call, and stops once the order is acknowledged", async () => {
  const number = alertNumber();
  process.env.RESTAURANT_ALERT_PHONE = number;
  await quietQueue();
  const { outboxId, orderId, recipient } = await seedAlert("phone");
  const calls = stubProviders();
  await dispatchOutbox({ limit: 50 });
  assert.equal(emailsTo(calls, recipient).length, 1);
  assert.equal(callsFor(calls, orderId).length, 1);

  // Nobody pressed 1. Ten minutes on, the sweep re-queues the alert.
  const later = Date.now() + 10 * 60_000;
  assert.ok((await requeueUnacknowledgedOrders(later)) >= 1);
  const queued = await readRow(outboxId);
  assert.equal(queued.status, "retrying");
  assert.equal(JSON.parse(queued.payload_json).recall, true);
  await dispatchOutbox({ limit: 50, now: later });
  assert.equal((await readRow(outboxId)).status, "sent");
  assert.equal(callsFor(calls, orderId).length, 2, "the phone rang again");
  assert.equal(emailsTo(calls, recipient).length, 1, "the email was not sent again");
  assert.equal(textsTo(calls, number).length, 0);

  // Someone presses 1 (or taps Acknowledge on the board): no further re-call.
  await getPool().query("UPDATE orders SET acknowledged_at = $1 WHERE id = $2", [Date.now(), orderId]);
  assert.equal((await readRow(outboxId)).attempt_count, 2);
  await requeueUnacknowledgedOrders(Date.now() + 20 * 60_000);
  assert.equal((await readRow(outboxId)).status, "sent", "an acknowledged order is not chased");
});

withDb("re-calls stop at the retry limit, and every one of them is voice only", async () => {
  const number = alertNumber();
  process.env.RESTAURANT_ALERT_PHONE = number;
  await quietQueue();
  const { outboxId, orderId, recipient } = await seedAlert("ai_phone");
  const calls = stubProviders();
  await dispatchOutbox({ limit: 50 });
  for (let cycle = 1; cycle <= 4; cycle += 1) {
    const later = Date.now() + cycle * 10 * 60_000;
    await requeueUnacknowledgedOrders(later);
    await dispatchOutbox({ limit: 50, now: later });
  }
  // The default limit is three calls: the first and two re-calls.
  assert.equal(callsFor(calls, orderId).length, 3);
  assert.equal(emailsTo(calls, recipient).length, 1);
  assert.equal((await readRow(outboxId)).attempt_count, 3);
});

withDb("an order acknowledged between the sweep and the re-call is not rung, and the row is not parked", async () => {
  process.env.RESTAURANT_ALERT_PHONE = alertNumber();
  await quietQueue();
  const { outboxId, orderId, recipient } = await seedAlert("ai_phone");
  const calls = stubProviders();
  await dispatchOutbox({ limit: 50 });
  const later = Date.now() + 10 * 60_000;
  await requeueUnacknowledgedOrders(later);
  await getPool().query("UPDATE orders SET acknowledged_at = $1 WHERE id = $2", [Date.now(), orderId]);
  await dispatchOutbox({ limit: 50, now: later });
  assert.equal((await readRow(outboxId)).status, "sent");
  assert.equal(callsFor(calls, orderId).length, 1, "only the first alert rang");
  assert.equal(emailsTo(calls, recipient).length, 1);
});

withDb("a call that fails after the email went out is retried as a call alone", async () => {
  const number = alertNumber();
  process.env.RESTAURANT_ALERT_PHONE = number;
  await quietQueue();
  const { outboxId, orderId, recipient } = await seedAlert("online");
  const failing = stubProviders(503);
  await dispatchOutbox({ limit: 50 });
  const failed = await readRow(outboxId);
  assert.equal(failed.status, "retrying", "a Twilio 5xx is retryable");
  assert.equal(JSON.parse(failed.payload_json).emailSent, true);
  assert.equal(emailsTo(failing, recipient).length, 1);

  const working = stubProviders(201);
  await getPool().query("UPDATE notification_outbox SET scheduled_for = $1 WHERE id = $2", [Date.now() - 1, outboxId]);
  await dispatchOutbox({ limit: 50 });
  assert.equal((await readRow(outboxId)).status, "sent");
  assert.equal(callsFor(working, orderId).length, 1, "the retry placed the call");
  assert.equal(emailsTo(working, recipient).length, 0, "and did not send the email again");
});

withDb("an AI order placed through createOrder reaches the kitchen through the existing outbox", async () => {
  const number = alertNumber();
  process.env.RESTAURANT_ALERT_PHONE = number;
  await quietQueue();
  const calls = stubProviders();
  const slot = nextOrderSlots({ now: Date.now(), hours: await getSetting("hours"), timeZone: "America/Toronto", leadMinutes: 45, limit: 1 })[0];
  const order = await createOrder(
    {
      fulfilment: "pickup",
      items: [{ productId: "poutine", quantity: 1 }],
      paymentMethod: "pay_at_store",
      schedule: { type: "scheduled", scheduledFor: slot },
      customer: { name: "Jordan Caller", phone: "905-555-0177" },
      idempotencyKey: uniqueId(),
    },
    aiPhoneOrderContext({ voiceSessionId: uniqueId() }),
  );
  const rows = (
    await getPool().query<{ id: string; kind: string }>("SELECT id, kind FROM notification_outbox WHERE payload_json::jsonb->>'orderId' = $1", [order.orderId])
  ).rows;
  assert.deepEqual(rows.map((row) => row.kind), ["restaurant_new_order"], "one alert, through the one outbox");
  // createOrder dispatches inline without waiting; make sure the row has gone.
  for (let attempt = 0; attempt < 20 && (await readRow(rows[0].id)).status !== "sent"; attempt += 1) {
    await dispatchOutbox({ limit: 50 });
  }
  assert.equal((await readRow(rows[0].id)).status, "sent");
  const placed = callsFor(calls, String(order.orderId));
  assert.equal(placed.length, 1);
  assert.match(spoken(placed[0]), /New A\.I\. phone order, taken by the automated phone line\./);
  assert.equal(textsTo(calls, number).length, 0);
});
