/**
 * Set recipes (H-03), and the retired halal group that outlives them (C-08).
 *
 * **H-03.** A specialty pizza is sold under a name that describes what is on it.
 * The client could drop recipe toppings and the server priced and accepted
 * whatever it was sent, so an "All Meat" could reach the kitchen with no meat on
 * it — at the All Meat price, under the All Meat name. The fix is not to forbid
 * omissions, which are a normal request, but to make them explicit: named,
 * checked against the recipe, recorded for the kitchen ticket, and never a
 * discount. A recipe topping going *quietly* missing is what must be impossible.
 *
 * The pricing assertion is the one that matters most. If omitting an ingredient
 * reduced the price, a customer could buy the same named product cheaper by
 * removing something and adding it straight back as a paid extra.
 *
 * **Retired groups.** Halal was withdrawn from the menu, but deals seeded before
 * the withdrawal still carry a `source: "halal"` section in their stored
 * configuration, and carts live in `localStorage` with no expiry. A retired group
 * must therefore be *discarded* on the way in, never rejected: rejecting it would
 * fail a months-old basket at checkout with "An unsupported item option was
 * submitted." and nothing the customer could do about it.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { quoteOrder } = await import("@/lib/order-service");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

/** "All Meat": five recipe toppings, so a removal is unmistakable. */
const ALL_MEAT = "specialty-all-meat";
const ALL_MEAT_RECIPE = ["pepperoni", "italian-sausage", "real-bacon", "ham", "ground-beef"];

async function largeVariationOf(productId: string): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    "SELECT id FROM product_variations WHERE product_id = $1 AND active = 1 ORDER BY display_order LIMIT 1",
    [productId],
  );
  return result.rows[0].id;
}

const wholeToppings = (ids: string[]) => ids.map((toppingId) => ({ toppingId, placement: "whole" as const }));

withDb("prices the recipe as submitted when it is complete", async () => {
  const variationId = await largeVariationOf(ALL_MEAT);
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [{ productId: ALL_MEAT, variationId, quantity: 1, toppings: wholeToppings(ALL_MEAT_RECIPE) }],
    paymentMethod: "pay_at_store",
  });
  const lineIssues = quote.issues.filter((issue) => issue.index !== null);
  assert.equal(lineIssues.length, 0, "a complete recipe must be accepted");
  assert.equal(quote.lines.length, 1);
});

withDb("refuses a recipe topping that simply went missing", async () => {
  // The finding, in its literal form: All Meat with the meat taken off.
  const variationId = await largeVariationOf(ALL_MEAT);
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [
      {
        productId: ALL_MEAT,
        variationId,
        quantity: 1,
        toppings: wholeToppings(ALL_MEAT_RECIPE.slice(0, 2)),
      },
    ],
    paymentMethod: "pay_at_store",
  });
  const issue = quote.issues.find((entry) => entry.index === 0);
  assert.ok(issue, "an incomplete recipe must be refused");
  assert.equal(issue.code, "RECIPE_INCOMPLETE");
  // The message has to name what is missing, or nobody can act on it.
  assert.match(issue.message, /Bacon|Ham|Beef/i);
});

withDb("accepts an omission that is asked for explicitly", async () => {
  const variationId = await largeVariationOf(ALL_MEAT);
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [
      {
        productId: ALL_MEAT,
        variationId,
        quantity: 1,
        toppings: wholeToppings(ALL_MEAT_RECIPE.filter((id) => id !== "ham")),
        omitToppings: ["ham"],
      },
    ],
    paymentMethod: "pay_at_store",
  });
  assert.equal(quote.issues.filter((issue) => issue.index !== null).length, 0, "hold the ham is a normal request");
});

withDb("leaving an ingredient off is not a discount", async () => {
  // Without this, the same named product could be bought cheaper by removing an
  // ingredient — and then added straight back as a paid extra for less than it
  // was worth inside the recipe.
  const variationId = await largeVariationOf(ALL_MEAT);
  const full = await quoteOrder({
    fulfilment: "pickup",
    items: [{ productId: ALL_MEAT, variationId, quantity: 1, toppings: wholeToppings(ALL_MEAT_RECIPE) }],
    paymentMethod: "pay_at_store",
  });
  const reduced = await quoteOrder({
    fulfilment: "pickup",
    items: [
      {
        productId: ALL_MEAT,
        variationId,
        quantity: 1,
        toppings: wholeToppings(ALL_MEAT_RECIPE.filter((id) => id !== "ham")),
        omitToppings: ["ham"],
      },
    ],
    paymentMethod: "pay_at_store",
  });
  assert.equal(reduced.totals.menuSubtotalCents, full.totals.menuSubtotalCents);
});

