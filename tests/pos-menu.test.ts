import assert from "node:assert/strict";
import test, { after } from "node:test";
import { MENU_PRODUCTS, MONDAY_WINGS_PRODUCT_ID, MONDAY_WINGS_AVAILABILITY, withWingStyle } from "@/lib/menu";
import { isWithinWeeklyAvailability, nextOrderSlots } from "@/lib/domain";
process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";
const { getPool, closePool } = await import("@/db/pg-driver");
const { quoteOrder, createOrder } = await import("@/lib/order-service");
const { getSetting } = await import("@/db/runtime");
const { loadPublicCatalog } = await import("@/lib/public-catalog");
const reachable = await getPool().query("SELECT 1").then(() => true).catch(() => false);
after(closePool);

test("Monday dollar wings recur in Toronto and remain pickup-only", () => {
  const product = MENU_PRODUCTS.find(p => p.id === MONDAY_WINGS_PRODUCT_ID)!;
  assert.equal(product.basePriceCents, 100);
  assert.equal(product.deliveryEligible, false);
  assert.equal(product.configuration?.maxQuantity, 40);
  assert.equal(isWithinWeeklyAvailability(MONDAY_WINGS_AVAILABILITY, new Date("2026-09-21T16:00:00Z")), true);
  assert.equal(isWithinWeeklyAvailability(MONDAY_WINGS_AVAILABILITY, new Date("2026-09-22T16:00:00Z")), false);
});
test("every wing product and combo asks for an explicit style, without a price change", () => {
  for (const product of MENU_PRODUCTS) {
    const sections = product.configuration?.sections as Parameters<typeof withWingStyle>[0] | undefined;
    if (!sections?.some(s => s.source === "wing_flavours")) continue;
    assert.deepEqual(sections.find(s => s.id === "wing-style"), { id: "wing-style", label: "Wing style", options: ["Classic (non-breaded)", "Breaded"], min: 1, max: 1 });
    assert.equal(withWingStyle(sections), sections);
  }
});
test("public catalog and ordering exclude staff imports; staff can quote them", { skip: !reachable }, async () => {
  const catalog = await loadPublicCatalog();
  assert.ok(!catalog.products.some(p => p.id === "chicken-burger"));
  assert.ok(!catalog.variations.some(v => v.product_id === "dollar-medium-pizza"));
  const hours = await getSetting<Parameters<typeof nextOrderSlots>[0]["hours"]>("hours");
  const scheduledFor = nextOrderSlots({ now: Date.now(), hours, timeZone: "America/Toronto", leadMinutes: 30, limit: 1 })[0];
  const body = { fulfilment: "pickup" as const, items: [{ productId: "chicken-burger", quantity: 1 }], schedule: { type: "scheduled" as const, scheduledFor } };
  assert.equal((await quoteOrder(body)).ok, false);
  assert.equal((await quoteOrder(body, { staffEntry: true })).ok, true);
  await assert.rejects(createOrder({ ...body, customer: { name: "Test User", phone: "9055550199", email: "test@example.test" }, paymentMethod: "pay_at_store", idempotencyKey: crypto.randomUUID()+crypto.randomUUID() }), /only available at the counter/);
});
test("the 40-wing limit covers different styles and sauces in one cart", { skip: !reachable }, async () => {
  const id = `cap-test-${crypto.randomUUID()}`;
  await getPool().query(`INSERT INTO products (id,category_id,name,slug,description,product_type,base_price_cents,taxable,pickup_eligible,delivery_eligible,promotion_eligible,active,sold_out,setup_required,kitchen_label,configuration_json,display_order,created_at,updated_at) SELECT $1,category_id,name,$1,description,product_type,base_price_cents,taxable,pickup_eligible,delivery_eligible,promotion_eligible,active,sold_out,setup_required,kitchen_label,configuration_json::jsonb - 'availability',display_order,created_at,updated_at FROM products WHERE id=$2`, [id, MONDAY_WINGS_PRODUCT_ID]);
  try {
    const quote = await quoteOrder({ fulfilment: "pickup", items: ["Breaded", "Classic (non-breaded)"].map(style => ({ productId: id, quantity: 21, modifiers: [{ id: "wing-style", values: [style] }, { id: "wing-flavours", values: ["Hot"] }] })) });
    assert.equal(quote.ok, false);
    assert.ok(quote.issues.some(i => /limited to 40/.test(i.message)));
  } finally { await getPool().query("DELETE FROM products WHERE id=$1", [id]); }
});

test("the release restores retired counter IDs once and preserves later owner edits", { skip: !reachable }, async () => {
  const { runDataMigrations } = await import("@/db/runtime");
  const { PostgresDatabase } = await import("@/db/pg-driver");
  const marker = "dataMigration:2026-09-18-restore-loyverse-staff-items";
  const pool = getPool();
  const original = (await pool.query("SELECT active, configuration_json, base_price_cents FROM products WHERE id='chicken-burger'")).rows[0];
  const publicPrice = (await pool.query("SELECT base_price_cents FROM products WHERE id='poutine'")).rows[0].base_price_cents;
  try {
    await pool.query("DELETE FROM settings WHERE key=$1", [marker]);
    await pool.query("UPDATE products SET active=0, configuration_json='{}' WHERE id='chicken-burger'");
    await runDataMigrations(new PostgresDatabase(pool));
    const restored = (await pool.query("SELECT active, configuration_json FROM products WHERE id='chicken-burger'")).rows[0];
    assert.equal(restored.active, 1);
    assert.equal(JSON.parse(restored.configuration_json).staffOnly, true);
    await pool.query("UPDATE products SET base_price_cents=701 WHERE id='chicken-burger'");
    await runDataMigrations(new PostgresDatabase(pool));
    assert.equal((await pool.query("SELECT base_price_cents FROM products WHERE id='chicken-burger'")).rows[0].base_price_cents, 701);
    assert.equal((await pool.query("SELECT base_price_cents FROM products WHERE id='poutine'")).rows[0].base_price_cents, publicPrice);
  } finally {
    await pool.query("UPDATE products SET active=$1, configuration_json=$2, base_price_cents=$3 WHERE id='chicken-burger'", [original.active, original.configuration_json, original.base_price_cents]);
  }
});
