/**
 * The checkout quote (H-24).
 *
 * The single property this file exists to defend: **the quote equals the
 * charge.** The review screen used to add the cart up in the browser and call it
 * "estimated", because nothing would tell it otherwise until the order was
 * submitted — which is how a customer consents to one number and is billed
 * another. So the load-bearing test here is not that the arithmetic is right in
 * isolation, it is that the quote and a real `createOrder` on the same cart
 * produce identical totals, cent for cent.
 *
 * Everything else is about the quote reporting rather than refusing: a cart with
 * three problems must describe all three, because the alternative is a customer
 * discovering them one rejection at a time.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { quoteOrder, createOrder } = await import("@/lib/order-service");
const { getSetting } = await import("@/db/runtime");
const { nextOrderSlots } = await import("@/lib/domain");
const { POST: quoteRoute } = await import("@/app/api/orders/quote/route");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

// Trap 7: identities and order numbers must not repeat across runs.
const RUN = crypto.randomUUID().slice(0, 8);
let counter = 0;
const nextClientIp = () => `203.0.113.${(counter += 1) % 250}-${RUN}`;
const nextKey = () => `quote-${RUN}-${crypto.randomUUID()}-${crypto.randomUUID()}`;

const CUSTOMER = { name: "Grace Hopper", phone: "905-555-0199", email: "grace@example.test" };

// The quote validates the order time exactly as createOrder does, so any test
// asserting `ok: true` has to name a time the store is actually open — otherwise
// it passes or fails depending on what time of day the suite is run.
const hours = reachable
  ? await getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours")
  : [];
const SLOT = reachable
  ? nextOrderSlots({ now: Date.now(), hours, timeZone: "America/Toronto", leadMinutes: 30, limit: 1 })[0]
  : 0;
const openSchedule = { type: "scheduled" as const, scheduledFor: SLOT };

/** A cart comfortably over the $20 delivery minimum. */
const bigCart = [{ productId: "poutine", quantity: 4 }];

withDb("quotes a pickup cart with the full breakdown", async () => {
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [{ productId: "poutine", quantity: 2 }],
    paymentMethod: "pay_at_store",
    tip: { type: "none" },
    schedule: openSchedule,
  });

  assert.equal(quote.ok, true);
  assert.equal(quote.issues.length, 0);
  assert.equal(quote.lines.length, 1);
  assert.equal(quote.lines[0].quantity, 2);
  assert.equal(quote.lines[0].lineTotalCents, quote.lines[0].unitPriceCents * 2);
  // Pickup has no delivery fee and no minimum to report.
  assert.equal(quote.totals.deliveryFeeCents, 0);
  assert.equal(quote.delivery, null);
  // The breakdown must add up, or the review screen is showing a lie.
  assert.equal(
    quote.totals.totalCents,
    quote.totals.discountedMenuSubtotalCents +
      quote.totals.taxCents +
      quote.totals.deliveryFeeCents +
      quote.totals.tipCents,
  );
  assert.equal(quote.taxRateBps, 1300);
});

withDb("the quoted total is the total charged", async () => {
  // The whole point. Same cart, same tip, through both paths.
  //
  // Scheduled rather than ASAP so the test does not depend on the wall clock
  // falling inside the seeded opening hours — createOrder rejects a time outside
  // them, and that is a scheduling assertion, not a pricing one.
  const hours = await getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours");
  const [slot] = nextOrderSlots({ now: Date.now(), hours, timeZone: "America/Toronto", leadMinutes: 30, limit: 1 });
  const cart = {
    fulfilment: "pickup" as const,
    items: [{ productId: "poutine", quantity: 3 }],
    paymentMethod: "pay_at_store" as const,
    tip: { type: "percentage" as const, valueBps: 1500 },
    schedule: { type: "scheduled" as const, scheduledFor: slot },
  };

  const quote = await quoteOrder(cart);
  assert.equal(quote.ok, true, "the quote must accept the same order createOrder will");
  const created = await createOrder({
    ...cart,
    idempotencyKey: nextKey(),
    customer: CUSTOMER,
  });

  const stored = await getPool().query<{
    subtotal_cents: number;
    discount_cents: number;
    tax_cents: number;
    delivery_fee_cents: number;
    tip_cents: number;
    total_cents: number;
  }>(
    "SELECT subtotal_cents, discount_cents, tax_cents, delivery_fee_cents, tip_cents, total_cents FROM orders WHERE id = $1",
    [created.orderId],
  );
  const row = stored.rows[0];
  assert.equal(quote.totals.totalCents, row.total_cents, "the quoted total must be the charged total");
  assert.equal(quote.totals.taxCents, row.tax_cents);
  assert.equal(quote.totals.tipCents, row.tip_cents);
  assert.equal(quote.totals.discountCents, row.discount_cents);
  assert.equal(quote.totals.menuSubtotalCents, row.subtotal_cents);
});

