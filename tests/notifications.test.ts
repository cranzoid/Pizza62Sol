/**
 * The notification dispatcher and its channels (R1.4).
 *
 * This is the code the audit's central finding is about: `notification_outbox`
 * was a complete job queue with no consumer, so no customer or staff member was
 * ever told an order existed. The queue mechanics are therefore what these tests
 * are mostly about — not the wording of the messages, but whether a row can be
 * sent twice, lost, retried forever, or silently buried in `failed`.
 *
 * The concurrency test is the one that matters most. Inline dispatch fires on
 * every order while the cron sweeper runs every minute, so two workers racing for
 * the same row is the normal case, not the exotic one. Without `FOR UPDATE SKIP
 * LOCKED` both would send it and the customer would get two confirmations.
 *
 * `fetch` is stubbed throughout: no test here talks to SendGrid or Twilio.
 * Requires a reachable Postgres for the queue tests; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { dispatchOutbox, requeueUnacknowledgedOrders } = await import("@/lib/notifications/dispatcher");
const { acknowledgementTwiml, escapeXml, sendEmail, sendSms, ChannelError } = await import(
  "@/lib/notifications/channels"
);
const { twilioSignature, verifyTwilioSignature } = await import("@/app/api/notifications/voice/ack/route");

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

before(async () => {
  process.env.EMAIL_API_KEY = "test-email-key";
  process.env.EMAIL_FROM = "orders@pizza62.test";
  process.env.PUBLIC_BASE_URL = "https://pizza62.test";

  // Trap 8, in its sharpest form. `pizza62_test` is never reset, so outbox rows
  // accumulate across every run this database has ever seen. `dispatchOutbox`
  // claims across the whole table ordered by `scheduled_for` and takes at most
  // `limit` rows — so once the backlog of old claimable rows exceeds the limit, a
  // test's own freshly-seeded row (scheduled *now*, therefore last) is never
  // claimed, and the assertion fails for a reason that has nothing to do with the
  // code under test.
  //
  // Asserting on your own row by id is not enough on its own: claiming is a
  // shared, bounded resource. So the queue is emptied of everything this run did
  // not create. `cancelled` rather than `DELETE` because the outbox has foreign
  // keys into orders now, and because leaving the rows visible keeps the history
  // inspectable when a test does fail.
  //
  // This became load-bearing when the dispatcher started releasing
  // `pending_provider_setup` rows: hundreds of rows parked by earlier runs all
  // became claimable at once.
  if (reachable) {
    await getPool().query(
      "UPDATE notification_outbox SET status = 'cancelled', updated_at = $1 WHERE status IN ('pending', 'retrying', 'sending', 'pending_provider_setup')",
      [Date.now()],
    );
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records every outbound provider call and replies with `status`. */
function stubProviders(status = 202): { calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(status === 202 ? "" : JSON.stringify({ message: "provider said no" }), {
      status,
      headers: { "content-type": "application/json", "x-message-id": "msg-123" },
    });
  }) as typeof fetch;
  return { calls };
}

let seq = 0;
const uniqueId = () => `test-${Date.now()}-${(seq += 1)}-${crypto.randomUUID()}`;
// orders.order_number is UNIQUE and these rows persist between runs, so the
// number has to be unique per run as well as per test — a counter that restarts
// at the same value every run collides on the second `npm test`.
const RUN = crypto.randomUUID().slice(0, 8);

