import assert from "node:assert/strict";
import test, { after } from "node:test";
import { inspectOrderingRelease, applyOrderingRelease } from "@/lib/ordering-release";
import { MENU_PRODUCTS, PIZZA_BY_SIZE_PRODUCT_IDS } from "@/lib/menu";
import { nextOrderSlots, type ModifierSection, pricePizza } from "@/lib/domain";
import { snapshotDetails, totalRows } from "@/lib/order-presentation";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";
const { getPool, closePool } = await import("@/db/pg-driver");
const { getSetting } = await import("@/db/runtime");
const { quoteOrder, createOrder } = await import("@/lib/order-service");
const { loadPublicCatalog } = await import("@/lib/public-catalog");
const reachable = await getPool().query("SELECT 1").then(() => true).catch(() => false);
after(closePool);
const withDb = (name: string, body: () => Promise<void>) => test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);
async function inspect() {
  const client = await getPool().connect();
  try { return await inspectOrderingRelease(client); } finally { client.release(); }
}
async function schedule() {
  const hours = await getSetting<Parameters<typeof nextOrderSlots>[0]["hours"]>("hours");
  return { type: "scheduled" as const, scheduledFor: nextOrderSlots({ now: Date.now(), hours, timeZone: "America/Toronto", leadMinutes: 45, limit: 1 })[0] };
}
const common = { fulfilment: "pickup" as const, paymentMethod: "pay_at_store" as const, tip: { type: "none" as const }, customer: { name: "Ordering QA", phone: "905-555-0101", email: "qa@example.test" } };

