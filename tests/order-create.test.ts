/**
 * Order creation, through the real route handler (R1.6).
 *
 * `POST /api/orders` is the most consequential path in the application: it is
 * where money is priced, where a duplicate submission either is or is not a
 * second charge, and where a failed payment either releases the customer's
 * checkout or locks them out of their own order. `tests/domain.test.ts` already
 * covers the pricing arithmetic in isolation; what was untested until now is the
 * route around it — the idempotency reservation, the side effects that must all
 * land or none, and the failure paths that unwind them.
 *
 * These call the exported `POST` with a real `Request` rather than going over
 * HTTP, so the rate limiter, the validation, the database writes and the error
 * mapping are all the ones production runs.
 *
 * Requires a reachable Postgres; skipped otherwise, like the driver suite.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";
// Gives every test its own rate-limit bucket via x-azure-clientip, so a suite
// of order submissions cannot exhaust the shared "direct" budget and start
// returning 429 partway through.
process.env.TRUST_PROXY_HEADERS = "true";

const { getPool, closePool } = await import("@/db/pg-driver");
const { POST: createOrderRoute } = await import("@/app/api/orders/route");
const { nextOrderSlots } = await import("@/lib/domain");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

let addressCounter = 0;
// A distinct caller per test, and per run: rate-limit budgets are stored in the
// database and outlive the process, so a counter that restarts identically each
// run would share buckets across runs and fail on a later `npm test` in the same
// window. The limiter treats the identity as an opaque string.
const RUN = crypto.randomUUID().slice(0, 8);
const nextClientIp = () => `198.51.100.${(addressCounter += 1) % 250}-${RUN}`;

const uniqueKey = () => `test-${crypto.randomUUID()}-${crypto.randomUUID()}`;

/**
 * The next time the restaurant is actually open.
 *
 * Orders are validated against the seeded opening hours, so a test that hard
 * coded a time would pass or fail depending on the hour it ran at. Asking the
 * same helper the checkout UI uses keeps them deterministic.
 */
async function nextOpenSlot(): Promise<number> {
  const { getSetting } = await import("@/db/runtime");
  const hours = await getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours");
  const slots = nextOrderSlots({ now: Date.now(), hours, timeZone: "America/Toronto", leadMinutes: 30, limit: 4 });
  assert.ok(slots.length, "the seeded hours should offer an upcoming slot");
  return slots[0];
}

type OrderBody = Record<string, unknown>;

async function orderBody(overrides: OrderBody = {}): Promise<OrderBody> {
  return {
    idempotencyKey: uniqueKey(),
    fulfilment: "pickup",
    customer: { name: "Ada Lovelace", phone: "905-555-0142", email: "ada@example.test" },
    items: [{ productId: "poutine", quantity: 2 }],
    schedule: { type: "scheduled", scheduledFor: await nextOpenSlot() },
    paymentMethod: "pay_at_store",
    tip: { type: "none" },
    ...overrides,
  };
}

const post = (body: OrderBody, clientIp = nextClientIp()) =>
  createOrderRoute(
    new Request("https://order.pizza62.test/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": clientIp },
      body: JSON.stringify(body),
    }),
  );

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

// --- the happy path ---------------------------------------------------------

withDb("accepts a valid pickup order and prices it server-side", async () => {
  const response = await post(await orderBody());
  assert.equal(response.status, 201);
  const result = await json(response);

  assert.match(String(result.orderNumber), /^P62-\d+$/);
  assert.equal(result.status, "received");
  assert.equal(result.paymentStatus, "pending_at_store");
  assert.equal(result.duplicate, false);
  // 2 x Poutine at 899, plus 13% HST. The point is not the arithmetic — that is
  // domain.test.ts's job — but that the route used the catalog price rather than
  // anything the caller could influence.
  const price = result.price as Record<string, number>;
  assert.equal(price.menuSubtotalCents, 1798);
  assert.equal(price.totalCents, 2032);
  // Tracking and feedback tokens are returned once, in the clear, and stored
  // only as hashes — this is the customer's sole copy.
  assert.ok(String(result.trackingToken).length >= 32);
  assert.ok(String(result.feedbackToken).length >= 32);
});

