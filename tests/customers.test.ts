/**
 * The customer directory.
 *
 * There is no populated `customers` table — `orders.customer_id` is never
 * written by `createOrder` — so the directory in
 * `app/api/admin/customers/route.ts` is derived from `orders`, grouped by a
 * normalised email or, failing that, a digits-only phone. The properties worth
 * pinning:
 *
 * **Grouping actually groups.** Two orders from the same email collapse into
 * one row with the right totals, not two rows nobody would recognise as the
 * same person.
 *
 * **A counter order with neither** (the till's "Counter" default, no phone, no
 * email) has no identity to group by and must not appear as a customer — a
 * directory entry with nothing to contact is not a customer, it is noise.
 *
 * **Access is gated at the door.** Unlike order history, which redacts
 * phone/email per row, this whole screen's reason to exist is contact
 * information, so it requires `view_customer_contact` outright rather than
 * showing redacted rows.
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
const { GET: customersRoute } = await import("@/app/api/admin/customers/route");

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

async function signedInAs(role: "owner" | "employee", permissions: string[] = []): Promise<string> {
  const id = crypto.randomUUID();
  const email = `customers-${id}@example.test`;
  const hash = await createPasswordHash(PASSWORD);
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_users (id,email,name,role,password_hash,password_salt,password_iterations,permissions_json,active,created_at,updated_at)
     VALUES ($1,$2,'Directory Tester',$3,$4,$5,$6,$7,1,$8,$8)`,
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

/** Seeds one order with the given identity, returning its id and number. */
async function seedOrder(overrides: {
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  status?: string;
  paymentStatus?: string;
  paymentMethod?: string;
  totalCents?: number;
} = {}): Promise<{ id: string; orderNumber: string }> {
  const id = crypto.randomUUID();
  const orderNumber = `P62-C${RUN}-${(counter += 1)}`;
  const now = Date.now();
  await getPool().query(
    `INSERT INTO orders (id,order_number,tracking_token_hash,feedback_token_hash,customer_name,customer_phone,
       customer_email,fulfilment,channel,status,payment_status,payment_method,schedule_type,estimated_for,pricing_json,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pickup','online',$8,$9,$10,'asap',$11,'{}',899,0,117,0,0,$12,$11,$11)`,
    [
      id,
      orderNumber,
      `h${id}`,
      `f${id}`,
      overrides.customerName ?? "Ada Lovelace",
      overrides.customerPhone ?? "9055550142",
      overrides.customerEmail ?? "ada@example.test",
      overrides.status ?? "completed",
      overrides.paymentStatus ?? "paid",
      overrides.paymentMethod ?? "online",
      now,
      overrides.totalCents ?? 1016,
    ],
  );
  return { id, orderNumber };
}

const list = (cookie: string, params: Record<string, string> = {}) =>
  customersRoute(
    new Request(`https://order.pizza62.test/api/admin/customers?${new URLSearchParams(params)}`, { headers: { cookie } }),
  );

withDb("groups repeat orders from the same email into one customer", async () => {
  const cookie = await signedInAs("owner");
  const email = `grouped-${crypto.randomUUID()}@example.test`;
  await seedOrder({ customerEmail: email, totalCents: 1000 });
  await seedOrder({ customerEmail: email, totalCents: 2000 });
  await seedOrder({ customerEmail: email, totalCents: 3000, status: "cancelled", paymentStatus: "failed" });

  const body = (await (await list(cookie, { query: email })).json()) as { customers: Array<Record<string, unknown>> };
  assert.equal(body.customers.length, 1, "one email is one customer, however many orders it placed");
  const [customer] = body.customers;
  assert.equal(customer.order_count, 3);
  // The cancelled order counts toward order_count but not toward revenue.
  assert.equal(customer.lifetime_cents, 3000);
  assert.equal(customer.customer_key, `email:${email}`);
});

