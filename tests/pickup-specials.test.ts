import assert from "node:assert/strict";
import test from "node:test";

const { MENU_PRODUCTS, PICKUP_SPECIALS_RELEASE_PRODUCT_IDS } = await import("@/lib/menu");

const product = (id: string) => {
  const found = MENU_PRODUCTS.find((entry) => entry.id === id);
  assert.ok(found, `${id} must exist in the menu seed`);
  return found;
};

const sections = (id: string) =>
  (product(id).configuration?.sections ?? []) as Array<{
    id: string;
    label: string;
    group?: string;
    source?: string;
    options?: string[];
    min: number;
    max: number;
    included?: number;
  }>;

test("the release product ids are unique and present once", () => {
  assert.equal(new Set(PICKUP_SPECIALS_RELEASE_PRODUCT_IDS).size, PICKUP_SPECIALS_RELEASE_PRODUCT_IDS.length);
  for (const id of PICKUP_SPECIALS_RELEASE_PRODUCT_IDS) {
    assert.equal(MENU_PRODUCTS.filter((entry) => entry.id === id).length, 1, `${id} must not be duplicated`);
  }
});

test("the three slice products are pickup-only and genuinely tax exempt", () => {
  const expected = new Map([
    ["slice-combo", 450],
    ["two-slice-combo", 725],
    ["pickup-one-slice", 275],
  ]);
  for (const [id, price] of expected) {
    const entry = product(id);
    assert.equal(entry.categoryId, "pickup-specials");
    assert.equal(entry.basePriceCents, price);
    assert.equal(entry.taxable, false, `${id} must seed products.taxable = 0`);
    assert.equal(entry.pickupEligible, true);
    assert.equal(entry.deliveryEligible, false);
  }
});

test("slice combos require independent toppings, the included dip, and every included pop", () => {
  const one = sections("slice-combo");
  assert.deepEqual(
    one.map((section) => section.id),
    ["slice-topping", "included-dip", "drink-1"],
  );
  assert.deepEqual(
    one.find((section) => section.id === "slice-topping"),
    {
      id: "slice-topping",
      label: "Choose 1 topping",
      group: "Your slice",
      source: "toppings",
      min: 1,
      max: 1,
      included: 1,
      extraPriceCents: 0,
    },
  );

  const two = sections("two-slice-combo");
  const toppingSections = two.filter((section) => section.source === "toppings");
  assert.deepEqual(toppingSections.map((section) => section.id), ["slice-1-topping", "slice-2-topping"]);
  assert.deepEqual(toppingSections.map((section) => section.group), ["Slice 1", "Slice 2"]);
  assert.ok(toppingSections.every((section) => section.min === 1 && section.max === 1));

  for (const combo of [one, two]) {
    const dip = combo.find((section) => section.id === "included-dip");
    assert.deepEqual(dip?.options, ["Dipping Sauce"]);
    assert.equal(dip?.min, 1);
    assert.equal(dip?.max, 1);
    const pop = combo.find((section) => section.id === "drink-1");
    assert.equal(pop?.source, "drinks");
    assert.equal(pop?.min, 1);
    assert.equal(pop?.max, 1);
    assert.equal(pop?.options, undefined, "pop flavours must remain connected to the canonical live list");
  }
});

test("the standalone slice requires one topping and invents no other choices", () => {
  const choices = sections("pickup-one-slice");
  assert.equal(choices.length, 1);
  assert.equal(choices[0].source, "toppings");
  assert.equal(choices[0].min, 1);
  assert.equal(choices[0].max, 1);
});

test("one pop and four pops use live flavours and remain normally taxable", () => {
  for (const [id, price, count] of [["one-pop", 160, 1], ["four-pops", 499, 4]] as const) {
    const entry = product(id);
    assert.equal(entry.categoryId, "drinks");
    assert.equal(entry.basePriceCents, price);
    assert.notEqual(entry.taxable, false);
    assert.notEqual(entry.pickupEligible, false);
    assert.notEqual(entry.deliveryEligible, false);
    const popSections = sections(id);
    assert.equal(popSections.length, count);
    assert.ok(popSections.every((section) => section.source === "drinks" && section.min === 1 && section.max === 1));
    assert.ok(popSections.every((section) => section.options === undefined));
  }
});

test("the ten confirmed pickup pizzas use exact prices and topping allowances", () => {
  const expected = [
    ["pickup-medium-one", 899, 1], ["pickup-medium-three", 1249, 3],
    ["pickup-large-one", 1199, 1], ["pickup-large-three", 1499, 3],
    ["pickup-xl-one", 1299, 1], ["pickup-xl-three", 1599, 3],
    ["pickup-jumbo-one", 2049, 1], ["pickup-jumbo-three", 2399, 3],
    ["pickup-slab-one", 2199, 1], ["pickup-slab-three", 2599, 3],
  ] as const;
  for (const [id, price, included] of expected) {
    const entry = product(id);
    assert.equal(entry.categoryId, "pickup-specials");
    assert.equal(entry.productType, "pizza");
    assert.equal(entry.basePriceCents, price);
    assert.equal(entry.deliveryEligible, false);
    assert.notEqual(entry.taxable, false);
    assert.equal(entry.configuration?.requireIncludedToppings, true);
    assert.equal(entry.variations?.length, 1);
    assert.equal(entry.variations?.[0].basePriceCents, price);
    assert.equal(entry.variations?.[0].includedToppingUnitsBps, included * 10_000);
  }

  assert.equal(product("pickup-medium-five").basePriceCents, 1299, "the existing five-topping offer stays separate");
});