withDb("refuses to omit something the recipe never had", async () => {
  // Otherwise `omitToppings` is a free-text field that prints arbitrary text on
  // a kitchen ticket.
  const variationId = await largeVariationOf(ALL_MEAT);
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [
      {
        productId: ALL_MEAT,
        variationId,
        quantity: 1,
        toppings: wholeToppings(ALL_MEAT_RECIPE),
        omitToppings: ["pineapple"],
      },
    ],
    paymentMethod: "pay_at_store",
  });
  const issue = quote.issues.find((entry) => entry.index === 0);
  assert.ok(issue);
  assert.match(issue.message, /cannot be left off/);
});

withDb("a half-placed recipe topping does not satisfy the recipe", async () => {
  // Half the pizza is not the recipe. Accepting it would let the price stay put
  // while half the advertised product quietly disappeared.
  const variationId = await largeVariationOf(ALL_MEAT);
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [
      {
        productId: ALL_MEAT,
        variationId,
        quantity: 1,
        toppings: [
          ...wholeToppings(ALL_MEAT_RECIPE.filter((id) => id !== "ham")),
          { toppingId: "ham", placement: "left" as const },
        ],
      },
    ],
    paymentMethod: "pay_at_store",
  });
  const issue = quote.issues.find((entry) => entry.index === 0);
  assert.ok(issue, "a recipe topping on half the pizza is not the recipe");
  assert.equal(issue.code, "RECIPE_INCOMPLETE");
});

// --- retired option groups -------------------------------------------------

withDb("checks out a saved cart that still names the withdrawn halal group", async () => {
  // The exact shape a browser saved before the withdrawal: a deal, plus a
  // modifier naming a section that is still in the product's stored
  // configuration but is no longer offered anywhere.
  const deal = await getPool().query<{ id: string; configuration_json: string }>(
    `SELECT id, configuration_json FROM products
     WHERE configuration_json LIKE '%"halal"%' AND active = 1 AND sold_out = 0 LIMIT 1`,
  );
  if (!deal.rows.length) return; // nothing seeded with the retired group

  const { id, configuration_json } = deal.rows[0];
  const sections = (JSON.parse(configuration_json).sections ?? []) as Array<{ id: string; source?: string }>;
  const retired = sections.find((section) => section.source === "halal");
  assert.ok(retired, "the fixture must actually carry a retired section");

  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [{ productId: id, quantity: 1, modifiers: [{ id: retired.id, values: ["Halal meat toppings"] }] }],
    paymentMethod: "pay_at_store",
  });

  const rejected = quote.issues.find((issue) => /unsupported item option/i.test(issue.message));
  assert.equal(rejected, undefined, "a retired group must be discarded, not rejected");
});

withDb("never prints a retired group on the kitchen ticket", async () => {
  const deal = await getPool().query<{ id: string; configuration_json: string }>(
    `SELECT id, configuration_json FROM products
     WHERE configuration_json LIKE '%"halal"%' AND active = 1 AND sold_out = 0 LIMIT 1`,
  );
  if (!deal.rows.length) return;

  const { id, configuration_json } = deal.rows[0];
  const sections = (JSON.parse(configuration_json).sections ?? []) as Array<{ id: string; source?: string }>;
  const retired = sections.find((section) => section.source === "halal");
  assert.ok(retired);

  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [{ productId: id, quantity: 1, modifiers: [{ id: retired.id, values: ["Halal meat toppings"] }] }],
    paymentMethod: "pay_at_store",
  });

  // Whatever else the deal is missing, the withdrawn choice must not survive
  // into anything the kitchen reads.
  assert.equal(
    JSON.stringify(quote.lines).toLowerCase().includes("halal"),
    false,
    "a withdrawn choice must not reach the kitchen",
  );
});