/** Inserts a real order plus one outbox row of the given kind and status. */
async function seedOutbox(options: {
  kind: string;
  status: string;
  scheduledFor?: number;
  attemptCount?: number;
  orderStatus?: string;
  acknowledged?: boolean;
  payloadExtra?: Record<string, unknown>;
  /** Written to the single order item, so a message can be asserted on its detail. */
  itemSnapshot?: Record<string, unknown>;
}): Promise<{ orderId: string; outboxId: string; orderNumber: string; recipient: string }> {
  const orderId = uniqueId();
  const outboxId = uniqueId();
  const orderNumber = `P62-T${RUN}-${(seq += 1)}`;
  const now = Date.now();
  await getPool().query(
    `INSERT INTO orders (id,order_number,tracking_token_hash,feedback_token_hash,customer_name,customer_phone,
       customer_email,fulfilment,status,payment_status,payment_method,schedule_type,estimated_for,pricing_json,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,acknowledged_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'Ada Lovelace','9055550142','ada@example.test','pickup',$5,'paid','online','asap',
       $6,'{}',899,0,117,0,0,1016,$7,$6,$6)`,
    [orderId, orderNumber, `h${orderId}`, `f${orderId}`, options.orderStatus ?? "received", now,
     options.acknowledged ? now : null],
  );
  await getPool().query(
    `INSERT INTO order_items (id,order_id,product_id,product_name,variation_name,quantity,unit_price_cents,
       line_total_cents,taxable,snapshot_json,instructions,created_at)
     VALUES ($1,$2,'poutine','Poutine',NULL,1,899,899,1,$4,NULL,$3)`,
    [uniqueId(), orderId, now, JSON.stringify(options.itemSnapshot ?? {})],
  );
  // Trap 8: a unique recipient per row. Test files run as separate processes and
  // share one database, so `dispatchOutbox` routinely claims rows another file
  // seeded — and `globalThis.fetch` is stubbed process-wide, so those deliveries
  // land in this file's call log too. Asserting "nothing was sent" on the total
  // call count therefore fails for reasons unrelated to the code under test.
  // Addressing each row uniquely makes every such assertion answerable about
  // *this* row.
  const recipient = `ada+${outboxId}@example.test`;
  await getPool().query(
    `INSERT INTO notification_outbox (id,kind,recipient,payload_json,status,attempt_count,scheduled_for,created_at,updated_at)
     VALUES ($1,$2,$8,$3,$4,$5,$6,$7,$7)`,
    [outboxId, options.kind,
     JSON.stringify({ orderId, orderNumber, trackingToken: "tok-" + orderId, ...options.payloadExtra }),
     options.status, options.attemptCount ?? 0, options.scheduledFor ?? now, now, recipient],
  );
  return { orderId, outboxId, orderNumber, recipient };
}

const readRow = async (outboxId: string) =>
  (
    await getPool().query<{ status: string; attempt_count: number; payload_json: string; last_error: string | null; sent_at: number | null }>(
      "SELECT status, attempt_count, payload_json, last_error, sent_at FROM notification_outbox WHERE id = $1",
      [outboxId],
    )
  ).rows[0];

// --- channels, offline ------------------------------------------------------

test("escapes XML so a customer name cannot inject TwiML", () => {
  // The spoken text is interpolated into an XML document. An order note or name
  // containing markup would otherwise change the call's instructions.
  assert.equal(escapeXml(`</Say><Hangup/>`), "&lt;/Say&gt;&lt;Hangup/&gt;");
});

test("builds a gather that asks for one key and posts back", () => {
  const twiml = acknowledgementTwiml("New order.", "https://pizza62.test/api/notifications/voice/ack?order=abc");
  assert.match(twiml, /<Gather numDigits="1"[^>]*method="POST"/);
  assert.match(twiml, /action="https:\/\/pizza62\.test\/api\/notifications\/voice\/ack\?order=abc"/);
  // The message is said before the gather as well as inside it, and there is a
  // trailing Say for the no-keypress case — that path is what leaves the order
  // unacknowledged and triggers the next call.
  assert.match(twiml, /We will call again shortly/);
});

test("treats a provider 5xx as retryable and a 4xx as permanent", async () => {
  stubProviders(503);
  await assert.rejects(
    () => sendEmail({ to: "a@b.test", subject: "s", text: "t" }),
    (error: unknown) => error instanceof ChannelError && error.retryable,
  );
  stubProviders(400);
  await assert.rejects(
    () => sendEmail({ to: "a@b.test", subject: "s", text: "t" }),
    (error: unknown) => error instanceof ChannelError && !error.retryable,
  );
});

test("treats 429 as retryable even though it is a 4xx", async () => {
  // "Not now" is not "not ever" — the one 4xx worth trying again.
  stubProviders(429);
  await assert.rejects(
    () => sendEmail({ to: "a@b.test", subject: "s", text: "t" }),
    (error: unknown) => error instanceof ChannelError && error.retryable,
  );
});