withDb("targeted release repairs five records, preserves owner fields, repeats safely and rolls back", async () => {
  const pool = getPool();
  const original = (await pool.query("SELECT active, configuration_json FROM products WHERE id = 'medium-pizza'")).rows[0];
  const ops = (await pool.query("SELECT value_json FROM settings WHERE key = 'operations'")).rows[0];
  const oldCatalog = await loadPublicCatalog();
  await pool.query("UPDATE products SET active = 0, configuration_json = $1 WHERE id = 'medium-pizza'", [JSON.stringify({ ...JSON.parse(original.configuration_json), staffOnly: true, ownerNote: "Keep my crust choices" })]);
  await pool.query("UPDATE settings SET value_json = $1 WHERE key = 'operations'", [JSON.stringify({ ...JSON.parse(ops.value_json), halfToppingUnitsBps: 10000, ownerValue: 62 })]);
  const before = await inspect();
  try {
    assert.equal(before.observed.products.length, 5);
    assert.ok(before.changes.every((entry) => ["settings", "categories", "products", "product_variations"].includes(entry.table)));
    assert.equal(await applyOrderingRelease(pool, before), "applied");
    assert.equal(await applyOrderingRelease(pool, before), "already applied");
    const catalog = await loadPublicCatalog();
    assert.equal(catalog.categories.find((entry) => entry.id === "build-your-own")?.name, "Delivery pizzas");
    for (const id of PIZZA_BY_SIZE_PRODUCT_IDS) {
      const product = catalog.products.find((entry) => entry.id === id)!;
      assert.ok(product);
      assert.equal(product.base_price_cents, MENU_PRODUCTS.find((entry) => entry.id === id)!.basePriceCents);
      assert.equal(product.pickup_eligible, 0);
      assert.equal(product.delivery_eligible, 1);
    }
    assert.equal(catalog.products.find((entry) => entry.id === "medium-pizza")!.configuration.ownerNote, "Keep my crust choices");
    const operations = await getSetting<Record<string, unknown>>("operations");
    assert.equal(operations.halfToppingUnitsBps, 5000);
    assert.equal(operations.ownerValue, 62);
    assert.deepEqual(catalog.products.filter((entry) => !PIZZA_BY_SIZE_PRODUCT_IDS.includes(entry.id)), oldCatalog.products.filter((entry) => !PIZZA_BY_SIZE_PRODUCT_IDS.includes(entry.id)));
    await pool.query("UPDATE products SET description = description || ' owner change' WHERE id = 'medium-pizza'");
    await assert.rejects(applyOrderingRelease(pool, before, true), /owner edits were preserved/);
    await pool.query("UPDATE products SET description = $1 WHERE id = 'medium-pizza'", [before.observed.products.find((entry) => entry.id === "medium-pizza")!.description]);
    assert.equal(await applyOrderingRelease(pool, before, true), "rolled back");
    assert.equal(await applyOrderingRelease(pool, before, true), "already rolled back or not applied");
  } finally {
    await pool.query("UPDATE products SET active=$1, configuration_json=$2 WHERE id='medium-pizza'", [original.active, original.configuration_json]);
    await pool.query("UPDATE settings SET value_json=$1 WHERE key='operations'", [ops.value_json]);
  }
});
withDb("release refuses concurrent owner edits without partial writes", async () => {
  const before = await inspect();
  const pool = getPool();
  const original = (await pool.query("SELECT name FROM products WHERE id='slab-pizza'")).rows[0].name;
  await pool.query("UPDATE products SET name = 'Owner slab' WHERE id='slab-pizza'");
  try {
    await assert.rejects(applyOrderingRelease(pool, before), /owner edits were preserved/);
    assert.equal((await pool.query("SELECT value_json FROM settings WHERE key='operations'")).rows[0].value_json, before.observed.operations!.value_json);
  } finally { await pool.query("UPDATE products SET name=$1 WHERE id='slab-pizza'", [original]); }
});
withDb("all five delivery sizes quote equally for staff/customers, charge extras, exclude pickup", async () => {
  for (const id of PIZZA_BY_SIZE_PRODUCT_IDS) {
    const seed = MENU_PRODUCTS.find((entry) => entry.id === id)!;
    const variation = seed.variations![0];
    const item = { productId: id, variationId: variation.id, quantity: 1, toppings: ["real-chicken", "pepperoni", "onions", "corn"].map((toppingId) => ({ toppingId, placement: "whole" as const })) };
    const body = { ...common, fulfilment: "delivery" as const, items: [item], schedule: await schedule() };
    const [staff, customer] = await Promise.all([quoteOrder(body, { staffEntry: true }), quoteOrder(body)]);
    assert.equal(staff.lines[0].unitPriceCents, seed.basePriceCents + variation.extraToppingPriceCents);
    assert.deepEqual(staff.totals, customer.totals);
    const pickup = await quoteOrder({ ...body, fulfilment: "pickup" });
    assert.equal(pickup.ok, false);
    assert.ok(pickup.issues.some((issue) => issue.index === 0));
    const committed = await createOrder({ ...body, items: [item, { productId: "poutine", quantity: 1 }], address: { line1: "55 Parkdale Ave N", city: "Hamilton", province: "ON", postalCode: "L8H 5W7" }, idempotencyKey: crypto.randomUUID() }, { staffEntry: true, channel: "phone" });
    const fullQuote = await quoteOrder({ ...body, items: [item, { productId: "poutine", quantity: 1 }] });
    assert.equal(committed.price?.totalCents, fullQuote.totals.totalCents);
  }
});
withDb("recipe omissions, normalized halves and chicken keep displayed, quoted, committed and printed prices equal", async () => {
  const seed = MENU_PRODUCTS.find((entry) => entry.id === "specialty-chicken-bbq")!;
  const variation = seed.variations![1];
  const recipe = seed.configuration!.recipeToppingIds as string[];
  const toppingIds = recipe.filter((id) => id !== "real-chicken");
  const toppings = [...toppingIds.map((toppingId) => ({ toppingId, placement: "whole" as const })), { toppingId: "corn", placement: "left" as const }, { toppingId: "corn", placement: "left" as const }];
  const item = { productId: seed.id, variationId: variation.id, quantity: 2, toppings, omitToppings: ["real-chicken"], extraCheese: false, specialInstructions: "Light cheese" };
  const displayed = pricePizza({ basePriceCents: variation.basePriceCents, extraToppingPriceCents: variation.extraToppingPriceCents, includedToppingUnitsBps: variation.includedToppingUnitsBps!, halfToppingUnitsBps: 5000, toppings, extraCheese: false, recipeToppingIds: recipe, recipeExtraCheese: true });
  const body = { ...common, items: [item], schedule: await schedule() };
  const [staff, customer] = await Promise.all([quoteOrder(body, { staffEntry: true }), quoteOrder(body)]);
  assert.equal(staff.lines[0].unitPriceCents, displayed.totalCents);
  assert.deepEqual(staff.totals, customer.totals);
  const key = crypto.randomUUID();
  const order = await createOrder({ ...body, idempotencyKey: key }, { staffEntry: true, channel: "walk_in" });
  const duplicate = await createOrder({ ...body, idempotencyKey: key }, { staffEntry: true, channel: "walk_in" });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.orderId, order.orderId);
  assert.equal(order.price?.totalCents, customer.totals.totalCents);
  const stored = (await getPool().query("SELECT * FROM order_items WHERE order_id=$1", [order.orderId])).rows[0];
  const receipt = (await getPool().query("SELECT * FROM orders WHERE id=$1", [order.orderId])).rows[0];
  assert.equal(stored.unit_price_cents, displayed.totalCents);
  assert.equal(stored.line_total_cents, customer.lines[0].lineTotalCents);
  assert.ok(totalRows(receipt).some((row) => row.kind === "total"));
  const snapshot = JSON.parse(stored.snapshot_json);
  assert.ok(snapshot.recipeOmissions.includes("Real Chicken"));
});
withDb("four identical and mixed legacy drink slots quote and commit with complete kitchen data", async () => {
  const product = MENU_PRODUCTS.find((entry) => entry.id === "four-pops")!;
  const sections = product.configuration!.sections as ModifierSection[];
  for (const flavours of [["Pepsi", "Pepsi", "Pepsi", "Pepsi"], ["Pepsi", "Coke", "Pepsi", "Sprite"]]) {
    const modifiers = sections.map((section, index) => ({ id: section.id, values: [flavours[index]] }));
    const body = { ...common, items: [{ productId: product.id, quantity: 1, modifiers }], schedule: await schedule() };
    const quote = await quoteOrder(body);
    assert.equal(quote.ok, true);
    assert.equal(quote.lines[0].unitPriceCents, product.basePriceCents);
    const order = await createOrder({ ...body, idempotencyKey: crypto.randomUUID() }, { staffEntry: true, channel: "walk_in" });
    const stored = (await getPool().query("SELECT snapshot_json FROM order_items WHERE order_id=$1", [order.orderId])).rows[0];
    const snapshot = JSON.parse(stored.snapshot_json);
    assert.equal(snapshot.modifiers.length, 4);
    const details = snapshotDetails(snapshot, new Map());
    assert.ok(details.some((entry) => entry.value.includes("Pepsi ×")));
  }
  const bad = await quoteOrder({ ...common, items: [{ productId: product.id, quantity: 1, modifiers: [{ id: sections[0].id, values: ["Pepsi", "Pepsi"] }] }], schedule: await schedule() });
  assert.equal(bad.ok, false);
});
withDb("a blocked first line cannot shift quoted prices onto the wrong cart line", async () => {
  const quote = await quoteOrder({ ...common, items: [{ productId: "nonexistent", quantity: 1 }, { productId: "poutine", quantity: 1 }], schedule: await schedule() });
  assert.equal(quote.ok, false);
  assert.equal(quote.lines[0].index, 1);
  assert.equal(quote.lines[0].productId, "poutine");
});