withDb("groups by phone when no email was given", async () => {
  const cookie = await signedInAs("owner");
  // Digits derived from a fresh UUID rather than the incrementing counter: the
  // counter restarts at 0 every process, so a plain "905555" + counter would
  // regenerate the exact same phone number on every run and collide with rows
  // this same test left behind in the shared, persistent test database.
  const phone = `9${crypto.randomUUID().replace(/-/g, "").split("").map((char) => parseInt(char, 16) % 10).join("").slice(0, 9)}`;
  await seedOrder({ customerPhone: phone, customerEmail: "" });
  await seedOrder({ customerPhone: `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`, customerEmail: "" });

  const body = (await (await list(cookie, { query: phone })).json()) as { customers: Array<Record<string, unknown>> };
  assert.equal(body.customers.length, 1, "the same digits under different formatting is one customer");
  assert.equal(body.customers[0].order_count, 2);
  assert.equal(body.customers[0].customer_key, `phone:${phone}`);
});

withDb("excludes a counter order with neither a phone nor an email", async () => {
  const cookie = await signedInAs("owner");
  const marker = `nobody-${crypto.randomUUID()}`;
  await seedOrder({ customerName: marker, customerPhone: "", customerEmail: "" });

  const body = (await (await list(cookie, { query: marker })).json()) as { customers: Array<Record<string, unknown>> };
  assert.equal(body.customers.length, 0, "an order with no identity is not a customer");
});

withDb("refuses the directory to staff without view_customer_contact", async () => {
  const cookie = await signedInAs("employee", ["view_orders", "view_analytics"]);
  const response = await list(cookie);
  assert.equal(response.status, 403);
});

withDb("allows the directory for staff with view_customer_contact alone", async () => {
  const cookie = await signedInAs("employee", ["view_orders", "view_customer_contact"]);
  const response = await list(cookie);
  assert.equal(response.status, 200);
});

withDb("looks up one customer's full order list by key", async () => {
  const cookie = await signedInAs("owner");
  const email = `lookup-${crypto.randomUUID()}@example.test`;
  const first = await seedOrder({ customerEmail: email, totalCents: 500 });
  const second = await seedOrder({ customerEmail: email, totalCents: 700 });

  const body = (await (await list(cookie, { key: `email:${email}` })).json()) as {
    customer: { orderCount: number; lifetimeCents: number; orders: Array<Record<string, unknown>> };
  };
  assert.equal(body.customer.orderCount, 2);
  assert.equal(body.customer.lifetimeCents, 1200);
  const numbers = body.customer.orders.map((order) => order.order_number);
  assert.ok(numbers.includes(first.orderNumber));
  assert.ok(numbers.includes(second.orderNumber));
});

withDb("404s a key with no matching orders", async () => {
  const cookie = await signedInAs("owner");
  const response = await list(cookie, { key: "email:nobody-here@example.test" });
  assert.equal(response.status, 404);
});

withDb("exports a CSV, gated on view_analytics", async () => {
  const withAnalytics = await signedInAs("owner");
  const marker = `export-${crypto.randomUUID()}@example.test`;
  await seedOrder({ customerEmail: marker });
  const response = await list(withAnalytics, { format: "csv", query: marker });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/csv/);
  const csv = await response.text();
  assert.ok(csv.includes(marker));

  const withoutAnalytics = await signedInAs("employee", ["view_orders", "view_customer_contact"]);
  const refused = await list(withoutAnalytics, { format: "csv" });
  assert.equal(refused.status, 403);
});

withDb("neutralises a spreadsheet formula in a customer's name", async () => {
  const cookie = await signedInAs("owner");
  const hostile = `=HYPERLINK("http://evil.test","click")`;
  const marker = `formula-${crypto.randomUUID()}@example.test`;
  await seedOrder({ customerName: hostile, customerEmail: marker });

  const csv = await (await list(cookie, { format: "csv", query: marker })).text();
  const line = csv.split("\r\n").find((row) => row.includes(marker));
  assert.ok(line);
  assert.ok(line.includes(`"'=HYPERLINK`), "a leading = must be escaped with an apostrophe");
  assert.ok(!line.includes(`"=HYPERLINK`), "the raw formula must not survive");
});