test("sends SMS as form-encoded To/From/Body", async () => {
  process.env.TWILIO_ACCOUNT_SID = "AC-test";
  process.env.TWILIO_AUTH_TOKEN = "token";
  process.env.TWILIO_FROM_NUMBER = "+15550000000";
  const { calls } = stubProviders(201);
  await sendSms({ to: "+15551111111", body: "hello" });
  const form = new URLSearchParams(calls[0].body);
  assert.match(calls[0].url, /Accounts\/AC-test\/Messages\.json$/);
  assert.equal(form.get("To"), "+15551111111");
  assert.equal(form.get("From"), "+15550000000");
  assert.equal(form.get("Body"), "hello");
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_FROM_NUMBER;
});

// --- Twilio webhook signature ----------------------------------------------

test("accepts Twilio's documented signature and rejects a tampered one", () => {
  const url = "https://pizza62.test/api/notifications/voice/ack?order=abc";
  const params = { Digits: "1", CallSid: "CA123" };
  const signature = twilioSignature("auth-token", url, params);

  assert.equal(verifyTwilioSignature("auth-token", url, params, signature), true);
  // Each of these is a way in that must stay closed: without the check, anyone
  // who guessed the URL could silence the escalation calls for an order the
  // kitchen has never seen.
  assert.equal(verifyTwilioSignature("auth-token", url, { ...params, Digits: "9" }, signature), false);
  assert.equal(verifyTwilioSignature("wrong-token", url, params, signature), false);
  assert.equal(verifyTwilioSignature("auth-token", `${url}&extra=1`, params, signature), false);
  assert.equal(verifyTwilioSignature("auth-token", url, params, null), false);
});

test("signs parameters in sorted order regardless of how they arrive", () => {
  const url = "https://pizza62.test/x";
  assert.equal(
    twilioSignature("t", url, { b: "2", a: "1" }),
    twilioSignature("t", url, { a: "1", b: "2" }),
  );
});

// --- the queue --------------------------------------------------------------

withDb("sends a due row and records it as sent", async () => {
  const { outboxId } = await seedOutbox({ kind: "customer_order_confirmation", status: "pending" });
  const { calls } = stubProviders();

  const outcome = await dispatchOutbox({ limit: 50 });
  assert.ok(outcome.sent >= 1);
  // Resend is the default provider (see channels.ts) — SendGrid no longer has
  // a free tier, and one restaurant fits inside Resend's.
  assert.ok(calls.some((call) => call.url.includes("api.resend.com")));

  const row = await readRow(outboxId);
  assert.equal(row.status, "sent");
  assert.ok(row.sent_at);
});

withDb("scrubs the tracking token from the payload once sent", async () => {
  // The token is in the payload because `orders` keeps only its hash and the
  // dispatcher cannot reconstruct it. Once the message is gone there is no
  // reason for a credential that grants access to the order to stay in the queue.
  const { outboxId } = await seedOutbox({ kind: "customer_order_confirmation", status: "pending" });
  stubProviders();
  await dispatchOutbox({ limit: 50 });

  const row = await readRow(outboxId);
  assert.ok(!row.payload_json.includes("tok-"), `token survived: ${row.payload_json}`);
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  assert.equal(payload.redacted, true);
  // Still enough to answer "did this order get its confirmation?".
  assert.ok(payload.orderId);
});

withDb("does not claim a row scheduled for the future", async () => {
  const { outboxId } = await seedOutbox({
    kind: "customer_order_confirmation",
    status: "pending",
    scheduledFor: Date.now() + 60 * 60 * 1000,
  });
  stubProviders();
  await dispatchOutbox({ limit: 50 });
  assert.equal((await readRow(outboxId)).status, "pending");
});

