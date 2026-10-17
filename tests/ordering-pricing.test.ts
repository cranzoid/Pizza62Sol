import assert from "node:assert/strict";
import test from "node:test";
import { cashChange, normalizeToppings, parseCashTender, priceModifierSelections, pricePizza, priceSharedToppingPool, toppingUnitsBps, type ModifierSection, type ToppingSelection } from "@/lib/domain";
import { changeDrinkQuantity, drinkSummary, includedDrinkPools } from "@/lib/drink-slots";
import { snapshotDetails } from "@/lib/order-presentation";
import { MENU_PRODUCTS } from "@/lib/menu";

const topping = (toppingId: string, placement: ToppingSelection["placement"] = "whole"): ToppingSelection => ({ toppingId, placement });
const pizza = (toppings: ToppingSelection[]) => pricePizza({ basePriceCents: 1000, includedToppingUnitsBps: 10_000, extraToppingPriceCents: 230, halfToppingUnitsBps: 5000, extraCheese: false, toppings });

test("opposite distinct halves use one unit; uneven splits charge proportionally", () => {
  assert.equal(pizza([topping("pepperoni", "left"), topping("mushrooms", "right")]).totalCents, 1000);
  assert.equal(pizza([topping("pepperoni"), topping("mushrooms", "left")]).extraToppingTotalCents, 115);
});
test("duplicates normalize before weighted charging", () => {
  const selections = [topping("real-chicken", "left"), topping("real-chicken", "right"), topping("real-chicken", "left")];
  assert.deepEqual(normalizeToppings(selections), [topping("real-chicken")]);
  assert.equal(pizza(selections).toppingUnitsBps, 20_000);
  assert.equal(pizza(selections).extraToppingTotalCents, 230);
});
test("chicken uses its stable id, with a half consuming one unit", () => {
  assert.equal(toppingUnitsBps([topping("real-chicken", "left")]), 10_000);
  assert.equal(toppingUnitsBps([topping("real-chicken")]), 20_000);
  assert.equal(toppingUnitsBps([topping("chicken-burger"), topping("Butter Chicken")]), 20_000);
  const sauces: ModifierSection[] = [{ id: "sauce", label: "Sauce", source: "sauce", min: 0, max: 1 }];
  assert.equal(priceModifierSelections(sauces, [{ id: "sauce", values: ["Butter Chicken"] }]).extraCents, 149);
});
test("shared pizza and modifier allowances apply the same weighted units", () => {
  const pool = priceSharedToppingPool([
    { lineId: "one", basePriceCents: 0, extraToppingPriceCents: 230, includedToppingUnitsBps: 0, halfToppingUnitsBps: 5000, extraCheese: false, toppings: [topping("real-chicken"), topping("onions")] },
    { lineId: "two", basePriceCents: 0, extraToppingPriceCents: 230, includedToppingUnitsBps: 0, halfToppingUnitsBps: 5000, extraCheese: false, toppings: [topping("pepperoni", "left")] },
  ], 30_000);
  assert.equal(pool.pizzas[1].extraToppingTotalCents, 115);
  const sections: ModifierSection[] = ["one", "two"].map((id) => ({ id, label: id, source: "toppings", min: 0, max: 12, sharedGroup: "pizzas", sharedIncluded: 3, extraPriceCents: 230 }));
  const priced = priceModifierSelections(sections, [{ id: "one", values: ["real-chicken", "onions", "onions"] }, { id: "two", values: [{ value: "pepperoni", placement: "left" }] }]);
  assert.equal(priced.extraCents, 115);
  assert.equal(priced.pools.pizzas.unitsBps, 35_000);
});
test("every specialty recipe keeps its menu price, and omissions never give replacement credit", () => {
  for (const product of MENU_PRODUCTS.filter((entry) => entry.configuration?.fixedRecipe)) {
    const recipe = product.configuration!.recipeToppingIds as string[];
    for (const variation of product.variations!) {
      const input = { basePriceCents: variation.basePriceCents, extraToppingPriceCents: variation.extraToppingPriceCents, includedToppingUnitsBps: variation.includedToppingUnitsBps!, halfToppingUnitsBps: 5000, extraCheese: Boolean(product.configuration!.presetExtraCheese), recipeToppingIds: recipe, recipeExtraCheese: Boolean(product.configuration!.presetExtraCheese) };
      assert.equal(pricePizza({ ...input, toppings: recipe.map((id) => topping(id)) }).totalCents, variation.basePriceCents);
      assert.equal(pricePizza({ ...input, toppings: [], extraCheese: false }).totalCents, variation.basePriceCents);
      assert.equal(pricePizza({ ...input, toppings: [topping("corn", "left")] }).totalCents, variation.basePriceCents + Math.round(variation.extraToppingPriceCents / 2));
    }
  }
});
test("strict cash input, short payment, rounding and gift-card remainder", () => {
  assert.equal(cashChange(1655, parseCashTender("20")!).changeCents, 345);
  assert.equal(cashChange(1655, parseCashTender("10.00")!).shortCents, 655);
  assert.equal(cashChange(1657, 2000).roundedTotalCents, 1655);
  assert.equal(cashChange(1655 - 500, 2000).changeCents, 845);
  for (const input of ["", "-20", "$20", "1e2", "20.001", "20.0.0", "20,00", "abc20", "Infinity", "9007199254740992"]) assert.equal(parseCashTender(input), null, input);
});
const slots: ModifierSection[] = Array.from({ length: 4 }, (_, index) => ({ id: `drink-${index + 1}`, label: `Pop ${index + 1}`, source: "drinks", min: 1, max: 1 }));
test("four Pepsi, mixtures and limits encode into the original slot ids", () => {
  let selected: Parameters<typeof changeDrinkQuantity>[1] = {};
  for (let i = 0; i < 4; i++) selected = changeDrinkQuantity(slots, selected, "Pepsi", 1);
  assert.deepEqual(Object.keys(selected), slots.map((slot) => slot.id));
  assert.equal(changeDrinkQuantity(slots, selected, "Coke", 1), selected);
  assert.equal(drinkSummary(Object.entries(selected).map(([id, values]) => ({ id, values })), slots)[0].text, "Pepsi ×4");
  selected = changeDrinkQuantity(slots, selected, "Pepsi", -1);
  selected = changeDrinkQuantity(slots, selected, "Coke", 1);
  assert.equal(drinkSummary(Object.entries(selected).map(([id, values]) => ({ id, values })), slots)[0].text, "Pepsi ×3, Coke ×1");
  assert.equal(priceModifierSelections(slots, Object.entries(selected).map(([id, values]) => ({ id, values }))).extraCents, 0);
});
test("different canned slots and two-litre bottles stay separate", () => {
  assert.equal(includedDrinkPools([...slots, { ...slots[0], id: "special", options: ["Pepsi"] }, { ...slots[0], id: "bottle", source: "two_litre_drinks" }])[0].length, 4);
  const modifiers = slots.map((slot) => ({ id: slot.id, label: slot.label, values: [{ value: "Pepsi", label: "Pepsi" }] }));
  const details = snapshotDetails({ modifiers, productConfiguration: { sections: slots } }, new Map());
  assert.deepEqual(details, [{ label: "Included drinks", value: "Pepsi ×4" }]);
  assert.equal(modifiers.length, 4);
});
