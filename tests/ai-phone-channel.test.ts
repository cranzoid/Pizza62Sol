/**
 * The `ai_phone` order channel (Phase 1D).
 *
 * An order the automated receptionist takes is recorded as `ai_phone`, never as
 * `phone` (which means a member of staff took the call at the till). Pinned
 * here:
 *
 * - the database accepts `ai_phone` and still refuses anything unknown;
 * - the AI context's rules: name and callback number required, email optional,
 *   no counter-only items, no card payment, no codes, no cutoff exemption,
 *   pay-at-store on pickup per the website setting, pay-at-the-door off unless
 *   explicitly enabled, the restaurant alerted, the creation event traced to
 *   the voice session;
 * - **nothing public can produce an `ai_phone` order**: not the website order
 *   route, not the quote route, not the till;
 * - every label and report knows the channel.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, mock } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { getSetting } = await import("@/db/runtime");
const { ORDER_CHANNELS } = await import("@/db/schema");
const { nextOrderSlots } = await import("@/lib/domain");
const { createOrder, quoteOrder } = await import("@/lib/order-service");
const { AI_PHONE_ORDER_POLICY, aiPhoneOrderContext, resolveOrderPolicy } = await import("@/lib/order-policy");
const { ORDER_CHANNEL_LABELS, ORDER_CHANNEL_TICKET_LABELS, orderChannelLabel, orderChannelTicketLabel, takenByRestaurant } =
  await import("@/lib/order-channels");
const { orderSourceLabel } = await import("@/lib/attribution");
const { buildPassPrntTicketHtml } = await import("@/lib/passprnt");
const { createPasswordHash } = await import("@/lib/auth");
const { POST: loginRoute } = await import("@/app/api/auth/login/route");
const { POST: publicOrderRoute } = await import("@/app/api/orders/route");
const { POST: publicQuoteRoute } = await import("@/app/api/orders/quote/route");
const { POST: staffOrderRoute } = await import("@/app/api/admin/orders/route");
const { GET: recordsRoute } = await import("@/app/api/admin/records/route");
const { GET: customersRoute } = await import("@/app/api/admin/customers/route");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});
afterEach(() => {
  mock.timers.reset();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const RUN = crypto.randomUUID().slice(0, 8);
let counter = 0;
const nextKey = () => `ai-channel-${RUN}-${(counter += 1)}-${crypto.randomUUID()}`;
const nextClientIp = () => `198.18.0.${(counter += 1) % 250}-${RUN}`;
const PASSWORD = "Correct Horse Battery Staple 62";

const hours = reachable ? await getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours") : [];
const SLOT = reachable
  ? nextOrderSlots({ now: Date.now(), hours, timeZone: "America/Toronto", leadMinutes: 45, limit: 1 })[0]
  : 0;
const VOICE_SESSION = `voice-session-${RUN}`;
const ai = (allowPayOnDelivery = false) => aiPhoneOrderContext({ voiceSessionId: VOICE_SESSION, allowPayOnDelivery });

const CALLER = { name: "Jordan Caller", phone: "905-555-0177" };
const ADDRESS = { line1: "55 Parkdale Ave N", city: "Hamilton", province: "ON", postalCode: "L8H 5W7" };
const pickup = (extra: Record<string, unknown> = {}) => ({
  fulfilment: "pickup" as const,
  items: [{ productId: "poutine", quantity: 2 }],
  paymentMethod: "pay_at_store" as const,
  tip: { type: "none" as const },
  schedule: { type: "scheduled" as const, scheduledFor: SLOT },
  customer: CALLER,
  idempotencyKey: nextKey(),
  ...extra,
});
const delivery = (extra: Record<string, unknown> = {}) =>
  pickup({ fulfilment: "delivery", items: [{ productId: "poutine", quantity: 3 }], address: ADDRESS, ...extra });

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
  return null;
}

async function signedInAs(role: "owner" | "employee", permissions: string[] = []): Promise<string> {
  const id = crypto.randomUUID();
  const email = `ai-channel-${id}@example.test`;
  const hash = await createPasswordHash(PASSWORD);
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_users (id,email,name,role,password_hash,password_salt,password_iterations,permissions_json,active,created_at,updated_at)
     VALUES ($1,$2,'AI Channel Tester',$3,$4,$5,$6,$7,1,$8,$8)`,
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

const FORGED = {
  channel: "ai_phone",
  staffEntry: true,
  policy: { ...AI_PHONE_ORDER_POLICY },
  context: { policy: { ...AI_PHONE_ORDER_POLICY }, actorId: "forged" },
  actorId: "forged",
};

// --- the database --------------------------------------------------------------

withDb("the database accepts ai_phone and still refuses an unknown channel", async () => {
  const insert = (channel: string) =>
    getPool().query(
      `INSERT INTO orders (id,order_number,tracking_token_hash,feedback_token_hash,customer_name,customer_phone,
         customer_email,fulfilment,channel,status,payment_status,payment_method,schedule_type,estimated_for,pricing_json,
         subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,created_at,updated_at)
       VALUES ($1,$2,$1,$1,'Constraint','9055550100','','pickup',$3,'received','pending_at_store','pay_at_store','asap',1,'{}',0,0,0,0,0,0,1,1)`,
      [crypto.randomUUID(), `P62-K${RUN}-${(counter += 1)}`, channel],
    );
  await insert("ai_phone");
  await assert.rejects(insert("ai"), /orders_channel/);
  await assert.rejects(insert("voice"), /orders_channel/);
  assert.ok(ORDER_CHANNELS.includes("ai_phone"));
});

// --- the AI context --------------------------------------------------------------

withDb("an AI phone pickup is recorded as ai_phone, alerted, and traced to its voice session", async () => {
  const result = await createOrder(pickup({ attribution: { last: { utm_source: "google", captured_at: 1 } } }), ai());
  const order = (
    await getPool().query<Record<string, unknown>>(
      "SELECT channel, status, payment_status, payment_method, customer_email, customer_phone, acknowledged_at, attribution_json FROM orders WHERE id=$1",
      [result.orderId],
    )
  ).rows[0];
  assert.equal(order.channel, "ai_phone");
  assert.equal(order.status, "received");
  assert.equal(order.payment_method, "pay_at_store");
  assert.equal(order.payment_status, "pending_at_store");
  assert.equal(order.customer_email, "", "no email is asked for");
  assert.equal(order.customer_phone, "9055550177");
  assert.equal(order.acknowledged_at, null, "the restaurant has not seen it yet");
  assert.equal(order.attribution_json, null, "a phone call has no campaign");
  const kinds = (
    await getPool().query<{ kind: string }>("SELECT kind FROM notification_outbox WHERE payload_json::jsonb->>'orderId' = $1", [result.orderId])
  ).rows.map((row) => row.kind);
  assert.deepEqual(kinds, ["restaurant_new_order"]);
  const events = (
    await getPool().query<{ actor_type: string; actor_id: string | null }>("SELECT actor_type, actor_id FROM order_events WHERE order_id=$1", [result.orderId])
  ).rows;
  assert.deepEqual(events, [{ actor_type: "ai_receptionist", actor_id: VOICE_SESSION }]);
});

withDb("the AI needs a name and a callback number, and no email", async () => {
  assert.deepEqual(await refusal(createOrder(pickup({ customer: { name: "Jordan" } }), ai())), {
    code: "ORDER_VALIDATION_FAILED",
    message: "A callback phone number is needed for this order.",
  });
  assert.equal((await refusal(createOrder(pickup({ customer: { phone: "905-555-0177" } }), ai())))?.message, "A name is needed for this order.");
  assert.equal((await refusal(createOrder(pickup({ customer: { name: "Jordan", phone: "555" } }), ai())))?.message, "That phone number does not look right.");
  assert.equal(
    (await refusal(createOrder(pickup({ customer: { ...CALLER, email: "nope" } }), ai())))?.message,
    "That email address does not look right.",
  );
  assert.equal(await refusal(createOrder(pickup({ customer: { ...CALLER, email: "jordan@example.test" } }), ai())), null);
});

withDb("the AI gets none of the counter's privileges", async () => {
  assert.equal(
    (await refusal(createOrder(pickup({ items: [{ productId: "chicken-burger", quantity: 1 }] }), ai())))?.message,
    "This item is only available at the counter.",
  );
  assert.equal(
    (await refusal(createOrder(pickup({ paymentMethod: "online" }), ai())))?.message,
    "That payment method is not available for this order.",
  );
  // A gift card code is money; it is never taken by voice. A promo code is
  // checked and priced exactly as the website checks it (see the next test).
  assert.deepEqual(await refusal(createOrder(pickup({ giftCardCode: "P62-AAAA-BBBB-CCCC" }), ai())), {
    code: "CODES_NOT_ACCEPTED",
    message: "Gift cards cannot be used on this order.",
  });
  const quote = await quoteOrder(pickup({ items: [{ productId: "chicken-burger", quantity: 1 }], paymentMethod: "online" }), ai());
  assert.equal(quote.ok, false);
  assert.deepEqual(quote.issues.map((issue) => issue.code).sort(), ["ORDER_VALIDATION_FAILED", "PAYMENT_METHOD_UNAVAILABLE"]);
});

withDb("the AI takes promo codes through the website's own coupon rules", async () => {
  const quote = await quoteOrder(pickup({ couponCode: "nope62" }), ai());
  assert.equal(quote.coupon?.status, "invalid");
  assert.equal((await refusal(createOrder(pickup({ couponCode: "NOPE62" }), ai())))?.code, "PROMO_CODE_INVALID");
  const website = await quoteOrder(pickup({ couponCode: "nope62" }));
  assert.deepEqual(quote.coupon, website.coupon, "the same code gets the same answer on both channels");
});

withDb("pay at the door is off for the AI unless explicitly enabled, and pickup follows the website setting", async () => {
  assert.equal(
    (await refusal(createOrder(delivery(), ai())))?.message,
    "Pay at store is available for pickup orders only.",
  );
  assert.equal(await refusal(createOrder(delivery(), ai(true))), null, "the explicit voice policy enables it");
  assert.equal((await refusal(createOrder(delivery({ items: [{ productId: "poutine", quantity: 1 }] }), ai(true))))?.code, "DELIVERY_ADDRESS_INELIGIBLE");

  const original = (await getPool().query<{ value_json: string }>("SELECT value_json FROM settings WHERE key='ordering'")).rows[0].value_json;
  await getPool().query("UPDATE settings SET value_json=$1 WHERE key='ordering'", [JSON.stringify({ ...JSON.parse(original), payAtStorePickupEnabled: false })]);
  try {
    assert.equal((await refusal(createOrder(pickup(), ai())))?.message, "Pay at store is available for pickup orders only.");
  } finally {
    await getPool().query("UPDATE settings SET value_json=$1 WHERE key='ordering'", [original]);
  }
});

withDb("the AI is held to the last-order cutoff", async () => {
  const close = hours.find((day) => day.weekday === 3)?.closeMinute ?? 1320;
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T00:00:00-04:00") + (close - 10) * 60_000 });
  try {
    assert.equal((await refusal(createOrder(pickup({ schedule: { type: "asap" } }), ai())))?.code, "LAST_ORDERS_CLOSED");
  } finally {
    mock.timers.reset();
  }
});

test("the AI preset is frozen, least-privileged, and survives policy validation", () => {
  assert.ok(Object.isFrozen(AI_PHONE_ORDER_POLICY));
  assert.equal(resolveOrderPolicy(ai()), AI_PHONE_ORDER_POLICY);
  assert.equal(resolveOrderPolicy(ai(true)).allowPayOnDelivery, true);
  assert.equal(AI_PHONE_ORDER_POLICY.allowPayOnDelivery, false);
  assert.deepEqual([...AI_PHONE_ORDER_POLICY.paymentMethods], ["pay_at_store"]);
  assert.equal(ai().actorId, VOICE_SESSION);
});

// --- nothing public produces ai_phone ---------------------------------------------

withDb("the public order route never produces an ai_phone order, whatever the body says", async () => {
  const post = (body: unknown) =>
    publicOrderRoute(
      new Request("https://order.pizza62.test/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json", "x-azure-clientip": nextClientIp() },
        body: JSON.stringify(body),
      }),
    );
  // The AI's relaxed contact rule is not reachable: no email is still refused.
  const noEmail = await post({ ...pickup(), ...FORGED });
  assert.equal(noEmail.status, 400);
  assert.equal(((await noEmail.json()) as { error: string }).error, "Enter a valid email address.");

  const accepted = await post({ ...pickup({ customer: { ...CALLER, email: "jordan@example.test" } }), ...FORGED });
  assert.equal(accepted.status, 201);
  const { orderId } = (await accepted.json()) as { orderId: string };
  const row = (await getPool().query<{ channel: string }>("SELECT channel FROM orders WHERE id=$1", [orderId])).rows[0];
  assert.equal(row.channel, "online");
  const events = (await getPool().query<{ actor_type: string; actor_id: string | null }>("SELECT actor_type, actor_id FROM order_events WHERE order_id=$1", [orderId])).rows;
  assert.deepEqual(events, [{ actor_type: "system", actor_id: null }]);
});

withDb("the public quote route applies the website's rules whatever the body says", async () => {
  const response = await publicQuoteRoute(
    new Request("https://order.pizza62.test/api/orders/quote", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": nextClientIp() },
      body: JSON.stringify({ ...delivery(), ...FORGED }),
    }),
  );
  const quote = (await response.json()) as { ok: boolean; issues: Array<{ code: string }> };
  assert.equal(quote.ok, false);
  assert.ok(quote.issues.some((issue) => issue.code === "PAYMENT_METHOD_UNAVAILABLE"));
});

withDb("the till refuses to label an order ai_phone", async () => {
  const cookie = await signedInAs("owner");
  const response = await staffOrderRoute(
    new Request("https://order.pizza62.test/api/admin/orders", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ ...pickup(), channel: "ai_phone" }),
    }),
  );
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, "Say whether this is a walk-in or a phone order.");
});

// --- labels and reports -------------------------------------------------------

test("every channel has a label, a ticket label and a source label", () => {
  assert.deepEqual(Object.keys(ORDER_CHANNEL_LABELS).sort(), [...ORDER_CHANNELS].sort());
  assert.deepEqual(Object.keys(ORDER_CHANNEL_TICKET_LABELS).sort(), [...ORDER_CHANNELS].sort());
  assert.equal(orderChannelLabel("ai_phone"), "AI phone");
  assert.equal(orderChannelTicketLabel("ai_phone"), "AI PHONE");
  assert.equal(orderChannelTicketLabel("online"), "WEBSITE");
  assert.equal(orderChannelTicketLabel("walk_in"), "WALK IN");
  assert.equal(orderChannelTicketLabel(undefined), "WEBSITE");
  assert.equal(orderSourceLabel(null, "ai_phone"), "AI phone order");
  assert.equal(orderSourceLabel(null, "phone"), "Phone order");
  assert.ok(takenByRestaurant("ai_phone"));
  assert.ok(!takenByRestaurant("online"));
});

test("the printed kitchen ticket says AI PHONE", () => {
  const html = buildPassPrntTicketHtml(
    { order_number: "P62-9001", channel: "ai_phone", fulfilment: "pickup", payment_method: "pay_at_store", customer_name: "Jordan", items: [], created_at: 1 },
    new Map(),
    1,
  );
  assert.match(html, /AI PHONE/);
  assert.doesNotMatch(html, /WEBSITE/);
});

withDb("order history filters, labels and counts ai_phone orders", async () => {
  const result = await createOrder(pickup(), ai());
  const cookie = await signedInAs("owner");
  const response = await recordsRoute(
    new Request(`https://order.pizza62.test/api/admin/records?channel=ai_phone&query=${encodeURIComponent(String(result.orderNumber))}`, {
      headers: { cookie },
    }),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    orders: Array<{ order_number: string; channel: string; source: string }>;
    breakdown: Array<{ channel: string; count: number }>;
  };
  assert.equal(body.orders.length, 1);
  assert.equal(body.orders[0].channel, "ai_phone");
  assert.equal(body.orders[0].source, "AI phone order");
  assert.deepEqual(body.breakdown.map((row) => row.channel), ["ai_phone"]);

  const directory = await customersRoute(
    new Request(`https://order.pizza62.test/api/admin/customers?query=9055550177`, { headers: { cookie } }),
  );
  assert.equal(directory.status, 200);
  const customers = (await directory.json()) as { customers: Array<Record<string, unknown>> };
  assert.ok(customers.customers.some((row) => Number(row.ai_phone_count) >= 1), "the directory counts AI phone orders");
});