withDb("does not claim terminal or still-parked rows", async () => {
  // `cancelled` and `waiting_payment` are invisible to the dispatcher whatever
  // is configured: a cancelled order's confirmation must never go out later, and
  // an unpaid order must not be confirmed before Clover approves it.
  //
  // `pending_provider_setup` is deliberately NOT asserted here any more. It is
  // conditional rather than terminal: parked while nothing can deliver, released
  // the moment something can. Both halves of that are covered by their own tests
  // below — asserting it stays parked in a test that configures a provider was
  // asserting the failsafe stays broken.
  const cancelled = await seedOutbox({ kind: "customer_order_confirmation", status: "cancelled" });
  const waiting = await seedOutbox({ kind: "customer_order_confirmation", status: "waiting_payment" });
  stubProviders();
  await dispatchOutbox({ limit: 50 });

  assert.equal((await readRow(cancelled.outboxId)).status, "cancelled");
  assert.equal((await readRow(waiting.outboxId)).status, "waiting_payment");
});

withDb("retries a transient failure with backoff instead of failing it", async () => {
  const { outboxId } = await seedOutbox({ kind: "customer_order_confirmation", status: "pending" });
  stubProviders(503);
  await dispatchOutbox({ limit: 50 });

  const row = await readRow(outboxId);
  assert.equal(row.status, "retrying");
  assert.equal(row.attempt_count, 1);
  assert.match(row.last_error ?? "", /503/);
});

withDb("gives up after the attempt budget rather than retrying forever", async () => {
  const { outboxId } = await seedOutbox({
    kind: "customer_order_confirmation",
    status: "retrying",
    attemptCount: 5,
  });
  stubProviders(503);
  await dispatchOutbox({ limit: 50 });
  assert.equal((await readRow(outboxId)).status, "failed");
});

withDb("fails a permanently-broken row immediately, without spending six attempts", async () => {
  // A 400 will never become a 200. Retrying it is six guaranteed failures that
  // delay every message queued behind it.
  const { outboxId } = await seedOutbox({ kind: "customer_order_confirmation", status: "pending" });
  stubProviders(400);
  await dispatchOutbox({ limit: 50 });

  const row = await readRow(outboxId);
  assert.equal(row.status, "failed");
  assert.equal(row.attempt_count, 1);
});

withDb("fails an unknown kind rather than retrying it", async () => {
  const { outboxId } = await seedOutbox({ kind: "not_a_real_kind", status: "pending" });
  stubProviders();
  await dispatchOutbox({ limit: 50 });
  assert.equal((await readRow(outboxId)).status, "failed");
});

withDb("never confirms an order that was cancelled while queued", async () => {
  const { outboxId, recipient } = await seedOutbox({
    kind: "customer_order_confirmation",
    status: "pending",
    orderStatus: "cancelled",
  });
  const { calls } = stubProviders();
  await dispatchOutbox({ limit: 50 });

  assert.equal((await readRow(outboxId)).status, "failed");
  assert.equal(
    calls.filter((call) => call.body.includes(recipient)).length,
    0,
    "nothing should have been sent to this order's customer",
  );
});

withDb("does not ask for feedback on an order that never completed", async () => {
  const { outboxId, recipient } = await seedOutbox({
    kind: "feedback_request",
    status: "pending",
    orderStatus: "preparing",
  });
  const { calls } = stubProviders();
  await dispatchOutbox({ limit: 50 });
  assert.equal((await readRow(outboxId)).status, "failed");
  assert.equal(calls.filter((call) => call.body.includes(recipient)).length, 0);
});

withDb("sends exactly one message when two dispatchers race for one row", async () => {
  // The regression this guards is the expensive one. Inline dispatch fires on
  // every order while the cron sweeper runs every minute, so this race is the
  // normal case. Two workers that merely SELECTed the pending row would both
  // send it; FOR UPDATE SKIP LOCKED means the second never sees it.
  const { outboxId } = await seedOutbox({ kind: "customer_order_confirmation", status: "pending" });
  const { calls } = stubProviders();

  const outcomes = await Promise.all([
    dispatchOutbox({ limit: 50 }),
    dispatchOutbox({ limit: 50 }),
    dispatchOutbox({ limit: 50 }),
  ]);

  const sendsForThisRow = calls.filter((call) => call.url.includes("api.resend.com"));
  assert.equal((await readRow(outboxId)).status, "sent");
  // Other rows from other tests may be in flight, so assert on the total claimed
  // count rather than on this row alone being the only send.
  const claimedTwice = outcomes.filter((outcome) => outcome.claimed > 0).length;
  assert.ok(sendsForThisRow.length >= 1);
  assert.ok(claimedTwice >= 1);
  assert.equal((await readRow(outboxId)).attempt_count, 1, "the row must be attempted exactly once");
});

