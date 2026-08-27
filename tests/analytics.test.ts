import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { createPasswordHash } = await import("@/lib/auth");
const { POST: loginRoute } = await import("@/app/api/auth/login/route");
const { GET: analyticsRoute } = await import("@/app/api/admin/analytics/route");

const reachable = await getPool().query("SELECT 1").then(() => true).catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const PASSWORD = "Correct Horse Battery Staple 62";

async function ownerCookie(): Promise<string> {
  const id = crypto.randomUUID();
  const email = `analytics-${id}@example.test`;
  const hash = await createPasswordHash(PASSWORD);
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_users (id,email,name,role,password_hash,password_salt,password_iterations,permissions_json,active,created_at,updated_at)
     VALUES ($1,$2,'Analytics Tester','owner',$3,$4,$5,'[]',1,$6,$6)`,
    [id, email, hash.hash, hash.salt, hash.iterations, now],
  );
  const response = await loginRoute(new Request("https://order.pizza62.test/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-azure-clientip": `192.0.2.${Math.floor(Math.random() * 200) + 1}` },
    body: JSON.stringify({ email, password: PASSWORD }),
  }));
  assert.equal(response.status, 200);
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

const analytics = async (cookie: string) => {
  const response = await analyticsRoute(new Request("https://order.pizza62.test/api/admin/analytics?days=7", { headers: { cookie } }));
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as {
    totals: { grossSalesCents: number; taxableSalesCents: number; nonTaxableSalesCents: number; taxCents: number; finalTotalCents: number };
    topProducts: Array<{ name: string; nonTaxableSalesCents: number }>;
    categorySales: Array<{ name: string; salesCents: number; taxableSalesCents: number; nonTaxableSalesCents: number }>;
  };
};

withDb("reports tax-exempt pickup-special sales in order, product, and category totals", async () => {
  const cookie = await ownerCookie();
  const before = await analytics(cookie);
  const beforeCategory = before.categorySales.find((row) => row.name === "Pickup Specials");

  const orderId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const now = Date.now();
  const pricing = JSON.stringify({
    menuSubtotalCents: 900,
    discountCents: 0,
    discountedMenuSubtotalCents: 900,
    taxableSubtotalCents: 0,
    nonTaxableSubtotalCents: 900,
    taxCents: 0,
    deliveryFeeCents: 0,
    tipCents: 0,
    totalCents: 900,
  });
  await getPool().query(
    `INSERT INTO orders (id,order_number,tracking_token_hash,feedback_token_hash,customer_name,customer_phone,
       customer_email,fulfilment,channel,status,payment_status,payment_method,schedule_type,estimated_for,pricing_json,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'Analytics Guest','9055550162','guest@example.test','pickup','walk_in','completed','paid','online','asap',
       $5,$6,900,0,0,0,0,900,$5,$5)`,
    [orderId, `P62-A${crypto.randomUUID().slice(0, 8)}`, `h${orderId}`, `f${orderId}`, now, pricing],
  );
  await getPool().query(
    `INSERT INTO order_items (id,order_id,product_id,product_name,variation_name,quantity,unit_price_cents,
       line_total_cents,taxable,snapshot_json,instructions,created_at)
     VALUES ($1,$2,'slice-combo','Slice Combo',NULL,2,450,900,0,'{}',NULL,$3)`,
    [itemId, orderId, now],
  );

  const after = await analytics(cookie);
  assert.equal(after.totals.grossSalesCents - before.totals.grossSalesCents, 900);
  assert.equal(after.totals.taxableSalesCents - before.totals.taxableSalesCents, 0);
  assert.equal(after.totals.nonTaxableSalesCents - before.totals.nonTaxableSalesCents, 900);
  assert.equal(after.totals.taxCents - before.totals.taxCents, 0);
  assert.equal(after.totals.finalTotalCents - before.totals.finalTotalCents, 900);

  const afterCategory = after.categorySales.find((row) => row.name === "Pickup Specials");
  assert.ok(afterCategory);
  assert.equal(afterCategory.salesCents - (beforeCategory?.salesCents ?? 0), 900);
  assert.equal(afterCategory.taxableSalesCents - (beforeCategory?.taxableSalesCents ?? 0), 0);
  assert.equal(afterCategory.nonTaxableSalesCents - (beforeCategory?.nonTaxableSalesCents ?? 0), 900);
  const slice = after.topProducts.find((row) => row.name === "Slice Combo");
  assert.ok(slice, "Slice Combo should appear in product sales reporting");
  assert.ok(slice.nonTaxableSalesCents >= 900);
});
