/**
 * Recording refunds (H-07 / H-25), and promotion eligibility.
 *
 * **The refund path deliberately moves no money.** Clover publishes no refund
 * endpoint in the contract this project has; writing one would mean guessing at
 * an API, and a refund path that records a refund without moving money is worse
 * than none — the customer is out of pocket while the books say they were paid
 * back. So the refund is issued in the Clover dashboard and recorded here, and
 * these tests are about the recording being *correct*: never more than was
 * taken, never on money that was never taken, reversible without erasing the
 * fact that someone keyed it, and always attributed to a person.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { createPasswordHash } = await import("@/lib/auth");
const { POST: loginRoute } = await import("@/app/api/auth/login/route");
const { GET: refundsGet, POST: refundsPost } = await import("@/app/api/admin/refunds/route");

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
const nextClientIp = () => `203.0.113.${(counter += 1) % 250}-${RUN}`;
const PASSWORD = "Correct Horse Battery Staple 62";

async function signedInAs(role: "owner" | "employee", permissions: string[] = []): Promise<string> {
  const id = crypto.randomUUID();
  const email = `refund-${id}@example.test`;
  const hash = await createPasswordHash(PASSWORD);
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_users (id,email,name,role,password_hash,password_salt,password_iterations,permissions_json,active,created_at,updated_at)
     VALUES ($1,$2,'Refund Tester',$3,$4,$5,$6,$7,1,$8,$8)`,
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

/** An order with a payment, in whatever state the test needs. */
async function seedPaidOrder(options: { method?: "online" | "pay_at_store"; paymentStatus?: string; totalCents?: number } = {}) {
  const orderId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const orderNumber = `P62-R${RUN}-${(counter += 1)}`;
  const method = options.method ?? "online";
  const total = options.totalCents ?? 5000;
  const now = Date.now();
  await getPool().query(
    `INSERT INTO orders (id,order_number,tracking_token_hash,feedback_token_hash,customer_name,customer_phone,
       customer_email,fulfilment,channel,status,payment_status,payment_method,schedule_type,estimated_for,pricing_json,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'Ada Lovelace','9055550142','ada@example.test','pickup','online','completed',$5,$6,'asap',
       $7,'{}',$8,0,0,0,0,$8,$7,$7)`,
    [orderId, orderNumber, `h${orderId}`, `f${orderId}`, options.paymentStatus ?? (method === "online" ? "paid" : "pending_at_store"), method, now, total],
  );
  await getPool().query(
    `INSERT INTO payments (id,order_id,provider,method,status,amount_cents,currency,idempotency_key,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'CAD',$7,$8,$8)`,
    [
      paymentId,
      orderId,
      method === "online" ? "clover" : "store",
      method,
      method === "online" ? "captured" : "pending",
      total,
      `refund-test-${paymentId}`,
      now,
    ],
  );
  return { orderId, orderNumber, paymentId, total };
}