withDb("reclaims a row abandoned mid-delivery by a worker that died", async () => {
  // `sending` means a worker claimed it and is delivering. If that worker dies —
  // a replica restart, an OOM, a deploy rolling the revision — nothing else would
  // ever look at the row again and the customer's confirmation would be stranded
  // permanently. That is the exact failure this release exists to eliminate.
  const { outboxId } = await seedOutbox({ kind: "customer_order_confirmation", status: "sending" });
  await getPool().query("UPDATE notification_outbox SET updated_at = $1 WHERE id = $2", [
    Date.now() - 10 * 60_000,
    outboxId,
  ]);
  stubProviders();

  await dispatchOutbox({ limit: 50 });
  assert.equal((await readRow(outboxId)).status, "sent");
});

withDb("leaves a freshly-claimed row alone", async () => {
  // The other half of the same guard: a row someone is actively delivering must
  // not be snatched away, or the message goes out twice.
  const { outboxId } = await seedOutbox({ kind: "customer_order_confirmation", status: "sending" });
  stubProviders();
  await dispatchOutbox({ limit: 50 });
  assert.equal((await readRow(outboxId)).status, "sending");
});

withDb("claims nothing when no provider is configured", async () => {
  const previous = { key: process.env.EMAIL_API_KEY, from: process.env.EMAIL_FROM };
  delete process.env.EMAIL_API_KEY;
  delete process.env.EMAIL_FROM;
  try {
    const { outboxId } = await seedOutbox({ kind: "customer_order_confirmation", status: "pending" });
    const outcome = await dispatchOutbox({ limit: 50 });
    assert.equal(outcome.claimed, 0);
    // Left pending, not failed: a deployment mid-setup must not burn every row's
    // retry budget and bury real notifications in `failed`.
    assert.equal((await readRow(outboxId)).status, "pending");
  } finally {
    if (previous.key) process.env.EMAIL_API_KEY = previous.key;
    if (previous.from) process.env.EMAIL_FROM = previous.from;
  }
});

// --- the unacknowledged-order sweep -----------------------------------------

withDb("re-queues a sent alert for an order nobody acknowledged", async () => {
  process.env.RESTAURANT_ALERT_PHONE = "+15559990000";
  try {
    const { outboxId } = await seedOutbox({
      kind: "restaurant_new_order",
      status: "sent",
      attemptCount: 1,
      orderStatus: "received",
      acknowledged: false,
    });
    // Ten minutes on, so the row is comfortably past the re-call interval.
    await requeueUnacknowledgedOrders(Date.now() + 10 * 60 * 1000);
    assert.equal((await readRow(outboxId)).status, "retrying");
  } finally {
    delete process.env.RESTAURANT_ALERT_PHONE;
  }
});

withDb("stops calling once someone has acknowledged the order", async () => {
  // acknowledged_at is the same field the Acknowledge button on the kitchen
  // screen writes, so tapping it is what stops the phone ringing.
  process.env.RESTAURANT_ALERT_PHONE = "+15559990000";
  try {
    const { outboxId } = await seedOutbox({
      kind: "restaurant_new_order",
      status: "sent",
      attemptCount: 1,
      acknowledged: true,
    });
    await requeueUnacknowledgedOrders(Date.now() + 10 * 60 * 1000);
    assert.equal((await readRow(outboxId)).status, "sent");
  } finally {
    delete process.env.RESTAURANT_ALERT_PHONE;
  }
});

withDb("stops calling after the retry limit", async () => {
  process.env.RESTAURANT_ALERT_PHONE = "+15559990000";
  try {
    const { outboxId } = await seedOutbox({
      kind: "restaurant_new_order",
      status: "sent",
      attemptCount: 3,
      acknowledged: false,
    });
    await requeueUnacknowledgedOrders(Date.now() + 10 * 60 * 1000);
    assert.equal((await readRow(outboxId)).status, "sent", "three attempts is the default ceiling");
  } finally {
    delete process.env.RESTAURANT_ALERT_PHONE;
  }
});