withDb("taxes the delivery fee, and says so", async () => {
  const quote = await quoteOrder({
    fulfilment: "delivery",
    items: bigCart,
    paymentMethod: "online",
    tip: { type: "none" },
  });
  assert.equal(quote.deliveryFeeTaxable, true);
  assert.ok(quote.totals.deliveryFeeCents > 0);
  // 13% of (discounted food + delivery fee), not of food alone.
  const expected = Math.round(
    ((quote.totals.discountedMenuSubtotalCents + quote.totals.deliveryFeeCents) * quote.taxRateBps) / 10_000,
  );
  assert.equal(quote.totals.taxCents, expected);
});

withDb("reports a delivery shortfall as an amount, not a refusal", async () => {
  const quote = await quoteOrder({
    fulfilment: "delivery",
    items: [{ productId: "poutine", quantity: 1 }],
    paymentMethod: "online",
    tip: { type: "none" },
  });
  assert.equal(quote.ok, false);
  assert.ok(quote.delivery);
  assert.equal(quote.delivery.meetsMinimum, false);
  assert.equal(quote.delivery.minimumCents, 2000);
  // "Add $x more" is actionable; "not eligible" is not.
  assert.equal(
    quote.delivery.shortfallCents,
    quote.delivery.minimumCents - quote.totals.menuSubtotalCents,
  );
  const issue = quote.issues.find((entry) => entry.code === "DELIVERY_BELOW_MINIMUM");
  assert.ok(issue, "the shortfall must be reported as an issue too");
  assert.match(issue.message, /\$20\.00/);
  // A total is still returned — the customer needs to see where they are.
  assert.ok(quote.totals.totalCents > 0);
});

withDb("a rejected coupon does not stop the cart being priced", async () => {
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [{ productId: "poutine", quantity: 2 }],
    paymentMethod: "pay_at_store",
    couponCode: "DEFINITELY-NOT-A-REAL-CODE",
    tip: { type: "none" },
  });
  assert.ok(quote.coupon);
  assert.equal(quote.coupon.accepted, false);
  assert.ok(quote.coupon.message);
  // The customer must still see their total, and see that no discount applied.
  assert.equal(quote.totals.discountCents, 0);
  assert.ok(quote.totals.totalCents > 0);
});

withDb("describes every unavailable line at once, not one at a time", async () => {
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [
      { productId: "poutine", quantity: 1 },
      { productId: "no-such-product-a", quantity: 1 },
      { productId: "no-such-product-b", quantity: 1 },
    ],
    paymentMethod: "pay_at_store",
    tip: { type: "none" },
  });
  assert.equal(quote.ok, false);
  const lineIssues = quote.issues.filter((entry) => entry.index !== null);
  assert.equal(lineIssues.length, 2, "both bad lines must be reported together");
  assert.deepEqual(
    lineIssues.map((entry) => entry.index).sort(),
    [1, 2],
    "issues must point at the cart positions that are wrong",
  );
  // And the good line is still priced, so the customer sees what they can keep.
  assert.equal(quote.lines.length, 1);
  assert.ok(quote.totals.totalCents > 0);
});

withDb("reports an over-limit tip and prices the cart without it", async () => {
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [{ productId: "poutine", quantity: 1 }],
    paymentMethod: "pay_at_store",
    tip: { type: "custom", amountCents: 90_000 },
  });
  assert.equal(quote.ok, false);
  assert.ok(quote.issues.some((entry) => entry.code === "TIP_INVALID"));
  assert.equal(quote.totals.tipCents, 0, "an impossible tip must not be silently applied");
  assert.ok(quote.totals.totalCents > 0);
});

// --- the route ---------------------------------------------------------------

const post = (body: unknown) =>
  quoteRoute(
    new Request("https://order.pizza62.test/api/orders/quote", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": nextClientIp() },
      body: JSON.stringify(body),
    }),
  );

