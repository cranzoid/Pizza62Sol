import assert from "node:assert/strict";
import test from "node:test";
import { includedUpsellRoles, productUpsellRoles, recommendUpsells, type UpsellProduct } from "@/lib/upsells";

const product = (input: Partial<UpsellProduct> & Pick<UpsellProduct, "id" | "name" | "category_id">): UpsellProduct => ({
  product_type: "simple",
  description: "",
  base_price_cents: 100,
  pickup_eligible: 1,
  delivery_eligible: 1,
  sold_out: 0,
  setup_required: 0,
  configuration: {},
  ...input,
});

const pizza = product({
  id: "large-pizza",
  name: "Large Pizza",
  category_id: "build-your-own",
  product_type: "pizza",
  base_price_cents: 1799,
});
const dip = product({ id: "standard-dip", name: "Dipping Sauce", category_id: "sides", base_price_cents: 120 });
const garlic = product({ id: "garlic-bread-cheese", name: "Garlic Bread with Cheese", category_id: "sides", base_price_cents: 499 });
const pop = product({ id: "one-pop", name: "1 Pop", category_id: "drinks", product_type: "configurable", base_price_cents: 160 });
const fourPops = product({ id: "four-pops", name: "4 Pops", category_id: "drinks", product_type: "configurable", base_price_cents: 499 });
const brownie = product({ id: "chocolate-brownie", name: "Chocolate Brownie", category_id: "desserts", base_price_cents: 299 });
const fries = product({ id: "fries", name: "Fries", category_id: "sides", base_price_cents: 799 });
const catalog = [pizza, dip, garlic, pop, fourPops, brownie, fries];

test("recommends a diverse pizza completion set and sizes the drink to the order", () => {
  const recommendations = recommendUpsells({
    cart: [{ productId: pizza.id, name: pizza.name, categoryId: pizza.category_id, variationName: "Large", quantity: 1 }],
    products: catalog,
    fulfilment: "delivery",
  });

  assert.deepEqual(recommendations.map((entry) => entry.product.id), ["standard-dip", "garlic-bread-cheese", "four-pops"]);
  assert.deepEqual(recommendations.map((entry) => entry.ruleId), ["pizza-dip", "pizza-side", "pizza-drink"]);
});

test("does not recommend a product or role that is already in the cart", () => {
  const recommendations = recommendUpsells({
    cart: [
      { productId: pizza.id, name: pizza.name, categoryId: pizza.category_id, variationName: "Medium", quantity: 1 },
      { productId: dip.id, name: dip.name, categoryId: dip.category_id, quantity: 1 },
      { productId: garlic.id, name: garlic.name, categoryId: garlic.category_id, quantity: 1 },
    ],
    products: catalog,
    fulfilment: "delivery",
  });

  assert.deepEqual(recommendations.map((entry) => entry.product.id), ["one-pop", "chocolate-brownie"]);
});

test("suppresses products already included with legacy bundles", () => {
  const deal = product({
    id: "family-deal",
    name: "Family Pizza Deal",
    category_id: "deals",
    product_type: "bundle",
    description: "Two pizzas, four pops, veggie sticks, blue cheese and one dipping sauce.",
    base_price_cents: 4399,
  });
  assert.deepEqual([...includedUpsellRoles(deal)].sort(), ["dip", "drink", "side"]);

  const recommendations = recommendUpsells({
    cart: [{ productId: deal.id, name: deal.name, categoryId: deal.category_id, quantity: 1 }],
    products: [...catalog, deal],
    fulfilment: "delivery",
  });
  assert.deepEqual(recommendations.map((entry) => entry.product.id), ["chocolate-brownie"]);
});

test("filters sold-out, setup, fulfilment-ineligible and already-expired candidates", () => {
  const unavailable = [
    { ...dip, sold_out: 1 },
    { ...garlic, setup_required: 1 },
    { ...fourPops, delivery_eligible: 0 },
    {
      ...pop,
      configuration: {
        availability: { weekdays: [1], startMinute: 0, endMinute: 30, timeZone: "UTC" },
      },
    },
  ];
  const recommendations = recommendUpsells({
    cart: [{ productId: pizza.id, name: pizza.name, categoryId: pizza.category_id, quantity: 1 }],
    products: [pizza, ...unavailable, brownie],
    fulfilment: "delivery",
    now: new Date("2026-09-08T12:00:00Z"),
  });
  assert.deepEqual(recommendations.map((entry) => entry.product.id), ["chocolate-brownie"]);
});

test("returns no aggressive meal recommendation for drink- or dessert-only carts", () => {
  const recommendations = recommendUpsells({
    cart: [{ productId: pop.id, name: pop.name, categoryId: pop.category_id, quantity: 1 }],
    products: catalog,
    fulfilment: "pickup",
  });
  assert.deepEqual(recommendations, []);
});

test("explicit merchandising metadata overrides inference and candidate priority", () => {
  const customMeal = product({
    id: "chef-box",
    name: "Chef Box",
    category_id: "misc",
    configuration: { merchandising: { roles: ["meal"], includes: ["side"], serves: 1 } },
  });
  const preferredWater = product({
    id: "sparkling-water",
    name: "Sparkling Water",
    category_id: "misc",
    base_price_cents: 250,
    configuration: { merchandising: { roles: ["drink"], upsellPriority: 50 } },
  });
  assert.deepEqual([...productUpsellRoles(customMeal)], ["meal"]);
  assert.deepEqual([...includedUpsellRoles(customMeal)], ["side"]);

  const recommendations = recommendUpsells({
    cart: [{ productId: customMeal.id, name: customMeal.name, categoryId: customMeal.category_id, quantity: 1 }],
    products: [customMeal, preferredWater, brownie],
    fulfilment: "pickup",
  });
  assert.deepEqual(recommendations.map((entry) => entry.product.id), ["sparkling-water", "chocolate-brownie"]);
});

test("a selected optional dip suppresses the standalone dip recommendation", () => {
  const hero = product({
    id: "hero",
    name: "Pizza Hero",
    category_id: "deals",
    product_type: "bundle",
  });
  const recommendations = recommendUpsells({
    cart: [{
      productId: hero.id,
      name: hero.name,
      categoryId: hero.category_id,
      quantity: 1,
      modifiers: [{ id: "dipping-sauce", label: "Dipping sauce", values: [{ value: "add", label: "Add dipping sauce" }] }],
    }],
    products: [...catalog, hero],
    fulfilment: "pickup",
  });
  assert.ok(!recommendations.some((entry) => entry.product.id === "standard-dip"));
});