withDb("does not chase a cancelled or completed order", async () => {
  process.env.RESTAURANT_ALERT_PHONE = "+15559990000";
  try {
    const cancelled = await seedOutbox({
      kind: "restaurant_new_order", status: "sent", attemptCount: 1, orderStatus: "cancelled",
    });
    const completed = await seedOutbox({
      kind: "restaurant_new_order", status: "sent", attemptCount: 1, orderStatus: "completed",
    });
    await requeueUnacknowledgedOrders(Date.now() + 10 * 60 * 1000);
    assert.equal((await readRow(cancelled.outboxId)).status, "sent");
    assert.equal((await readRow(completed.outboxId)).status, "sent");
  } finally {
    delete process.env.RESTAURANT_ALERT_PHONE;
  }
});

withDb("releases rows parked for missing credentials once a provider exists", async () => {
  // The failsafe the whole staged rollout depends on: take sample orders now,
  // add Twilio and email afterwards, and the queued notifications go out.
  //
  // `pending_provider_setup` is deliberately not claimable — that is what stops
  // a credential-less deployment burning every row's retries. But nothing moved
  // rows back out of it, so every notification queued before the credentials
  // arrived stayed invisible forever: the exact silence this release exists to
  // eliminate, at the one moment it is most likely to happen.
  const { outboxId } = await seedOutbox({
    kind: "customer_order_confirmation",
    status: "pending_provider_setup",
  });
  // Parking never spends an attempt, so the row must still have its full budget.
  await getPool().query("UPDATE notification_outbox SET attempt_count = 0 WHERE id = $1", [outboxId]);

  const { calls } = stubProviders();
  const outcome = await dispatchOutbox({ limit: 50 });

  assert.ok(outcome.released >= 1, "the parked row should have been released");
  assert.equal((await readRow(outboxId)).status, "sent");
  assert.ok(calls.some((call) => call.url.includes("api.resend.com")));
  // Released, not retried: the row is delivered on its first real attempt.
  assert.equal(Number((await readRow(outboxId)).attempt_count), 1);
});

withDb("leaves parked rows alone while no provider is configured", async () => {
  const previous = { key: process.env.EMAIL_API_KEY, from: process.env.EMAIL_FROM };
  delete process.env.EMAIL_API_KEY;
  delete process.env.EMAIL_FROM;
  try {
    const { outboxId } = await seedOutbox({
      kind: "customer_order_confirmation",
      status: "pending_provider_setup",
    });
    const outcome = await dispatchOutbox({ limit: 50 });
    assert.equal(outcome.released, 0, "nothing may be released while nothing can deliver");
    assert.equal((await readRow(outboxId)).status, "pending_provider_setup");
  } finally {
    if (previous.key) process.env.EMAIL_API_KEY = previous.key;
    if (previous.from) process.env.EMAIL_FROM = previous.from;
  }
});

// --- what the messages actually say -----------------------------------------
//
// These are not wording tests. Each one is about a specific way a customer or a
// kitchen ends up with the wrong information: an order described only by its
// product name, a half-and-half whose sides are lost, an email that arrives as
// unstyled text, a "ready for pickup" that reaches someone who already left.