withDb("the route prices a cart and creates nothing", async () => {
  const startedAt = Date.now();
  const response = await post({
    fulfilment: "pickup",
    items: [{ productId: "poutine", quantity: 1 }],
    paymentMethod: "pay_at_store",
    schedule: openSchedule,
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; totals: { totalCents: number } };
  assert.equal(body.ok, true);
  assert.ok(body.totals.totalCents > 0);

  // Trap 8: a global row count is unusable here. Test files run as separate
  // processes against one database, so other suites create orders concurrently
  // and the count moves for reasons that have nothing to do with quoting.
  //
  // Scoped instead to what an order accidentally created by a quote would
  // actually look like: a quote carries no customer, so it could only produce a
  // row with an empty customer name. Every path that legitimately creates an
  // order requires one.
  // Note the number, not the string: db/pg-driver registers an int8 parser, so a
  // COUNT arrives as a JS number rather than the string node-postgres defaults to.
  const orphans = await getPool().query<{ count: number }>(
    "SELECT COUNT(*) AS count FROM orders WHERE created_at >= $1 AND (customer_name IS NULL OR customer_name = '')",
    [startedAt],
  );
  assert.equal(orphans.rows[0].count, 0, "quoting must not create an order");
});

withDb("the route refuses an empty cart rather than quoting zero", async () => {
  const response = await post({ fulfilment: "pickup", items: [] });
  assert.equal(response.status, 400);
});

withDb("refuses to call an unschedulable time ok", async () => {
  // `ok` has to mean "this will be accepted". A quote that says yes to a closed
  // day leaves the review screen enabling a button guaranteed to fail.
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [{ productId: "poutine", quantity: 1 }],
    paymentMethod: "pay_at_store",
    // Well past the 14-day scheduling horizon.
    schedule: { type: "scheduled", scheduledFor: Date.now() + 60 * 86_400_000 },
  });
  assert.equal(quote.ok, false);
  assert.ok(quote.issues.some((entry) => /lead time|within 14 days|configured hours/.test(entry.message)));
});

withDb("agrees with createOrder about a time the store is shut", async () => {
  // The bug this pins: the schedule check used to run only when a schedule was
  // supplied, so a quote that omitted one skipped the check `createOrder` then
  // applied anyway. At 4am, with the store closed, the quote said `ok: true` for
  // an order the API refused — the exact divergence the quote exists to prevent.
  //
  // Both paths are given the same input (none), so both must reach the same
  // verdict, whatever the wall clock says when the suite runs.
  const cart = {
    fulfilment: "pickup" as const,
    items: [{ productId: "poutine", quantity: 1 }],
    paymentMethod: "pay_at_store" as const,
  };
  const quote = await quoteOrder(cart);

  let accepted = true;
  try {
    await createOrder({ ...cart, idempotencyKey: nextKey(), customer: CUSTOMER });
  } catch {
    accepted = false;
  }
  assert.equal(
    quote.ok,
    accepted,
    "the quote must reach the same verdict as createOrder on an identical cart",
  );
});

withDb("agrees with createOrder about the payment method too", async () => {
  // Found by driving the real flow: the quote said `ok: true` for a delivery
  // order paying at the store, which createOrder refuses outright. Same shape as
  // the schedule bug above — every rule createOrder enforces has to be mirrored
  // here, or the review screen enables a button that cannot work.
  const quote = await quoteOrder({
    fulfilment: "delivery",
    items: [{ productId: "poutine", quantity: 4 }],
    paymentMethod: "pay_at_store",
    schedule: openSchedule,
  });
  assert.equal(quote.ok, false);
  assert.ok(quote.issues.some((issue) => issue.code === "PAYMENT_METHOD_UNAVAILABLE"));
});

withDb("says so when online payment has no credentials behind it", async () => {
  // The customer must not reach a pay button that 503s at the last step.
  const previous = { id: process.env.CLOVER_MERCHANT_ID, token: process.env.CLOVER_API_TOKEN };
  delete process.env.CLOVER_MERCHANT_ID;
  delete process.env.CLOVER_API_TOKEN;
  const { clearIntegrationSecretCache } = await import("@/lib/integration-secrets");
  clearIntegrationSecretCache();
  try {
    const quote = await quoteOrder({
      fulfilment: "delivery",
      items: [{ productId: "poutine", quantity: 4 }],
      paymentMethod: "online",
      schedule: openSchedule,
    });
    assert.equal(quote.ok, false);
    assert.ok(quote.issues.some((issue) => issue.code === "PAYMENT_SETUP_REQUIRED"));
  } finally {
    if (previous.id) process.env.CLOVER_MERCHANT_ID = previous.id;
    if (previous.token) process.env.CLOVER_API_TOKEN = previous.token;
    clearIntegrationSecretCache();
  }
});
