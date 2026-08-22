/**
 * Counter and phone order entry.
 *
 * The load-bearing test is the one about spoofing. The whole value of tagging
 * orders by channel is that the owner can trust "47 walk-ins" — and the moment a
 * stranger on the internet can label their own order `walk_in`, that number
 * becomes fiction and so does every decision made from it. So `channel` is a
 * trusted context argument rather than a field on the request body, and this
 * file proves the public endpoint cannot reach it.
 *
 * The other property worth pinning: a counter order goes through `createOrder`,
 * so it is priced, taxed and ticketed identically to a website order. A second
 * pricing implementation at the till is how a restaurant ends up with two sets
 * of books.
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
const { POST: staffOrderRoute } = await import("@/app/api/admin/orders/route");
const { POST: staffActionRoute } = await import("@/app/api/admin/actions/route");
const { POST: publicOrderRoute } = await import("@/app/api/orders/route");
const { getSetting } = await import("@/db/runtime");
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

const RUN = crypto.randomUUID().slice(0, 8);
let counter = 0;
const nextClientIp = () => `198.51.100.${(counter += 1) % 250}-${RUN}`;
const nextKey = () => `staff-${RUN}-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const PASSWORD = "Correct Horse Battery Staple 62";

// The store is only open part of the day, so every order here is scheduled into
// the next open slot rather than depending on when the suite happens to run.
const hours = reachable
  ? await getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours")
  : [];
const SLOT = reachable
  ? nextOrderSlots({ now: Date.now(), hours, timeZone: "America/Toronto", leadMinutes: 30, limit: 1 })[0]
  : 0;
const schedule = { type: "scheduled" as const, scheduledFor: SLOT };

async function signedInAs(role: "owner" | "employee", permissions: string[] = []): Promise<string> {
  const id = crypto.randomUUID();
  const email = `till-${id}@example.test`;
  const hash = await createPasswordHash(PASSWORD);
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_users (id,email,name,role,password_hash,password_salt,password_iterations,permissions_json,active,created_at,updated_at)
     VALUES ($1,$2,'Till Tester',$3,$4,$5,$6,$7,1,$8,$8)`,
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

const staffOrder = (cookie: string, body: unknown) =>
  staffOrderRoute(
    new Request("https://order.pizza62.test/api/admin/orders", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const staffAction = (cookie: string, body: unknown) =>
  staffActionRoute(
    new Request("https://order.pizza62.test/api/admin/actions", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const cart = { fulfilment: "pickup", items: [{ productId: "poutine", quantity: 2 }], paymentMethod: "pay_at_store", schedule };

const channelOf = async (orderNumber: string) =>
  (
    await getPool().query<{ channel: string }>("SELECT channel FROM orders WHERE order_number = $1", [orderNumber])
  ).rows[0].channel;

// --- the property the whole feature rests on --------------------------------

withDb("a customer cannot label their own order as a walk-in", async () => {
  // If they could, "47 walk-ins this week" is fiction, and so is every decision
  // taken from it.
  const response = await publicOrderRoute(
    new Request("https://order.pizza62.test/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": nextClientIp() },
      body: JSON.stringify({
        ...cart,
        channel: "walk_in",
        idempotencyKey: nextKey(),
        customer: { name: "Sneaky Pete", phone: "905-555-0100", email: "pete@example.test" },
      }),
    }),
  );
  assert.equal(response.status, 201);
  const result = (await response.json()) as { orderNumber: string };
  assert.equal(await channelOf(result.orderNumber), "online", "the request body must not be able to set the channel");
});

withDb("refuses an employee without the override permission", async () => {
  const cookie = await signedInAs("employee", ["view_orders"]);
  const response = await staffOrder(cookie, { ...cart, channel: "walk_in", idempotencyKey: nextKey(), customer: { name: "Counter" } });
  assert.equal(response.status, 403);
});

withDb("refuses an unauthenticated caller", async () => {
  const response = await staffOrderRoute(
    new Request("https://order.pizza62.test/api/admin/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...cart, channel: "walk_in", idempotencyKey: nextKey(), customer: { name: "Counter" } }),
    }),
  );
  assert.equal(response.status, 401);
});

withDb("refuses an unrecognised channel rather than defaulting it", async () => {
  // Defaulting would silently file a mistyped channel as a website order, which
  // is the failure mode that is hardest to notice later.
  const cookie = await signedInAs("owner");
  const response = await staffOrder(cookie, { ...cart, channel: "carrier-pigeon", idempotencyKey: nextKey(), customer: { name: "Counter" } });
  assert.equal(response.status, 400);
});

// --- taking an order ---------------------------------------------------------

withDb("records a walk-in with only a name", async () => {
  // A customer buying two slices has not given an email address. Demanding one
  // produces `x@x.com` typed by staff to get past the form, which is worse than
  // an empty field because it looks like data.
  const cookie = await signedInAs("owner");
  const response = await staffOrder(cookie, {
    ...cart,
    channel: "walk_in",
    idempotencyKey: nextKey(),
    customer: { name: "Blue cap" },
  });
  assert.equal(response.status, 201);
  const result = (await response.json()) as { orderNumber: string; orderId: string };
  assert.equal(await channelOf(result.orderNumber), "walk_in");

  // And no confirmation is queued to nowhere — one permanently failed row per
  // counter order would bury the real delivery failures.
  const outbox = await getPool().query<{ kind: string }>(
    "SELECT kind FROM notification_outbox WHERE payload_json::jsonb->>'orderId' = $1",
    [result.orderId],
  );
  const kinds = outbox.rows.map((row) => row.kind);
  assert.ok(!kinds.includes("customer_order_confirmation"), "nothing addressed to a customer with no address");
  assert.ok(!kinds.includes("feedback_request"));
  // The restaurant alert is not addressed to the customer, so it still queues.
  assert.ok(kinds.includes("restaurant_new_order"));
});

withDb("still emails a phone customer who gives an address", async () => {
  const cookie = await signedInAs("owner");
  const response = await staffOrder(cookie, {
    ...cart,
    channel: "phone",
    idempotencyKey: nextKey(),
    customer: { name: "Ada", phone: "905-555-0142", email: "ada@example.test" },
  });
  assert.equal(response.status, 201);
  const result = (await response.json()) as { orderNumber: string; orderId: string };
  assert.equal(await channelOf(result.orderNumber), "phone");
  const outbox = await getPool().query<{ kind: string }>(
    "SELECT kind FROM notification_outbox WHERE payload_json::jsonb->>'orderId' = $1",
    [result.orderId],
  );
  assert.ok(outbox.rows.map((row) => row.kind).includes("customer_order_confirmation"));
});

withDb("prices a counter order exactly like a website order", async () => {
  // Same cart, both routes. If these ever diverge the day's HST stops adding up.
  const cookie = await signedInAs("owner");
  const staffResponse = await staffOrder(cookie, {
    ...cart,
    channel: "walk_in",
    idempotencyKey: nextKey(),
    customer: { name: "Counter" },
  });
  const staffResult = (await staffResponse.json()) as { orderNumber: string };

  const webResponse = await publicOrderRoute(
    new Request("https://order.pizza62.test/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": nextClientIp() },
      body: JSON.stringify({
        ...cart,
        idempotencyKey: nextKey(),
        customer: { name: "Website", phone: "905-555-0143", email: "web@example.test" },
      }),
    }),
  );
  const webResult = (await webResponse.json()) as { orderNumber: string };

  const rows = await getPool().query<{ order_number: string; subtotal_cents: number; tax_cents: number; total_cents: number }>(
    "SELECT order_number, subtotal_cents, tax_cents, total_cents FROM orders WHERE order_number = ANY($1)",
    [[staffResult.orderNumber, webResult.orderNumber]],
  );
  assert.equal(rows.rows.length, 2);
  const [first, second] = rows.rows;
  assert.equal(first.subtotal_cents, second.subtotal_cents);
  assert.equal(first.tax_cents, second.tax_cents);
  assert.equal(first.total_cents, second.total_cents);
});

withDb("records who rang it in", async () => {
  const cookie = await signedInAs("owner");
  const response = await staffOrder(cookie, {
    ...cart,
    channel: "walk_in",
    idempotencyKey: nextKey(),
    customer: { name: "Counter" },
  });
  const result = (await response.json()) as { orderId: string };
  const audit = await getPool().query<{ action: string; actor_id: string }>(
    "SELECT action, actor_id FROM audit_log WHERE target_type = 'order' AND target_id = $1 AND action = 'order.staff_entry'",
    [result.orderId],
  );
  // An order that appeared at the counter with no record of who took it is the
  // first thing a cash-handling audit asks about.
  assert.equal(audit.rows.length, 1);
  assert.ok(audit.rows[0].actor_id);
});

withDb("quotes without creating anything", async () => {
  const cookie = await signedInAs("owner");
  const before = await getPool().query<{ count: number }>("SELECT COUNT(*) AS count FROM orders WHERE channel = 'walk_in'");
  const response = await staffOrder(cookie, { ...cart, channel: "walk_in", quoteOnly: true, customer: { name: "Counter" } });
  assert.equal(response.status, 200);
  const quote = (await response.json()) as { totals: { totalCents: number } };
  assert.ok(quote.totals.totalCents > 0, "the till needs the total before it takes the money");
  const after = await getPool().query<{ count: number }>("SELECT COUNT(*) AS count FROM orders WHERE channel = 'walk_in'");
  assert.equal(before.rows[0].count, after.rows[0].count);
});

// --- phone deliveries -------------------------------------------------------
//
// The till was pickup-only, which meant the one thing the phone is actually used
// for could not be rung in at all: the address, the delivery fee and the HST on
// it stayed on paper and out of the books. These pin the two properties that
// make taking it here safe — the address goes through the same validation a
// website delivery does, and the driver is never sent out without a number.

withDb("takes a phone delivery with an address, priced like a website delivery", async () => {
  const cookie = await signedInAs("owner");
  const response = await staffOrder(cookie, {
    fulfilment: "delivery",
    items: [{ productId: "poutine", quantity: 3 }],
    paymentMethod: "pay_at_store",
    schedule,
    channel: "phone",
    idempotencyKey: nextKey(),
    customer: { name: "Ada", phone: "905-555-0142", email: "ada@example.test" },
    address: { line1: "55 Parkdale Ave N", unit: "2", city: "Hamilton", province: "ON", postalCode: "L8H 5W7" },
  });
  assert.equal(response.status, 201);
  const result = (await response.json()) as { orderNumber: string };

  const order = (
    await getPool().query<{ fulfilment: string; address_json: string; delivery_fee_cents: number; channel: string }>(
      "SELECT fulfilment, address_json, delivery_fee_cents, channel FROM orders WHERE order_number = $1",
      [result.orderNumber],
    )
  ).rows[0];
  assert.equal(order.fulfilment, "delivery");
  assert.equal(order.channel, "phone");
  // The fee is charged, which is the whole reason these could not stay on paper.
  assert.equal(Number(order.delivery_fee_cents), 350);
  const address = JSON.parse(order.address_json) as Record<string, string>;
  assert.equal(address.line1, "55 Parkdale Ave N");
  assert.equal(address.unit, "2");
  // Normalised by the same code the website uses — postal code spaced, city and
  // province fixed to the one delivery area.
  assert.equal(address.postalCode, "L8H 5W7");
  assert.equal(address.city, "Hamilton");
});

withDb("refuses a delivery with no phone number for the driver", async () => {
  // Staff entry deliberately does not require contact details — a walk-in has
  // given none. A delivery is the one case that cannot do without one.
  const cookie = await signedInAs("owner");
  const response = await staffOrder(cookie, {
    fulfilment: "delivery",
    items: [{ productId: "poutine", quantity: 3 }],
    paymentMethod: "pay_at_store",
    schedule,
    channel: "phone",
    idempotencyKey: nextKey(),
    customer: { name: "Ada" },
    address: { line1: "55 Parkdale Ave N", city: "Hamilton", province: "ON", postalCode: "L8H 5W7" },
  });
  assert.equal(response.status, 400);
  assert.match(String((await response.json()).error), /phone number/i);
});

withDb("still refuses a delivery address outside the area, even from the till", async () => {
  // The relaxation is about who may take payment at the door, not about where
  // the restaurant delivers. A counter cannot key past the radius check.
  const cookie = await signedInAs("owner");
  const response = await staffOrder(cookie, {
    fulfilment: "delivery",
    items: [{ productId: "poutine", quantity: 3 }],
    paymentMethod: "pay_at_store",
    schedule,
    channel: "phone",
    idempotencyKey: nextKey(),
    customer: { name: "Ada", phone: "905-555-0142" },
    address: { line1: "1 Yonge Street", city: "Toronto", province: "ON", postalCode: "M5E 1E5" },
  });
  assert.equal(response.status, 400);
});

// --- telling the customer the order moved -----------------------------------

withDb("queues an email when the kitchen marks an order ready, and not before", async () => {
  // The customer's interest in an order does not end at the confirmation. But
  // only the steps they would otherwise phone the counter about are mailed:
  // `preparing` is the kitchen's business, and mailing it turns a normal order
  // into four emails. The message carries the status it was queued *with*, so a
  // retry cannot deliver "ready for pickup" after the bag has been collected.
  const cookie = await signedInAs("owner");
  const created = await staffOrder(cookie, {
    ...cart,
    channel: "phone",
    idempotencyKey: nextKey(),
    customer: { name: "Ada", phone: "905-555-0142", email: "ada@example.test" },
  });
  assert.equal(created.status, 201);
  const { orderId } = (await created.json()) as { orderId: string };

  for (const status of ["preparing", "ready_for_pickup"]) {
    const moved = await staffAction(cookie, { action: "order.status", orderId, status });
    assert.equal(moved.status, 200, `could not move the order to ${status}`);
  }

  const queued = await getPool().query<{ recipient: string; payload_json: string }>(
    `SELECT recipient, payload_json FROM notification_outbox
     WHERE kind = 'customer_status_update' AND payload_json::jsonb->>'orderId' = $1
     ORDER BY created_at`,
    [orderId],
  );
  assert.deepEqual(
    queued.rows.map((row) => (JSON.parse(row.payload_json) as { status: string }).status),
    ["ready_for_pickup"],
  );
  assert.ok(queued.rows.every((row) => row.recipient === "ada@example.test"));
});

withDb("queues no status email for a counter order with no address to send it to", async () => {
  // A walk-in has given no email. Queuing a message to nowhere produces one
  // permanently failed row per counter order, in the exact place someone has to
  // look to find a real delivery failure.
  const cookie = await signedInAs("owner");
  const created = await staffOrder(cookie, {
    ...cart,
    channel: "walk_in",
    idempotencyKey: nextKey(),
    customer: { name: "Counter" },
  });
  const { orderId } = (await created.json()) as { orderId: string };
  for (const status of ["preparing", "ready_for_pickup"]) {
    assert.equal((await staffAction(cookie, { action: "order.status", orderId, status })).status, 200);
  }

  const queued = await getPool().query(
    `SELECT 1 FROM notification_outbox
     WHERE kind = 'customer_status_update' AND payload_json::jsonb->>'orderId' = $1`,
    [orderId],
  );
  assert.equal(queued.rowCount, 0);
});