withDb("describes every choice the customer made, not just the product name", async () => {
  // The whole point of the R1 email work: "1 x Poutine" is not a description of
  // an order anyone can check. Placement, omissions and modifier groups all have
  // to survive the trip from `snapshot_json` to the inbox.
  const { outboxId, recipient } = await seedOutbox({
    kind: "customer_order_confirmation",
    status: "pending",
    itemSnapshot: {
      halal: true,
      extraCheese: true,
      recipeOmissions: ["Green pepper"],
      toppings: [
        { toppingId: "pepperoni", placement: "whole" },
        { toppingId: "mushroom", placement: "left" },
        { toppingId: "onion", placement: "right" },
      ],
      modifiers: [{ id: "crust", label: "Crust", values: [{ value: "Thin", label: "Thin" }] }],
    },
  });
  const { calls } = stubProviders();
  await dispatchOutbox({ limit: 50 });
  assert.equal((await readRow(outboxId)).status, "sent");

  const sent = calls.find((call) => call.url.includes("api.resend.com") && call.body.includes(recipient));
  assert.ok(sent, "the confirmation should have been sent to this row's own address");
  const payload = JSON.parse(sent.body) as { text: string; html: string };

  // Grouped by side rather than suffixed per topping — a kitchen reading
  // "(L)" off a list at 9pm is a kitchen making the wrong pizza.
  //
  // Case-insensitive because the id is only a fallback: a topping that exists in
  // the `toppings` table comes back under its display name ("Pepperoni"), and
  // one that does not falls back to the raw id. Both paths matter, and asserting
  // on the casing would be asserting on which of the two the fixture happened to
  // seed.
  assert.match(payload.text, /Left half: mushroom/i);
  assert.match(payload.text, /Right half: onion/i);
  assert.match(payload.text, /Toppings: pepperoni/i);
  assert.match(payload.text, /Crust: Thin/);
  // Preparation-critical flags, including what was deliberately left off (H-03).
  assert.match(payload.text, /Halal/);
  assert.match(payload.text, /Extra cheese/);
  assert.match(payload.text, /No Green pepper/);
  // And the same facts in the HTML part, so the two cannot describe
  // different orders.
  assert.match(payload.html, /Left half/);
  assert.match(payload.html, /No Green pepper/);
});

