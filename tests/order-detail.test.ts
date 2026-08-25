/**
 * Order detail — everything staff can look back at once an order has left the
 * live board.
 *
 * Before this, order history showed six columns and a total; items, toppings,
 * the delivery address, refunds, the status timeline and who rang in a phone
 * or walk-in order were all in the database and none of it was reachable
 * again. `GET /api/admin/orders?id=` (backed by `lib/order-detail.ts`) is that
 * read. The property worth pinning here, same as order history: phone and
 * email follow `view_customer_contact`, and nothing else on the order does —
 * a viewer without it still sees items, the timeline, refunds and feedback.
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
const { GET: orderDetailRoute } = await import("@/app/api/admin/orders/route");

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
const nextClientIp = () => `192.0.2.${(counter += 1) % 250}-${RUN}`;
const PASSWORD = "Correct Horse Battery Staple 62";

async function signedInAs(role: "owner" | "employee", permissions: string[] = []): Promise<{ cookie: string; staffId: string }> {
  const id = crypto.randomUUID();
  const email = `order-detail-${id}@example.test`;
  const hash = await createPasswordHash(PASSWORD);
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_users (id,email,name,role,password_hash,password_salt,password_iterations,permissions_json,active,created_at,updated_at)
     VALUES ($1,$2,'Detail Tester',$3,$4,$5,$6,$7,1,$8,$8)`,
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
  return { cookie: (response.headers.get("set-cookie") ?? "").split(";")[0], staffId: id };
}

/** A full order: one item with a topping choice, a status event, a refund and a feedback response. */
async function seedFullOrder(): Promise<{ orderId: string }> {
  const orderId = crypto.randomUUID();
  const orderNumber = `P62-D${RUN}-${(counter += 1)}`;
  const now = Date.now();
  await getPool().query(
    `INSERT INTO orders (id,order_number,tracking_token_hash,feedback_token_hash,customer_name,customer_phone,
       customer_email,fulfilment,channel,status,payment_status,payment_method,schedule_type,estimated_for,pricing_json,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'Ada Lovelace','9055550142','ada@example.test','pickup','online','completed','paid','online',
       'asap',$5,'{}',899,0,117,0,0,1016,$5,$5)`,
    [orderId, orderNumber, `h${orderId}`, `f${orderId}`, now],
  );
  const topping = await getPool().query<{ id: string; name: string }>("SELECT id, name FROM toppings LIMIT 1");
  const toppingId = topping.rows[0]?.id;
  await getPool().query(
    `INSERT INTO order_items (id,order_id,product_id,product_name,variation_name,quantity,unit_price_cents,
       line_total_cents,taxable,snapshot_json,instructions,created_at)
     VALUES ($1,$2,'poutine','Poutine',NULL,1,899,899,1,$3,'Extra crispy',$4)`,
    [crypto.randomUUID(), orderId, JSON.stringify(toppingId ? { toppings: [{ toppingId, placement: "whole" }] } : {}), now],
  );
  await getPool().query(
    `INSERT INTO order_events (id,order_id,previous_status,next_status,actor_type,actor_id,note,created_at)
     VALUES ($1,$2,'received','completed','system',NULL,'Order accepted after server validation',$3)`,
    [crypto.randomUUID(), orderId, now],
  );
  const paymentId = crypto.randomUUID();
  await getPool().query(
    `INSERT INTO payments (id,order_id,provider,method,status,amount_cents,currency,idempotency_key,created_at,updated_at)
     VALUES ($1,$2,'clover','online','captured',1016,'CAD',$3,$4,$4)`,
    [paymentId, orderId, `detail-test-${paymentId}`, now],
  );
  await getPool().query(
    `INSERT INTO refunds (id,order_id,payment_id,amount_cents,reason,status,actor_id,created_at,updated_at)
     VALUES ($1,$2,$3,500,'Item was cold','recorded',$4,$5,$5)`,
    [crypto.randomUUID(), orderId, paymentId, crypto.randomUUID(), now],
  );
  await getPool().query(
    `INSERT INTO feedback_responses (id,order_id,overall_rating,answers_json,written_feedback,submitted_at)
     VALUES ($1,$2,4,'{}','Pretty good, a bit cold',$3)`,
    [crypto.randomUUID(), orderId, now],
  );
  return { orderId };
}

