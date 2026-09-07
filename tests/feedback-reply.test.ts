/**
 * Replying to feedback.
 *
 * Until now the feedback inbox was one-way: a customer answered the questions,
 * the owner ticked "handled" and wrote a note only the office would ever read,
 * and the person who took the trouble to write heard nothing back. These tests
 * cover the path that closes that loop, and the three ways it must not fail.
 *
 * **The customer's own words go with it.** A reply that arrives days later
 * saying "sorry about that" with no antecedent cannot be understood, so the
 * rating and what they wrote are quoted back inside the mail.
 *
 * **A reply is queued, never sent inline.** The provider is the least reliable
 * thing in the request; the outbox already retries, backs off and parks. What
 * the API must guarantee is that the words are durable before it answers.
 *
 * **The record outlives the queue.** The dispatcher scrubs a payload once it is
 * delivered, so "what did we say to this person" is only answerable later
 * because the reply is written onto the feedback row as well.
 *
 * `fetch` is stubbed throughout: nothing here talks to a real provider.
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { createPasswordHash } = await import("@/lib/auth");
const { getSetting } = await import("@/db/runtime");
const { dispatchOutbox } = await import("@/lib/notifications/dispatcher");
const { POST: loginRoute } = await import("@/app/api/auth/login/route");
const { POST: recordsWrite, GET: recordsRead } = await import("@/app/api/admin/records/route");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const RUN = crypto.randomUUID().slice(0, 8);
let counter = 0;
const nextClientIp = () => `198.51.100.${(counter += 1) % 250}-${RUN}`;
const PASSWORD = "Correct Horse Battery Staple 62";

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; body: string }> = [];

before(async () => {
  process.env.EMAIL_API_KEY = "test-email-key";
  process.env.EMAIL_FROM = "orders@pizza62.test";
  process.env.PUBLIC_BASE_URL = "https://pizza62.test";
  // The test database is never reset, so claimable rows accumulate across every
  // run it has ever seen. `dispatchOutbox` claims across the whole table in
  // schedule order and takes at most `limit` of them, so a backlog would starve
  // the row a test just wrote. Cancelled rather than deleted: the outbox has
  // foreign keys into orders, and the history stays inspectable.
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

/** Records every outbound provider call and accepts it. */
function stubProviders(): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response("", { status: 202, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

async function signedInAs(role: "owner" | "employee", permissions: string[] = []): Promise<string> {
  const id = crypto.randomUUID();
  const email = `reply-${id}@example.test`;
  const hash = await createPasswordHash(PASSWORD);
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_users (id,email,name,role,password_hash,password_salt,password_iterations,permissions_json,active,created_at,updated_at)
     VALUES ($1,$2,'Reply Tester',$3,$4,$5,$6,$7,1,$8,$8)`,
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

/** One completed order with one piece of feedback against it. */
/** `email: ""` is how a counter or phone order with no address is stored — the
    column is NOT NULL, so "no email" is the empty string, not a null. */
async function seedFeedback(options: { email?: string; rating?: number; wrote?: string } = {}) {
  const orderId = `reply-${RUN}-${(counter += 1)}-${crypto.randomUUID()}`;
  const feedbackId = crypto.randomUUID();
  const orderNumber = `P62-R${RUN}-${counter}`;
  const email = options.email === undefined ? `grace+${orderId}@example.test` : options.email;
  const now = Date.now();
  await getPool().query(
    `INSERT INTO orders (id,order_number,tracking_token_hash,feedback_token_hash,customer_name,customer_phone,
       customer_email,fulfilment,status,payment_status,payment_method,schedule_type,estimated_for,pricing_json,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'Grace Hopper','9055550188',$5,'pickup','completed','paid','online','asap',
       $6,'{}',899,0,117,0,0,1016,$6,$6)`,
    [orderId, orderNumber, `h${orderId}`, `f${orderId}`, email, now],
  );
  await getPool().query(
    `INSERT INTO feedback_responses (id,order_id,overall_rating,answers_json,written_feedback,submitted_at)
     VALUES ($1,$2,$3,'{}',$4,$5)`,
    [feedbackId, orderId, options.rating ?? 2, options.wrote ?? "The pizza was stone cold when it arrived.", now],
  );
  return { orderId, feedbackId, orderNumber, email };
}

function post(cookie: string, body: unknown): Promise<Response> {
  return recordsWrite(
    new Request("https://order.pizza62.test/api/admin/records", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-azure-clientip": nextClientIp() },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * Waits for the row to leave the queue, whichever dispatcher gets to it first.
 *
 * Found by recipient rather than by anything in the payload: `markSent` scrubs a
 * delivered payload, so the row this is watching stops matching its own contents
 * at the exact moment the test is waiting for.
 */
async function settled(recipient: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await dispatchOutbox({ limit: 25 });
    const row = await getPool().query<Record<string, unknown>>(
      "SELECT status, recipient, last_error FROM notification_outbox WHERE kind = 'feedback_reply' AND recipient = $1",
      [recipient],
    );
    if (row.rows[0] && row.rows[0].status !== "sending") return row.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the reply never left the queue");
}

withDb("emails the customer what a member of staff wrote back, quoting what they said", async () => {
  stubProviders();
  const cookie = await signedInAs("owner");
  const { feedbackId, orderNumber, email } = await seedFeedback({
    rating: 2,
    wrote: "The pizza was stone cold when it arrived.",
  });

  const response = await post(cookie, {
    action: "feedback.reply",
    id: feedbackId,
    message: "We are sorry — that is not how it should reach you.\nYour next order is on us.",
  });
  assert.equal(response.status, 200);

  const queued = await settled(email);
  assert.equal(queued.status, "sent", String(queued.last_error ?? ""));
  const sent = calls.find((call) => call.body.includes(email));
  assert.ok(sent, "the reply must reach the customer who wrote in");
  assert.match(sent.body, /that is not how it should reach you/, "our words have to be in it");
  assert.match(sent.body, /stone cold/, "and theirs, so the reply can be understood on its own");
  assert.ok(sent.body.includes(orderNumber), "the order it is about has to be named");

  // Reply-To, not the sending domain: a message that says "just reply to this"
  // and then bounces the answer is worse than not writing at all.
  const business = await getSetting<{ email?: string }>("business");
  if (business.email) assert.ok(sent.body.includes('"reply_to"'), "a reply must be answerable");

  const row = await getPool().query<{ reply_message: string; replied_at: string; reviewed_at: string }>(
    "SELECT reply_message, replied_at, reviewed_at FROM feedback_responses WHERE id = $1",
    [feedbackId],
  );
  // The queue scrubs itself once delivered, so this row is the only lasting
  // record of what the customer was told.
  assert.match(row.rows[0].reply_message, /Your next order is on us/);
  assert.ok(Number(row.rows[0].replied_at) > 0);
  // Answering the customer is handling the feedback. Leaving it in the
  // unhandled count afterwards teaches everyone to ignore the count.
  assert.ok(Number(row.rows[0].reviewed_at) > 0, "replying marks the feedback handled");
});

withDb("says so plainly when the order has no email address to reply to", async () => {
  stubProviders();
  const cookie = await signedInAs("owner");
  const { feedbackId } = await seedFeedback({ email: "" });

  const response = await post(cookie, { action: "feedback.reply", id: feedbackId, message: "Thank you." });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /nowhere to send/);

  const queued = await getPool().query(
    "SELECT id FROM notification_outbox WHERE kind = 'feedback_reply' AND payload_json LIKE $1",
    [`%${feedbackId}%`],
  );
  assert.equal(queued.rows.length, 0, "nothing may be queued with no address on it");
  assert.equal(calls.length, 0, "and nothing may be sent");
});

withDb("refuses an empty reply rather than sending a blank mail over the restaurant's name", async () => {
  stubProviders();
  const cookie = await signedInAs("owner");
  const { feedbackId } = await seedFeedback();
  const response = await post(cookie, { action: "feedback.reply", id: feedbackId, message: "   " });
  assert.equal(response.status, 400);
});

withDb("lets only the staff who may handle feedback write to the customer", async () => {
  stubProviders();
  const cookie = await signedInAs("employee", ["view_orders"]);
  const { feedbackId } = await seedFeedback();
  const response = await post(cookie, { action: "feedback.reply", id: feedbackId, message: "Thanks!" });
  assert.equal(response.status, 403);
});

withDb("shows the inbox whether a reply can be sent, without handing out the address", async () => {
  const cookie = await signedInAs("employee", ["view_orders", "view_analytics"]);
  const { feedbackId } = await seedFeedback();
  const response = await recordsRead(
    new Request("https://order.pizza62.test/api/admin/records?tab=feedback", {
      headers: { cookie, "x-azure-clientip": nextClientIp() },
    }),
  );
  assert.equal(response.status, 200);
  const row = ((await response.json()).feedback as Array<Record<string, unknown>>).find(
    (entry) => entry.id === feedbackId,
  );
  assert.ok(row, "the seeded feedback has to be in the inbox");
  // Being able to answer a complaint is not the same permission as being able to
  // read, or copy down, the customer's address.
  assert.equal(row.can_reply, true);
  assert.equal(row.customer_email, null);
});