withDb("sends a designed HTML part alongside the plain text", async () => {
  const { recipient } = await seedOutbox({ kind: "customer_order_confirmation", status: "pending" });
  const { calls } = stubProviders();
  await dispatchOutbox({ limit: 50 });

  const sent = calls.find((call) => call.url.includes("api.resend.com") && call.body.includes(recipient));
  assert.ok(sent);
  const payload = JSON.parse(sent.body) as { text: string; html?: string };
  // Both parts, always. HTML alone scores worse with every spam filter and is
  // not what a client in text mode shows.
  assert.ok(payload.text.length > 0, "the text part must never be dropped");
  assert.ok(payload.html, "the HTML part is the whole point of the redesign");
  assert.match(payload.html, /<!DOCTYPE html/i);
  // The brand green masthead — proof the shell was applied, not just a string.
  assert.match(payload.html, /#244b39/);
});

withDb("escapes markup in customer-supplied text rather than rendering it", async () => {
  // Names and notes are customer input at one remove. An apostrophe in "Rob's
  // usual" must not close an attribute, and a tag must not become markup.
  const orderId = uniqueId();
  const outboxId = uniqueId();
  const now = Date.now();
  await getPool().query(
    `INSERT INTO orders (id,order_number,tracking_token_hash,feedback_token_hash,customer_name,customer_phone,
       customer_email,fulfilment,status,payment_status,payment_method,schedule_type,estimated_for,pricing_json,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'9055550142','ada@example.test','pickup','received','paid','online','asap',
       $6,'{}',899,0,117,0,0,1016,$6,$6)`,
    [orderId, `P62-T${RUN}-${(seq += 1)}`, `h${orderId}`, `f${orderId}`, "<script>alert(1)</script>", now],
  );
  await getPool().query(
    `INSERT INTO order_items (id,order_id,product_id,product_name,variation_name,quantity,unit_price_cents,
       line_total_cents,taxable,snapshot_json,instructions,created_at)
     VALUES ($1,$2,'poutine','Poutine',NULL,1,899,899,1,'{}',NULL,$3)`,
    [uniqueId(), orderId, now],
  );
  const recipient = `ada+${outboxId}@example.test`;
  await getPool().query(
    `INSERT INTO notification_outbox (id,kind,recipient,payload_json,status,attempt_count,scheduled_for,created_at,updated_at)
     VALUES ($1,'customer_order_confirmation',$2,$3,'pending',0,$4,$4,$4)`,
    [outboxId, recipient, JSON.stringify({ orderId, trackingToken: "tok" }), now],
  );

  const { calls } = stubProviders();
  await dispatchOutbox({ limit: 50 });
  const sent = calls.find((call) => call.url.includes("api.resend.com") && call.body.includes(recipient));
  assert.ok(sent);
  const html = (JSON.parse(sent.body) as { html: string }).html;
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw markup reached the document");
  assert.match(html, /&lt;script&gt;/);
});

withDb("tells the customer their order is ready, using the status it was queued with", async () => {
  // The queued status, not the live one. A retry that runs after the kitchen has
  // moved the order on again must still send the message for the step it passed
  // through, or "ready for pickup" arrives after the bag has been collected.
  const { outboxId, recipient } = await seedOutbox({
    kind: "customer_status_update",
    status: "pending",
    orderStatus: "completed",
    payloadExtra: { status: "ready_for_pickup" },
  });
  const { calls } = stubProviders();
  await dispatchOutbox({ limit: 50 });

  assert.equal((await readRow(outboxId)).status, "sent");
  const sent = calls.find((call) => call.url.includes("api.resend.com") && call.body.includes(recipient));
  assert.ok(sent);
  const payload = JSON.parse(sent.body) as { subject: string; text: string; html: string };
  assert.match(payload.subject, /ready for pickup/i);
  assert.match(payload.text, /Ready for pickup/i);
  assert.match(payload.html, /Ready for pickup/i);
});

withDb("fails a status update it has no wording for instead of retrying it forever", async () => {
  const { outboxId } = await seedOutbox({
    kind: "customer_status_update",
    status: "pending",
    payloadExtra: { status: "received" },
  });
  stubProviders();
  await dispatchOutbox({ limit: 50 });
  // `received` is what the confirmation already said; there is no second message
  // for it, and retrying a renderer that will throw identically is six wasted
  // attempts delaying every real message behind it.
  const row = await readRow(outboxId);
  assert.equal(row.status, "failed");
  assert.match(row.last_error ?? "", /no customer copy/);
});

withDb("never tells a cancelled order's customer that it is on its way", async () => {
  const { outboxId } = await seedOutbox({
    kind: "customer_status_update",
    status: "pending",
    orderStatus: "cancelled",
    payloadExtra: { status: "out_for_delivery" },
  });
  stubProviders();
  await dispatchOutbox({ limit: 50 });
  assert.equal((await readRow(outboxId)).status, "failed");
});

// --- the feedback thank-you --------------------------------------------------

/**
 * The coupon is looked up at send time, not carried in the payload.
 *
 * That is the property worth a test: it is what makes the code in the email and
 * the discount at the till the same fact rather than two copies of one. An owner
 * who changes their mind between the customer pressing Send and the queue
 * draining changes the email too — and if they switch the offer off entirely,
 * the row waits rather than posting a code the checkout would refuse.
 */
withDb("emails the thank-you code, quoting the promotion as it stands at send time", async () => {
  const { outboxId, recipient } = await seedOutbox({ kind: "feedback_reward", status: "pending" });
  const { calls } = stubProviders();
  await getPool().query("UPDATE promotions SET amount = 450 WHERE id = 'feedback-thank-you'");
  try {
    await dispatchOutbox({ limit: 50 });
    assert.equal((await readRow(outboxId)).status, "sent");
    const sent = calls.find((call) => call.body.includes(recipient));
    assert.ok(sent, "the coupon must reach the customer who left the feedback");
    assert.match(sent.body, /THANKS62/, "the code has to be in the message");
    assert.match(sent.body, /4\.50/, "the value must come from the promotion, not a stored copy");
  } finally {
    await getPool().query("UPDATE promotions SET amount = 399 WHERE id = 'feedback-thank-you'");
  }
});

withDb("parks the thank-you rather than mailing a code that no longer works", async () => {
  const { outboxId } = await seedOutbox({ kind: "feedback_reward", status: "pending" });
  stubProviders();
  await getPool().query("UPDATE promotions SET active = 0 WHERE id = 'feedback-thank-you'");
  try {
    await dispatchOutbox({ limit: 50 });
    const row = await readRow(outboxId);
    // Parked, not failed: the owner has almost certainly paused the offer for a
    // week, and `failed` is a status nobody comes back to.
    assert.equal(row.status, "pending_provider_setup");
    assert.equal(row.attempt_count, 0, "waiting on the owner is not an attempt");
  } finally {
    await getPool().query("UPDATE promotions SET active = 1 WHERE id = 'feedback-thank-you'");
  }
});