const detail = (cookie: string, id: string) =>
  orderDetailRoute(
    new Request(`https://order.pizza62.test/api/admin/orders?id=${encodeURIComponent(id)}`, { headers: { cookie } }),
  );

withDb("returns items, timeline, refunds and feedback in one read", async () => {
  const { cookie } = await signedInAs("owner");
  const { orderId } = await seedFullOrder();

  const response = await detail(cookie, orderId);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { order: Record<string, unknown> };
  const order = body.order;

  assert.equal(order.customer_name, "Ada Lovelace");
  assert.equal(order.customer_email, "ada@example.test");

  const items = order.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0].productName, "Poutine");
  assert.equal(items[0].instructions, "Extra crispy");

  const events = order.events as Array<Record<string, unknown>>;
  assert.ok(events.some((event) => event.next_status === "completed"));

  const refunds = order.refunds as Array<Record<string, unknown>>;
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].amount_cents, 500);
  assert.equal(order.refundedCents, 500);

  const feedback = order.feedback as Record<string, unknown>;
  assert.equal(feedback.overall_rating, 4);
  assert.equal(feedback.written_feedback, "Pretty good, a bit cold");
});

withDb("redacts contact for a viewer without view_customer_contact, but not the rest of the order", async () => {
  const { orderId } = await seedFullOrder();
  const { cookie } = await signedInAs("employee", ["view_orders"]);

  const response = await detail(cookie, orderId);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { order: Record<string, unknown> };
  assert.equal(body.order.customer_phone, undefined);
  assert.equal(body.order.customer_email, undefined);
  assert.equal(body.order.contactRedacted, true);
  // Redaction is contact-only — the rest of the order is still a normal read.
  assert.equal((body.order.items as unknown[]).length, 1);
  assert.equal((body.order.refunds as unknown[]).length, 1);
});

withDb("records who rang in a counter order", async () => {
  const { cookie, staffId } = await signedInAs("owner");
  const orderId = crypto.randomUUID();
  const orderNumber = `P62-D${RUN}-${(counter += 1)}`;
  const now = Date.now();
  await getPool().query(
    `INSERT INTO orders (id,order_number,tracking_token_hash,feedback_token_hash,customer_name,customer_phone,
       customer_email,fulfilment,channel,status,payment_status,payment_method,schedule_type,estimated_for,pricing_json,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'Counter','','','pickup','walk_in','completed','pending_at_store','pay_at_store','asap',
       $5,'{}',899,0,117,0,0,1016,$5,$5)`,
    [orderId, orderNumber, `h${orderId}`, `f${orderId}`, now],
  );
  await getPool().query(
    `INSERT INTO audit_log (id,actor_id,action,target_type,target_id,next_json,created_at)
     VALUES ($1,$2,'order.staff_entry','order',$3,'{}',$4)`,
    [crypto.randomUUID(), staffId, orderId, now],
  );

  const body = (await (await detail(cookie, orderId)).json()) as { order: Record<string, unknown> };
  const takenBy = body.order.takenBy as { name: string | null; at: number } | null;
  assert.ok(takenBy);
  assert.equal(takenBy?.name, "Detail Tester");
});

withDb("404s an order id that does not exist", async () => {
  const { cookie } = await signedInAs("owner");
  const response = await detail(cookie, crypto.randomUUID());
  assert.equal(response.status, 404);
});

withDb("400s a request with no id", async () => {
  const { cookie } = await signedInAs("owner");
  const response = await orderDetailRoute(
    new Request("https://order.pizza62.test/api/admin/orders", { headers: { cookie } }),
  );
  assert.equal(response.status, 400);
});
