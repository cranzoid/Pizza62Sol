/**
 * Order history filters and the CSV export (H-20).
 *
 * History was a hard-capped 100 rows with no date range and no export, so "how
 * did last month go", "how many were delivery" and "reconcile this against the
 * bank" were all unanswerable.
 *
 * Two of these tests are about safety rather than features:
 *
 * **Formula injection.** Excel and Sheets evaluate a cell beginning `=`, `+`,
 * `-` or `@` when the file is opened. A customer who types a formula into a
 * delivery note gets it executed on the owner's machine. Quoting does not
 * prevent that; a leading apostrophe does.
 *
 * **Redaction survives the export.** `view_customer_contact` gates phone and
 * email on screen. If the CSV ignored it, the export would simply be the way
 * around the permission.
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
const { GET: recordsRoute } = await import("@/app/api/admin/records/route");

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
  const email = `export-${id}@example.test`;
  const hash = await createPasswordHash(PASSWORD);
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_users (id,email,name,role,password_hash,password_salt,password_iterations,permissions_json,active,created_at,updated_at)
     VALUES ($1,$2,'Export Tester',$3,$4,$5,$6,$7,1,$8,$8)`,
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

/** Seeds one order, returning its number so assertions can be scoped to it. */
async function seedOrder(overrides: {
  customerName?: string;
  channel?: string;
  fulfilment?: string;
  createdAt?: number;
  totalCents?: number;
} = {}): Promise<string> {
  const id = crypto.randomUUID();
  const orderNumber = `P62-X${RUN}-${(counter += 1)}`;
  const now = overrides.createdAt ?? Date.now();
  const fulfilment = overrides.fulfilment ?? "pickup";
  await getPool().query(
    `INSERT INTO orders (id,order_number,tracking_token_hash,feedback_token_hash,customer_name,customer_phone,
       customer_email,fulfilment,channel,status,payment_status,payment_method,schedule_type,estimated_for,pricing_json,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,address_json,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'9055550142','ada@example.test',$6,$7,'completed','paid','online','asap',
       $8,'{}',899,0,117,0,0,$9,$10,$8,$8)`,
    [
      id,
      orderNumber,
      `h${id}`,
      `f${id}`,
      overrides.customerName ?? "Ada Lovelace",
      fulfilment,
      overrides.channel ?? "online",
      now,
      overrides.totalCents ?? 1016,
      fulfilment === "delivery" ? JSON.stringify({ line1: "1 Test St" }) : null,
    ],
  );
  return orderNumber;
}

const records = (cookie: string, params: Record<string, string>) =>
  recordsRoute(
    new Request(`https://order.pizza62.test/api/admin/records?${new URLSearchParams(params)}`, {
      headers: { cookie },
    }),
  );

withDb("exports a CSV with a filename and no-store caching", async () => {
  const cookie = await signedInAs("owner");
  const orderNumber = await seedOrder();
  const response = await records(cookie, { format: "csv", query: orderNumber });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename="pizza62-orders-/);
  // A file of customer contact details must not sit in a proxy or disk cache.
  assert.equal(response.headers.get("cache-control"), "no-store");

  const csv = await response.text();
  assert.ok(csv.includes(orderNumber));
  assert.ok(csv.split("\r\n")[0].includes('"Order"'), "the first row is a header");
  // Money in decimal dollars — the export's next stop is a spreadsheet.
  assert.ok(csv.includes('"10.16"'), "totals are exported as dollars, not cents");
});

withDb("neutralises a spreadsheet formula in customer data", async () => {
  // The attack: a customer types this into their name or a delivery note, and
  // Excel executes it when the owner opens the export.
  const cookie = await signedInAs("owner");
  const hostile = `=HYPERLINK("http://evil.test","click")`;
  const orderNumber = await seedOrder({ customerName: hostile });

  const csv = await (await records(cookie, { format: "csv", query: orderNumber })).text();
  const line = csv.split("\r\n").find((row) => row.includes(orderNumber));
  assert.ok(line);
  assert.ok(line.includes(`"'=HYPERLINK`), "a leading = must be escaped with an apostrophe");
  assert.ok(!line.includes(`"=HYPERLINK`), "the raw formula must not survive");
});

withDb("keeps contact redaction in the file, not just on screen", async () => {
  const orderNumber = await seedOrder();

  const withContact = await signedInAs("owner");
  const full = await (await records(withContact, { format: "csv", query: orderNumber })).text();
  assert.ok(full.includes("ada@example.test"));

  // Can see orders and export them, but not customer contact details.
  const withoutContact = await signedInAs("employee", ["view_orders", "view_analytics"]);
  const redacted = await (await records(withoutContact, { format: "csv", query: orderNumber })).text();
  assert.ok(!redacted.includes("ada@example.test"), "the export must not be a way around the permission");
  assert.ok(redacted.includes('"redacted"'));
});

withDb("refuses to export to someone who may only view orders", async () => {
  const cookie = await signedInAs("employee", ["view_orders"]);
  const response = await records(cookie, { format: "csv" });
  assert.equal(response.status, 403);
});

withDb("filters by channel and reports the split for the whole range", async () => {
  const cookie = await signedInAs("owner");
  const marker = `P62-X${RUN}`;
  await seedOrder({ channel: "walk_in", fulfilment: "pickup" });
  await seedOrder({ channel: "walk_in", fulfilment: "pickup" });
  await seedOrder({ channel: "phone", fulfilment: "delivery" });

  const response = await records(cookie, { query: marker, channel: "walk_in" });
  const body = (await response.json()) as {
    orders: Array<Record<string, unknown>>;
    total: number;
    breakdown: Array<{ channel: string; count: number }>;
  };
  assert.ok(body.orders.every((order) => order.channel === "walk_in"));
  assert.equal(body.total, 2);
  // The breakdown describes the filtered set, so filtering to walk-in leaves
  // only walk-in in it.
  assert.deepEqual(
    body.breakdown.map((entry) => entry.channel),
    ["walk_in"],
  );
});

withDb("counts the whole result set, not the page", async () => {
  // The old view was capped at 100 rows with no total, so an owner had no way to
  // know whether they were looking at everything.
  const cookie = await signedInAs("owner");
  const marker = `P62-X${RUN}`;
  const response = await records(cookie, { query: marker });
  const body = (await response.json()) as { total: number; orders: unknown[]; pageSize: number };
  assert.ok(body.total >= body.orders.length);
  assert.equal(body.pageSize, 100);
});

withDb("excludes orders outside the requested dates", async () => {
  const cookie = await signedInAs("owner");
  const longAgo = Date.now() - 400 * 86_400_000;
  const old = await seedOrder({ createdAt: longAgo });
  const recent = await seedOrder();

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

  const body = (await (await records(cookie, { query: `P62-X${RUN}`, from: today })).json()) as {
    orders: Array<Record<string, unknown>>;
  };
  const numbers = body.orders.map((order) => order.order_number);
  assert.ok(numbers.includes(recent), "today's order is inside a range starting today");
  assert.ok(!numbers.includes(old), "an order from last year is not");
});