withDb("lands every side effect of an accepted order", async () => {
  const result = await json(await post(await orderBody()));
  const orderId = String(result.orderId);
  const pool = getPool();

  // Counts come back as numbers, not strings: db/pg-driver.ts registers an int8
  // type parser precisely so the app's `=== 1` comparisons keep working.
  const counts = await pool.query<{ items: number; payments: number; events: number; outbox: number }>(
    `SELECT
       (SELECT count(*) FROM order_items WHERE order_id = $1) AS items,
       (SELECT count(*) FROM payments WHERE order_id = $1) AS payments,
       (SELECT count(*) FROM order_events WHERE order_id = $1) AS events,
       (SELECT count(*) FROM notification_outbox WHERE payload_json::jsonb->>'orderId' = $1) AS outbox`,
    [orderId],
  );
  // The audit's finding was that nothing drained the outbox; the row still has
  // to be written, or there is nothing for R1.4 to drain.
  // Three outbox rows, not one. R1.4 queues the customer's confirmation, the
  // restaurant's new-order alert (the audit's central finding — nothing
  // previously told the restaurant an order existed at all), and the delayed
  // feedback request (H-09).
  assert.deepEqual(counts.rows[0], { items: 1, payments: 1, events: 1, outbox: 3 });
});

withDb("persists mixed taxable and tax-exempt lines with the exact payment total", async () => {
  const response = await post(await orderBody({
    items: [
      {
        productId: "slice-combo",
        quantity: 1,
        modifiers: [
          { id: "slice-topping", values: ["pepperoni"] },
          { id: "included-dip", values: ["Dipping Sauce"] },
          { id: "drink-1", values: ["Coke"] },
        ],
      },
      { productId: "poutine", quantity: 1 },
    ],
  }));
  assert.equal(response.status, 201, await response.clone().text());
  const result = await json(response);
  const price = result.price as Record<string, number>;
  assert.equal(price.menuSubtotalCents, 1349);
  assert.equal(price.taxableSubtotalCents, 899);
  assert.equal(price.nonTaxableSubtotalCents, 450);
  assert.equal(price.taxCents, 117);
  assert.equal(price.totalCents, 1466);

  const orderId = String(result.orderId);
  const stored = await getPool().query<{
    pricing_json: string;
    tax_cents: number;
    total_cents: number;
    payment_amount_cents: number;
  }>(
    `SELECT o.pricing_json, o.tax_cents, o.total_cents, p.amount_cents AS payment_amount_cents
     FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.id = $1`,
    [orderId],
  );
  const persistedPrice = JSON.parse(stored.rows[0].pricing_json) as Record<string, number>;
  assert.equal(persistedPrice.taxableSubtotalCents, 899);
  assert.equal(persistedPrice.nonTaxableSubtotalCents, 450);
  assert.equal(stored.rows[0].tax_cents, 117);
  assert.equal(stored.rows[0].total_cents, 1466);
  assert.equal(stored.rows[0].payment_amount_cents, 1466);

  const items = await getPool().query<{ product_id: string; taxable: number }>(
    "SELECT product_id, taxable FROM order_items WHERE order_id = $1 ORDER BY product_id",
    [orderId],
  );
  assert.deepEqual(items.rows, [
    { product_id: "poutine", taxable: 1 },
    { product_id: "slice-combo", taxable: 0 },
  ]);
});

withDb("a pay-at-store order parks no payment with a provider", async () => {
  const result = await json(await post(await orderBody()));
  const payment = await getPool().query<{ provider: string; status: string }>(
    "SELECT provider, status FROM payments WHERE order_id = $1",
    [String(result.orderId)],
  );
  assert.equal(payment.rows[0].provider, "store");
});

// --- idempotency ------------------------------------------------------------

withDb("replaying an idempotency key returns the same order, not a second one", async () => {
  // C-07. The failure this guards is the expensive one: a double-submit — a
  // refresh, a back button, an impatient second click — charging twice.
  const body = await orderBody();
  const first = await json(await post(body));
  const second = await post(body);

  assert.equal(second.status, 200, "a replay is not a creation");
  const replay = await json(second);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.orderId, first.orderId);
  assert.equal(replay.orderNumber, first.orderNumber);

  const rows = await getPool().query("SELECT id FROM orders WHERE id = $1", [String(first.orderId)]);
  assert.equal(rows.rowCount, 1);
});

withDb("a replay does not re-issue the tracking token", async () => {
  // The tokens are stored only as hashes, so they cannot be recovered on a
  // replay. Returning a fresh one would be worse than returning none: it would
  // not match the stored hash and would silently fail at the tracking endpoint.
  const body = await orderBody();
  await post(body);
  const replay = await json(await post(body));
  assert.equal(replay.trackingToken, undefined);
});

