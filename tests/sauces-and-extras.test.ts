/**
 * Sauces, extras, the cheesy breadsticks and the day's-special pop-up
 * (owner's menu changes, 2026-10-06).
 *
 * The load-bearing property is the same one the quote tests defend: **what the
 * customizer shows is what the server charges.** A sauce priced in the browser
 * and not on the server — which is exactly what would have happened, because a
 * pizza's modifiers never carried a price before — undercharges every order
 * silently. So the money is checked on the server, against the same functions
 * the customizer prices with.
 *
 * The other properties: a cart built before sauces existed still goes through,
 * a recipe's own sauce is never charged for, and the migration adds groups to
 * the live menu without touching anything the owner has set.
 *
 * The database tests need a reachable Postgres and are skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  DEFAULT_PIZZA_EXTRAS,
  DEFAULT_SAUCE_OPTION,
  PIZZA_EXTRA_OPTIONS,
  SAUCE_OPTIONS,
  defaultSectionValues,
  isRetiredSection,
  nextOrderSlots,
  orderModifierSections,
  pizzaExtrasSection,
  pizzaSauceSection,
  sectionOptionPrices,
  type ModifierSection,
} from "@/lib/domain";
import { CHEESY_BREADSTICKS_PRODUCT_ID, MENU_PRODUCTS, MONDAY_WINGS_PRODUCT_ID, SIGNATURE_SAUCES } from "@/lib/menu";
import { todaysSpecials, weekdayName } from "@/lib/daily-specials";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { quoteOrder, createOrder } = await import("@/lib/order-service");
const { getD1, getSetting, runDataMigrations } = await import("@/db/runtime");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);
after(closePool);

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

// Read before any test is declared: a top-level await left pending behind the
// synchronous tests would still be waiting when `after` closes the pool.
const hours = reachable
  ? await getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours")
  : [];
const schedule = {
  type: "scheduled" as const,
  scheduledFor: reachable ? nextOrderSlots({ now: Date.now(), hours, timeZone: "America/Toronto", leadMinutes: 45, limit: 1 })[0] : 0,
};

// --- prices and defaults ----------------------------------------------------

test("tomato is free and every new sauce is $1.49", () => {
  const prices = sectionOptionPrices(pizzaSauceSection("pizza-sauce"));
  assert.equal(DEFAULT_SAUCE_OPTION, "Tomato");
  assert.equal(prices.Tomato ?? 0, 0);
  for (const sauce of ["BBQ", "Butter Chicken", "Creamy Garlic", "Honey Garlic", "Shawarma"]) {
    assert.equal(prices[sauce], 149, sauce);
  }
  assert.deepEqual([...SAUCE_OPTIONS].sort(), ["BBQ", "Butter Chicken", "Creamy Garlic", "Honey Garlic", "Shawarma", "Tomato"]);
});

test("oregano and chili flakes are free and not ticked; olive oil and seasoning are $1.29", () => {
  const section = pizzaExtrasSection("pizza-extras");
  const prices = sectionOptionPrices(section);
  assert.deepEqual([...PIZZA_EXTRA_OPTIONS], ["Oregano", "Chili Flakes", "Olive Oil", "Homemade Seasoning"]);
  assert.equal(prices.Oregano ?? 0, 0);
  assert.equal(prices["Chili Flakes"] ?? 0, 0);
  assert.equal(prices["Olive Oil"], 129);
  assert.equal(prices["Homemade Seasoning"], 129);
  assert.deepEqual(defaultSectionValues(section), [...DEFAULT_PIZZA_EXTRAS]);
  // Owner, 2026-10-06: free, but only for whoever ticks them.
  assert.deepEqual(defaultSectionValues(section), []);
  // Every extra can be left off, and every one can be had.
  assert.equal(section.min, 0);
  assert.equal(section.max, PIZZA_EXTRA_OPTIONS.length);
});

test("a recipe's own sauce starts selected and is free; any other swap still costs", () => {
  const section = pizzaSauceSection("pizza-sauce", { includedSauce: "Shawarma" });
  const prices = sectionOptionPrices(section);
  assert.deepEqual(defaultSectionValues(section, "Shawarma"), ["Shawarma"]);
  assert.equal(prices.Shawarma ?? 0, 0);
  assert.equal(prices.Tomato ?? 0, 0);
  assert.equal(prices.BBQ, 149);
  // A name that is not a sauce is ignored rather than trusted.
  assert.deepEqual(defaultSectionValues(pizzaSauceSection("s", { includedSauce: "Ketchup" }), "Ketchup"), ["Tomato"]);
  assert.equal(pizzaSauceSection("s", { includedSauce: "Ketchup" }).optionPrices, undefined);
});

test("a cart saved before sauces existed is still valid: the sauce group is optional", () => {
  // The customizer always sends one. A browser holding an older cart sends none,
  // and refusing it over a choice the customer was never offered would strand
  // a working order at checkout.
  assert.equal(pizzaSauceSection("pizza-sauce").min, 0);
  assert.equal(pizzaSauceSection("pizza-sauce").max, 1);
});

test("sauce is asked after the crust and before the bake; extras come last", () => {
  const sections: ModifierSection[] = [
    pizzaExtrasSection("e", "Pizza 1"),
    { id: "t", label: "Toppings", source: "toppings", min: 0, max: 12, group: "Pizza 1" },
    { id: "b", label: "Bake & sauce", source: "bake_sauce", min: 0, max: 2, group: "Pizza 1" },
    pizzaSauceSection("s", { group: "Pizza 1" }),
    { id: "c", label: "Crust", source: "crust", min: 0, max: 1, group: "Pizza 1" },
    { id: "ch", label: "Cheese", source: "cheese", min: 1, max: 1, group: "Pizza 1" },
  ];
  assert.deepEqual(orderModifierSections(sections).map((section) => section.id), ["ch", "c", "s", "b", "t", "e"]);
  assert.deepEqual(orderModifierSections(sections, true).map((section) => section.id), ["ch", "t", "c", "s", "b", "e"]);
});

// --- the menu seed ------------------------------------------------------------

test("every pizza asks for sauce and extras; a panzerotti and a sub do not", () => {
  const pizzas = MENU_PRODUCTS.filter((product) => product.productType === "pizza");
  const asked = pizzas.filter((product) => product.configuration?.sauceEnabled && product.configuration?.extrasEnabled).map((product) => product.id);
  const notAsked = pizzas.filter((product) => !product.configuration?.sauceEnabled).map((product) => product.id).sort();
  assert.deepEqual(notAsked, ["panzerotti-three-items", "pizza-three-item-sub"]);
  for (const id of ["large-pizza", "specialty-deluxe", "pickup-large-three", "pickup-medium-five", "dollar-medium-pizza"]) {
    assert.ok(asked.includes(id), id);
  }
});

test("BBQ, butter chicken and shawarma pizzas start on their own sauce", () => {
  assert.deepEqual(SIGNATURE_SAUCES, {
    "specialty-chicken-bbq": "BBQ",
    "specialty-butter-chicken": "Butter Chicken",
    "specialty-shawarma": "Shawarma",
  });
  for (const [id, sauce] of Object.entries(SIGNATURE_SAUCES)) {
    assert.equal(MENU_PRODUCTS.find((product) => product.id === id)?.configuration?.includedSauce, sauce);
  }
  assert.equal(MENU_PRODUCTS.find((product) => product.id === "specialty-deluxe")?.configuration?.includedSauce, undefined);
});

test("every pizza inside a deal asks for sauce and extras", () => {
  let pizzasChecked = 0;
  for (const product of MENU_PRODUCTS) {
    const sections = (product.configuration?.sections ?? []) as ModifierSection[];
    for (const cheese of sections.filter((section) => section.source === "cheese")) {
      const group = sections.filter((section) => section.group === cheese.group);
      assert.equal(group.filter((section) => section.source === "sauce").length, 1, `${product.id} ${cheese.group}`);
      assert.equal(group.filter((section) => section.source === "pizza_extras").length, 1, `${product.id} ${cheese.group}`);
      pizzasChecked += 1;
    }
  }
  assert.ok(pizzasChecked >= 20, "the deals, combos and 2-for-1s were all checked");
});

test("cheesy breadsticks are a new $6.99 side, for pickup and delivery", () => {
  const product = MENU_PRODUCTS.find((entry) => entry.id === CHEESY_BREADSTICKS_PRODUCT_ID)!;
  assert.equal(product.name, "Cheesy Breadsticks");
  assert.equal(product.categoryId, "sides");
  assert.equal(product.basePriceCents, 699);
  assert.equal(product.productType, "simple");
  assert.equal(product.configuration?.isNew, true);
  assert.match(product.description, /half-moon/i);
  assert.notEqual(product.pickupEligible, false);
  assert.notEqual(product.deliveryEligible, false);
});

// --- the day's-special pop-up -------------------------------------------------

const MONDAY_NOON = new Date("2026-10-05T16:00:00Z");
const TUESDAY_NOON = new Date("2026-10-06T16:00:00Z");
const BOTH = { pickupEnabled: true, deliveryEnabled: true };

const asCatalogRow = (id: string, overrides: Record<string, unknown> = {}) => {
  const seed = MENU_PRODUCTS.find((product) => product.id === id)!;
  return {
    id,
    sold_out: 0,
    setup_required: 0,
    pickup_eligible: seed.pickupEligible === false ? 0 : 1,
    delivery_eligible: seed.deliveryEligible === false ? 0 : 1,
    configuration: { ...(seed.configuration ?? {}) } as Record<string, unknown>,
    ...overrides,
  };
};

test("the Monday wings are Monday's special, and only Monday's", () => {
  const products = [asCatalogRow(MONDAY_WINGS_PRODUCT_ID), asCatalogRow("large-pizza")];
  assert.deepEqual(todaysSpecials(products, MONDAY_NOON, BOTH).map((product) => product.id), [MONDAY_WINGS_PRODUCT_ID]);
  assert.deepEqual(todaysSpecials(products, TUESDAY_NOON, BOTH), []);
});

test("the pop-up names the day in Toronto, not in the visitor's time zone", () => {
  // 02:00 UTC Tuesday is still Monday evening at the restaurant.
  assert.equal(weekdayName(new Date("2026-10-06T02:00:00Z"), "America/Toronto"), "Monday");
});

test("a special the site cannot sell right now is not advertised", () => {
  assert.deepEqual(todaysSpecials([asCatalogRow(MONDAY_WINGS_PRODUCT_ID, { sold_out: 1 })], MONDAY_NOON, BOTH), []);
  // Pickup-only wings, with pickup switched off.
  assert.deepEqual(todaysSpecials([asCatalogRow(MONDAY_WINGS_PRODUCT_ID)], MONDAY_NOON, { pickupEnabled: false, deliveryEnabled: true }), []);
});

test("the counter's weekday specials are flagged, ready for the day the owner publishes them", () => {
  for (const id of ["monday-large-special", "tuesday-medium-special", "wednesday-pizza-wings"]) {
    const configuration = MENU_PRODUCTS.find((product) => product.id === id)?.configuration;
    assert.equal(configuration?.dailySpecial, true, id);
    assert.equal(configuration?.staffOnly, true, id);
  }
  const tuesday = asCatalogRow("tuesday-medium-special");
  assert.deepEqual(todaysSpecials([tuesday], TUESDAY_NOON, BOTH).map((product) => product.id), ["tuesday-medium-special"]);
});

// --- what the server charges --------------------------------------------------

const CUSTOMER = { name: "Grace Hopper", phone: "905-555-0199", email: "grace@example.test" };
const THREE_TOPPINGS = ["pepperoni", "mushrooms", "onions"].map((toppingId) => ({ toppingId, placement: "whole" as const }));

const largeThree = (modifiers?: Array<{ id: string; values: string[] }>) => ({
  fulfilment: "pickup" as const,
  paymentMethod: "pay_at_store" as const,
  schedule,
  items: [{ productId: "pickup-large-three", variationId: "pickup-large-three-size", quantity: 1, toppings: THREE_TOPPINGS, ...(modifiers ? { modifiers } : {}) }],
});

async function subtotalOf(cart: Parameters<typeof quoteOrder>[0]): Promise<number> {
  const quote = await quoteOrder(cart);
  assert.deepEqual(quote.issues, [], "the cart should be orderable");
  return quote.totals.menuSubtotalCents;
}

withDb("the classic sauce and the free extras add nothing; a new sauce and olive oil add $2.78", async () => {
  const plain = await subtotalOf(largeThree());
  const classic = await subtotalOf(largeThree([
    { id: "pizza-sauce", values: ["Tomato"] },
    { id: "pizza-extras", values: ["Oregano", "Chili Flakes"] },
  ]));
  const fancy = await subtotalOf(largeThree([
    { id: "pizza-sauce", values: ["Honey Garlic"] },
    { id: "pizza-extras", values: ["Oregano", "Olive Oil"] },
  ]));
  assert.equal(classic, plain, "a cart with no sauce named is the classic, at the classic price");
  assert.equal(fancy - plain, 149 + 129);
});

withDb("the kitchen ticket is told the sauce and the extras, at the price charged", async () => {
  const created = await createOrder({
    ...largeThree([
      { id: "pizza-sauce", values: ["Butter Chicken"] },
      { id: "pizza-extras", values: ["Chili Flakes", "Homemade Seasoning"] },
    ]),
    idempotencyKey: `sauce-${crypto.randomUUID()}-${crypto.randomUUID()}`,
    customer: CUSTOMER,
  });
  const row = (
    await getPool().query<{ unit_price_cents: number; snapshot_json: string }>(
      "SELECT unit_price_cents, snapshot_json FROM order_items WHERE order_id = $1",
      [created.orderId],
    )
  ).rows[0];
  const plain = await subtotalOf(largeThree());
  assert.equal(Number(row.unit_price_cents), plain + 149 + 129);
  const modifiers = (JSON.parse(row.snapshot_json) as { modifiers: Array<{ id: string; label: string; values: Array<{ value: string }> }> }).modifiers;
  const byId = new Map(modifiers.map((modifier) => [modifier.id, modifier]));
  assert.equal(byId.get("pizza-sauce")?.label, "Sauce");
  assert.deepEqual(byId.get("pizza-sauce")?.values.map((entry) => entry.value), ["Butter Chicken"]);
  assert.deepEqual(byId.get("pizza-extras")?.values.map((entry) => entry.value), ["Chili Flakes", "Homemade Seasoning"]);
  // Asked in this order, and printed in it.
  assert.deepEqual(modifiers.map((modifier) => modifier.id).filter((id) => id === "pizza-sauce" || id === "pizza-extras"), ["pizza-sauce", "pizza-extras"]);
});

withDb("an unknown sauce, or two sauces on one pizza, is refused", async () => {
  const unknown = await quoteOrder(largeThree([{ id: "pizza-sauce", values: ["Ketchup"] }]));
  assert.equal(unknown.ok, false);
  const two = await quoteOrder(largeThree([{ id: "pizza-sauce", values: ["BBQ", "Shawarma"] }]));
  assert.equal(two.ok, false);
});

withDb("the shawarma pizza's own sauce is free; swapping it for BBQ costs the usual $1.49", async () => {
  const shawarma = (values?: string[]) => ({
    fulfilment: "pickup" as const,
    paymentMethod: "pay_at_store" as const,
    schedule,
    items: [{
      productId: "specialty-shawarma",
      variationId: "specialty-shawarma-large",
      quantity: 1,
      toppings: ["real-chicken", "onions", "tomatoes"].map((toppingId) => ({ toppingId, placement: "whole" as const })),
      ...(values ? { modifiers: [{ id: "pizza-sauce", values }] } : {}),
    }],
  });
  const recipe = await subtotalOf(shawarma());
  assert.equal(await subtotalOf(shawarma(["Shawarma"])), recipe);
  assert.equal(await subtotalOf(shawarma(["Tomato"])), recipe);
  assert.equal(await subtotalOf(shawarma(["BBQ"])) - recipe, 149);
});

withDb("a deal charges each pizza's sauce and extras on their own", async () => {
  const deal = (modifiers: Array<{ id: string; values: string[] }>) => ({
    fulfilment: "pickup" as const,
    paymentMethod: "pay_at_store" as const,
    schedule,
    items: [{
      productId: "two-for-one-large",
      quantity: 1,
      modifiers: [
        { id: "pizza-1-cheese", values: ["Regular Cheese"] },
        { id: "pizza-1-toppings", values: ["pepperoni"] },
        { id: "pizza-2-cheese", values: ["Regular Cheese"] },
        { id: "pizza-2-toppings", values: ["mushrooms"] },
        ...modifiers,
      ],
    }],
  });
  const plain = await subtotalOf(deal([]));
  const dressed = await subtotalOf(deal([
    { id: "pizza-1-sauce", values: ["Creamy Garlic"] },
    { id: "pizza-1-extras", values: ["Oregano", "Chili Flakes"] },
    { id: "pizza-2-sauce", values: ["Tomato"] },
    { id: "pizza-2-extras", values: ["Olive Oil", "Homemade Seasoning"] },
  ]));
  assert.equal(dressed - plain, 149 + 129 + 129);
});

withDb("the migration adds the new groups to the live menu and leaves owner edits alone", async () => {
  const database = getD1();
  const marker = "dataMigration:2026-10-06-pizza-sauces-and-extras";
  const read = async (id: string) =>
    JSON.parse(
      (await getPool().query<{ configuration_json: string }>("SELECT configuration_json FROM products WHERE id = $1", [id])).rows[0].configuration_json,
    ) as Record<string, unknown> & { sections?: ModifierSection[] };
  const without = (configuration: Record<string, unknown>, ...keys: string[]) =>
    Object.fromEntries(Object.entries(configuration).filter(([key]) => !keys.includes(key)));
  const write = (id: string, configuration: Record<string, unknown>) =>
    getPool().query("UPDATE products SET configuration_json = $1 WHERE id = $2", [JSON.stringify(configuration), id]);

  const originalDeal = await read("two-for-one-large");
  const originalPizza = await read("pickup-large-three");
  const originalBbq = await read("specialty-chicken-bbq");
  const originalWings = await read(MONDAY_WINGS_PRODUCT_ID);
  try {
    // The live database as it was before: no sauce or extras anywhere, plus an
    // owner who has capped Pizza 1's toppings and set their own sauce on the BBQ
    // pizza.
    const before = (originalDeal.sections ?? [])
      .filter((section) => section.source !== "sauce" && section.source !== "pizza_extras")
      .map((section) => (section.id === "pizza-1-toppings" ? { ...section, max: 5 } : section));
    await write("two-for-one-large", { ...originalDeal, sections: before });
    await write("pickup-large-three", without(originalPizza, "sauceEnabled", "extrasEnabled"));
    await write("specialty-chicken-bbq", { ...originalBbq, includedSauce: "Honey Garlic" });
    await write(MONDAY_WINGS_PRODUCT_ID, without(originalWings, "dailySpecial"));
    await getPool().query("DELETE FROM settings WHERE key = $1", [marker]);

    await runDataMigrations(database);

    const deal = await read("two-for-one-large");
    // Retired groups (halal) may still sit in a stored deal; nothing reads them.
    const pizza1 = (deal.sections ?? []).filter((section) => section.group === "Pizza 1" && !isRetiredSection(section)).map((section) => section.source);
    assert.deepEqual(pizza1, ["cheese", "crust", "sauce", "bake_sauce", "toppings", "pizza_extras"]);
    assert.equal(deal.sections?.find((section) => section.id === "pizza-1-toppings")?.max, 5, "the owner's cap survives");
    const pizza = await read("pickup-large-three");
    assert.equal(pizza.sauceEnabled, true);
    assert.equal(pizza.extrasEnabled, true);
    assert.equal((await read("specialty-chicken-bbq")).includedSauce, "Honey Garlic", "the owner's sauce survives");
    assert.equal((await read(MONDAY_WINGS_PRODUCT_ID)).dailySpecial, true);

    // Once only: running again changes nothing.
    await write("two-for-one-large", { ...deal, sections: before });
    await runDataMigrations(database);
    assert.equal((await read("two-for-one-large")).sections?.some((section) => section.source === "sauce"), false);
  } finally {
    await write("two-for-one-large", originalDeal);
    await write("pickup-large-three", originalPizza);
    await write("specialty-chicken-bbq", originalBbq);
    await write(MONDAY_WINGS_PRODUCT_ID, originalWings);
    await getPool().query(
      "INSERT INTO settings (key, value_json, version, updated_at) VALUES ($1, '{}', 1, $2) ON CONFLICT (key) DO NOTHING",
      [marker, Date.now()],
    );
  }
});

test("a recipe topping left off is printed as NO …, and not also listed as a topping", async () => {
  const { snapshotDetails, snapshotFlags } = await import("@/lib/order-presentation");
  const names = new Map([["pepperoni", "Pepperoni"], ["mushrooms", "Mushrooms"], ["pineapple", "Pineapple"]]);
  const snapshot = {
    recipeOmissions: ["Mushrooms"],
    toppings: ["pepperoni", "mushrooms", "pineapple"].map((toppingId) => ({ toppingId, placement: "whole" })),
  };
  assert.deepEqual(snapshotDetails(snapshot, names), [{ label: "Toppings", value: "Pepperoni, Pineapple" }]);
  assert.deepEqual(snapshotFlags(snapshot), ["No Mushrooms"]);
});
