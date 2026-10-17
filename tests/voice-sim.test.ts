/**
 * The developer voice simulator (scripts/voice-sim.ts) drives the real tools.
 *
 * It is not an agent — a fixed script of tool calls — so this only pins that
 * it still reaches the engine: a review-only run creates no order, and a
 * `place` run creates exactly one `ai_phone` order with its kitchen alert.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after, mock } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { runSimulation } = await import("@/scripts/voice-sim");

const reachable = await getPool().query("SELECT 1").then(() => true).catch(() => false);
after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-14T18:00:00-04:00") });
    try {
      await body();
    } finally {
      mock.timers.reset();
    }
  });

const script = {
  fulfilment: "pickup" as const,
  items: ["large pepperoni", "a large hawaiian no ham"],
  lines: [{ productId: "one-pop", quantity: 2, modifiers: [{ id: "drink-1", values: ["Coke"] }] }],
  customer: { name: "Simulated Caller", phone: "905-555-0100" },
};

withDb("a review-only run reads the order back and places nothing", async () => {
  const result = await runSimulation(script);
  assert.equal(result.ok, true, JSON.stringify(result.steps.at(-1)?.response));
  assert.equal(result.orderNumber, null);
  assert.match(result.readback ?? "", /one Large Pizza · 1 Item — Toppings: Pepperoni/);
  assert.match(result.readback ?? "", /two orders of 1 Pop/);
  const placed = await getPool().query("SELECT order_id FROM voice_calls WHERE id = $1", [result.sessionId]);
  assert.equal(placed.rows[0].order_id, null);
});

withDb("a place run makes one ai_phone order with its kitchen alert", async () => {
  const result = await runSimulation({ ...script, place: true });
  assert.equal(result.ok, true, JSON.stringify(result.steps.at(-1)?.response));
  const order = (await getPool().query("SELECT id, channel FROM orders WHERE order_number = $1", [result.orderNumber])).rows[0];
  assert.equal(order.channel, "ai_phone");
  const outbox = await getPool().query("SELECT kind FROM notification_outbox WHERE payload_json::jsonb->>'orderId' = $1", [order.id]);
  assert.deepEqual(outbox.rows.map((row) => row.kind), ["restaurant_new_order"]);
  assert.deepEqual(result.steps.map((step) => step.tool), [
    "get_store_status", "start_order", "search_menu", "add_item", "search_menu", "add_item", "add_item",
    "set_customer", "review_order", "confirm_order", "place_order",
  ]);
});

withDb("a scheduled run with a promo code and a tip reads all three back", async () => {
  const result = await runSimulation({
    ...script,
    items: ["large pepperoni no cheese"],
    lines: [{ productId: "garlic-bread" }],
    schedule: { day: "tomorrow", time: "5:45 pm" },
    coupon: "thanks62",
    tip: { type: "percentage", percent: 15 },
  });
  assert.equal(result.ok, true, JSON.stringify(result.steps.at(-1)?.response));
  assert.match(result.readback ?? "", /^Here is your pickup order, for tomorrow at 5:45 PM\./);
  assert.match(result.readback ?? "", /note: No Cheese/);
  assert.match(result.readback ?? "", /discount \$3\.99/);
  assert.match(result.readback ?? "", /tip \$\d+\.\d\d/);
  assert.deepEqual(result.steps.map((step) => step.tool).slice(-5), ["set_schedule", "apply_coupon", "set_tip", "set_customer", "review_order"]);
});