withDb("concurrent submissions of one key create exactly one order", async () => {
  // On Container Apps these land on different replicas, so only the database can
  // settle it — the reservation is an INSERT … ON CONFLICT DO NOTHING, and the
  // loser must resolve to the winner's order rather than start its own.
  const body = await orderBody();
  const responses = await Promise.all([post(body), post(body), post(body), post(body)]);
  const results = await Promise.all(responses.map(json));

  const created = results.filter((result) => result.duplicate === false);
  const numbers = new Set(results.map((result) => result.orderNumber).filter(Boolean));
  assert.equal(created.length, 1, "exactly one submission should create the order");
  assert.equal(numbers.size, 1, "every submission should resolve to the same order");
});

withDb("rejects an idempotency key too short to be unguessable", async () => {
  const response = await post(await orderBody({ idempotencyKey: "short" }));
  assert.equal(response.status, 400);
});

withDb("a rejected order leaves its key free to retry", async () => {
  // The key is reserved before validation runs, so a validation failure has to
  // unwind it. Otherwise a customer who mistypes an address once can never
  // complete that checkout — the retry resolves to a duplicate of nothing.
  const key = uniqueKey();
  const rejected = await post(await orderBody({ idempotencyKey: key, items: [] }));
  assert.equal(rejected.status, 400);

  const retried = await post(await orderBody({ idempotencyKey: key }));
  assert.equal(retried.status, 201, "the same key must be usable after a rejection");
  assert.equal((await json(retried)).duplicate, false);
});

// --- validation the route must not delegate to the client -------------------

withDb("ignores a client-supplied price", async () => {
  // The regression this guards is the obvious attack: pricing is recomputed from
  // the catalog, so anything the caller sends about money is inert.
  const result = await json(
    await post(await orderBody({ items: [{ productId: "poutine", quantity: 2, unitPriceCents: 1 }] })),
  );
  assert.equal((result.price as Record<string, number>).totalCents, 2032);
});

withDb("refuses an unknown product", async () => {
  const response = await post(await orderBody({ items: [{ productId: "not-a-real-product", quantity: 1 }] }));
  assert.equal(response.status, 400);
});

withDb("refuses a non-positive quantity", async () => {
  const response = await post(await orderBody({ items: [{ productId: "poutine", quantity: 0 }] }));
  assert.equal(response.status, 400);
});

withDb("refuses pay-at-store for delivery", async () => {
  const response = await post(
    await orderBody({
      fulfilment: "delivery",
      paymentMethod: "pay_at_store",
      address: { line1: "55 Parkdale Ave N", city: "Hamilton", province: "ON", postalCode: "L8H 5W7" },
    }),
  );
  assert.equal(response.status, 400);
});

withDb("refuses a time outside opening hours", async () => {
  // 04:00 Toronto tomorrow: inside the 14-day horizon, outside every open day.
  const closed = new Date();
  closed.setUTCDate(closed.getUTCDate() + 1);
  closed.setUTCHours(8, 0, 0, 0);
  const response = await post(await orderBody({ schedule: { type: "scheduled", scheduledFor: closed.getTime() } }));
  assert.equal(response.status, 400);
  assert.match(String((await json(response)).error), /hours/i);
});

withDb("refuses an online order while Clover is unconfigured", async () => {
  // The customer must be stopped before an order row exists, not handed a 502
  // after one has been created and cancelled.
  const previous = { id: process.env.CLOVER_MERCHANT_ID, token: process.env.CLOVER_API_TOKEN };
  delete process.env.CLOVER_MERCHANT_ID;
  delete process.env.CLOVER_API_TOKEN;
  try {
    const response = await post(await orderBody({ paymentMethod: "online" }));
    assert.equal(response.status, 503);
    assert.equal((await json(response)).code, "PAYMENT_SETUP_REQUIRED");
  } finally {
    if (previous.id !== undefined) process.env.CLOVER_MERCHANT_ID = previous.id;
    if (previous.token !== undefined) process.env.CLOVER_API_TOKEN = previous.token;
  }
});

// --- rate limiting ----------------------------------------------------------

withDb("throttles one caller without affecting another", async () => {
  const noisy = nextClientIp();
  const quiet = nextClientIp();
  // The budget is 12 per 15 minutes; the 13th must be refused.
  const responses: Response[] = [];
  for (let attempt = 0; attempt < 13; attempt += 1) {
    responses.push(await post(await orderBody(), noisy));
  }
  assert.equal(responses.at(-1)?.status, 429);
  assert.equal((await post(await orderBody(), quiet)).status, 201, "another caller keeps its own budget");
});