const post = (cookie: string, body: unknown) =>
  refundsPost(
    new Request("https://order.pizza62.test/api/admin/refunds", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const get = (cookie: string, orderId: string) =>
  refundsGet(new Request(`https://order.pizza62.test/api/admin/refunds?orderId=${orderId}`, { headers: { cookie } }));

const statusOf = async (orderId: string) =>
  (await getPool().query<{ payment_status: string }>("SELECT payment_status FROM orders WHERE id = $1", [orderId]))
    .rows[0].payment_status;

// --- permissions -------------------------------------------------------------

withDb("refuses someone who can see orders but not issue refunds", async () => {
  const cookie = await signedInAs("employee", ["view_orders"]);
  const { orderId } = await seedPaidOrder();
  assert.equal((await post(cookie, { action: "refund.record", orderId, amountCents: 100, reason: "x" })).status, 403);
  assert.equal((await get(cookie, orderId)).status, 403);
});

// --- what may be refunded ----------------------------------------------------

withDb("records a card refund against its Clover reference", async () => {
  const cookie = await signedInAs("owner", ["view_orders", "issue_refunds"]);
  const { orderId, total } = await seedPaidOrder({ method: "online" });

  const response = await post(cookie, {
    action: "refund.record",
    orderId,
    amountCents: total,
    reason: "Wrong order sent",
    providerReference: "CLOVER-REF-123",
  });
  assert.equal(response.status, 201);
  assert.equal(await statusOf(orderId), "refunded");

  const listed = (await (await get(cookie, orderId)).json()) as {
    refunds: Array<Record<string, unknown>>;
    refundedCents: number;
  };
  assert.equal(listed.refundedCents, total);
  assert.equal(listed.refunds[0].provider_reference, "CLOVER-REF-123");
  // Attribution matters: a refund with no name against it is what an audit asks
  // about first.
  assert.ok(listed.refunds[0].actor_id);
});

withDb("a refund preserves the order's tax-exempt classification", async () => {
  const cookie = await signedInAs("owner", ["view_orders", "issue_refunds"]);
  const { orderId } = await seedPaidOrder({ method: "online", totalCents: 450 });
  const pricing = JSON.stringify({
    menuSubtotalCents: 450,
    discountedMenuSubtotalCents: 450,
    taxableSubtotalCents: 0,
    nonTaxableSubtotalCents: 450,
    taxCents: 0,
    totalCents: 450,
  });
  await getPool().query(
    "UPDATE orders SET pricing_json = $1, subtotal_cents = 450, tax_cents = 0, total_cents = 450 WHERE id = $2",
    [pricing, orderId],
  );
  await getPool().query(
    `INSERT INTO order_items (id,order_id,product_id,product_name,variation_name,quantity,unit_price_cents,
       line_total_cents,taxable,snapshot_json,instructions,created_at)
     VALUES ($1,$2,'slice-combo','Slice Combo',NULL,1,450,450,0,'{}',NULL,$3)`,
    [crypto.randomUUID(), orderId, Date.now()],
  );

  const response = await post(cookie, {
    action: "refund.record",
    orderId,
    amountCents: 450,
    reason: "Order returned",
    providerReference: "CLOVER-TAX-FREE-REFUND",
  });
  assert.equal(response.status, 201, await response.clone().text());

  const stored = (
    await getPool().query<{ pricing_json: string; tax_cents: number; taxable: number }>(
      `SELECT o.pricing_json, o.tax_cents, i.taxable
       FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.id = $1`,
      [orderId],
    )
  ).rows[0];
  const after = JSON.parse(stored.pricing_json) as Record<string, number>;
  assert.equal(stored.tax_cents, 0);
  assert.equal(stored.taxable, 0);
  assert.equal(after.taxableSubtotalCents, 0);
  assert.equal(after.nonTaxableSubtotalCents, 450);
});

withDb("will not record a card refund without the Clover reference", async () => {
  // The reference is the only thing tying this record to money actually moving.
  // Without it the entry is an assertion that a refund happened, and nothing more.
  const cookie = await signedInAs("owner", ["view_orders", "issue_refunds"]);
  const { orderId } = await seedPaidOrder({ method: "online" });
  const response = await post(cookie, { action: "refund.record", orderId, amountCents: 100, reason: "Wrong order" });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /Clover dashboard/);
});

withDb("records a cash refund without one", async () => {
  // There is no Clover transaction to reference, and demanding one would only
  // teach staff to invent it.
  const cookie = await signedInAs("owner", ["view_orders", "issue_refunds"]);
  const { orderId } = await seedPaidOrder({ method: "pay_at_store" });
  const response = await post(cookie, { action: "refund.record", orderId, amountCents: 500, reason: "Cold pizza" });
  assert.equal(response.status, 201);
});

withDb("refuses to refund more than was taken, across several refunds", async () => {
  const cookie = await signedInAs("owner", ["view_orders", "issue_refunds"]);
  const { orderId, total } = await seedPaidOrder({ method: "pay_at_store", totalCents: 5000 });

  assert.equal((await post(cookie, { action: "refund.record", orderId, amountCents: 3000, reason: "Missing item" })).status, 201);
  assert.equal(await statusOf(orderId), "partially_refunded");

  // 3000 + 2500 > 5000. Nothing downstream would catch this.
  const over = await post(cookie, { action: "refund.record", orderId, amountCents: 2500, reason: "More" });
  assert.equal(over.status, 400);

  // Exactly the remainder is fine, and closes the order out.
  assert.equal((await post(cookie, { action: "refund.record", orderId, amountCents: 2000, reason: "The rest" })).status, 201);
  assert.equal(await statusOf(orderId), "refunded");
  const listed = (await (await get(cookie, orderId)).json()) as { refundedCents: number };
  assert.equal(listed.refundedCents, total);
});

withDb("refuses to refund an order whose money was never taken", async () => {
  // Recording one would put revenue on the books that never existed, and then
  // take it off again.
  const cookie = await signedInAs("owner", ["view_orders", "issue_refunds"]);
  const { orderId } = await seedPaidOrder({ method: "online", paymentStatus: "awaiting_checkout" });
  await getPool().query("UPDATE payments SET status = 'pending' WHERE order_id = $1", [orderId]);
  const response = await post(cookie, {
    action: "refund.record",
    orderId,
    amountCents: 100,
    reason: "Nope",
    providerReference: "X",
  });
  assert.equal(response.status, 409);
});

// --- correcting a mistake ----------------------------------------------------

withDb("voiding puts the order back where it was, without erasing the entry", async () => {
  const cookie = await signedInAs("owner", ["view_orders", "issue_refunds"]);
  const { orderId, total } = await seedPaidOrder({ method: "online" });
  const created = await post(cookie, {
    action: "refund.record",
    orderId,
    amountCents: total,
    reason: "Mis-keyed",
    providerReference: "REF-1",
  });
  const { id } = (await created.json()) as { id: string };
  assert.equal(await statusOf(orderId), "refunded");

  assert.equal((await post(cookie, { action: "refund.void", refundId: id })).status, 200);
  assert.equal(await statusOf(orderId), "paid", "a card order goes back to paid");

  // The row survives, marked voided — a mis-keyed amount must be correctable
  // without erasing the fact that someone keyed it.
  const listed = (await (await get(cookie, orderId)).json()) as {
    refunds: Array<Record<string, unknown>>;
    refundedCents: number;
  };
  assert.equal(listed.refundedCents, 0);
  assert.equal(listed.refunds.length, 1);
  assert.equal(listed.refunds[0].status, "voided");
});

withDb("voiding a cash refund does not invent a card settlement", async () => {
  // The bug this pins: restoring every order to `paid` on void. A cash pickup
  // order is `pending_at_store`, and marking it paid would count it as settled
  // revenue on the dashboard when nobody has handed over anything.
  const cookie = await signedInAs("owner", ["view_orders", "issue_refunds"]);
  const { orderId, total } = await seedPaidOrder({ method: "pay_at_store" });
  const created = await post(cookie, { action: "refund.record", orderId, amountCents: total, reason: "Mis-keyed" });
  const { id } = (await created.json()) as { id: string };
  await post(cookie, { action: "refund.void", refundId: id });
  assert.equal(await statusOf(orderId), "pending_at_store");
});

withDb("will not void the same refund twice", async () => {
  const cookie = await signedInAs("owner", ["view_orders", "issue_refunds"]);
  const { orderId, total } = await seedPaidOrder({ method: "pay_at_store" });
  const created = await post(cookie, { action: "refund.record", orderId, amountCents: total, reason: "Mis-keyed" });
  const { id } = (await created.json()) as { id: string };
  assert.equal((await post(cookie, { action: "refund.void", refundId: id })).status, 200);
  assert.equal((await post(cookie, { action: "refund.void", refundId: id })).status, 404);
});

withDb("requires a reason", async () => {
  // "Refunded $50" with no reason is not a record, it is a hole in one.
  const cookie = await signedInAs("owner", ["view_orders", "issue_refunds"]);
  const { orderId } = await seedPaidOrder({ method: "pay_at_store" });
  assert.equal((await post(cookie, { action: "refund.record", orderId, amountCents: 100, reason: "" })).status, 400);
});

// --- promotion eligibility ---------------------------------------------------
//
// The columns existed in the schema and nothing read them, so a minimum spend or
// a usage limit set in the admin screen had no effect whatsoever — the offer
// applied to everyone, forever. These pin each one to an observable outcome.

const { quoteOrder } = await import("@/lib/order-service");

async function seedPromotion(overrides: Record<string, unknown> = {}): Promise<string> {
  const id = `promo-${RUN}-${(counter += 1)}`;
  const now = Date.now();
  await getPool().query(
    `INSERT INTO promotions (id,name,code,type,amount,priority,combinable,exclusive,active,rule_json,
       starts_at,ends_at,min_subtotal_cents,fulfilment,usage_limit,per_customer_limit,usage_count,display_order,created_at,updated_at)
     VALUES ($1,$2,NULL,'fixed',$3,500,1,0,1,'{}',NULL,NULL,$4,$5,$6,NULL,$7,0,$8,$8)`,
    [
      id,
      `Test offer ${id}`,
      overrides.amount ?? 200,
      overrides.minSubtotalCents ?? 0,
      overrides.fulfilment ?? "any",
      overrides.usageLimit ?? null,
      overrides.usageCount ?? 0,
      now,
    ],
  );
  return id;
}

const applied = (quote: Awaited<ReturnType<typeof quoteOrder>>, id: string) =>
  quote.appliedPromotions.some((entry) => entry.id === id);

withDb("honours a minimum spend", async () => {
  const id = await seedPromotion({ minSubtotalCents: 5000 });
  try {
    const small = await quoteOrder({ fulfilment: "pickup", items: [{ productId: "poutine", quantity: 1 }], paymentMethod: "pay_at_store" });
    assert.equal(applied(small, id), false, "an $8.99 cart must not trigger a $50 minimum offer");
    const large = await quoteOrder({ fulfilment: "pickup", items: [{ productId: "poutine", quantity: 8 }], paymentMethod: "pay_at_store" });
    assert.equal(applied(large, id), true);
  } finally {
    await getPool().query("DELETE FROM promotions WHERE id = $1", [id]);
  }
});

withDb("honours a pickup-only or delivery-only restriction", async () => {
  const id = await seedPromotion({ fulfilment: "delivery" });
  try {
    const pickup = await quoteOrder({ fulfilment: "pickup", items: [{ productId: "poutine", quantity: 4 }], paymentMethod: "pay_at_store" });
    assert.equal(applied(pickup, id), false);
    const delivery = await quoteOrder({ fulfilment: "delivery", items: [{ productId: "poutine", quantity: 4 }], paymentMethod: "online" });
    assert.equal(applied(delivery, id), true);
  } finally {
    await getPool().query("DELETE FROM promotions WHERE id = $1", [id]);
  }
});

withDb("stops offering an exhausted promotion", async () => {
  const id = await seedPromotion({ usageLimit: 5, usageCount: 5 });
  try {
    const quote = await quoteOrder({ fulfilment: "pickup", items: [{ productId: "poutine", quantity: 4 }], paymentMethod: "pay_at_store" });
    assert.equal(applied(quote, id), false, "a spent offer must not be quoted, let alone honoured");
  } finally {
    await getPool().query("DELETE FROM promotions WHERE id = $1", [id]);
  }
});

withDb("counts a redemption when an order actually uses it", async () => {
  // A usage limit is only meaningful if redemptions are counted.
  const { createOrder } = await import("@/lib/order-service");
  const { getSetting } = await import("@/db/runtime");
  const { nextOrderSlots } = await import("@/lib/domain");
  const id = await seedPromotion({ usageLimit: 10 });
  try {
    const hours = await getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours");
    const [slot] = nextOrderSlots({ now: Date.now(), hours, timeZone: "America/Toronto", leadMinutes: 30, limit: 1 });
    await createOrder({
      idempotencyKey: `promo-${RUN}-${crypto.randomUUID()}-${crypto.randomUUID()}`,
      fulfilment: "pickup",
      items: [{ productId: "poutine", quantity: 4 }],
      customer: { name: "Ada Lovelace", phone: "905-555-0142", email: "ada@example.test" },
      schedule: { type: "scheduled", scheduledFor: slot },
      paymentMethod: "pay_at_store",
      tip: { type: "none" },
    });
    const row = await getPool().query<{ usage_count: number }>("SELECT usage_count FROM promotions WHERE id = $1", [id]);
    assert.equal(Number(row.rows[0].usage_count), 1);
  } finally {
    await getPool().query("DELETE FROM promotions WHERE id = $1", [id]);
  }
});
