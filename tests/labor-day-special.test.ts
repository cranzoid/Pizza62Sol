import assert from "node:assert/strict";
import test from "node:test";

const { isWithinWeeklyAvailability } = await import("@/lib/domain");
const {
  LABOR_DAY_AVAILABILITY,
  LABOR_DAY_COMBO_PRODUCT_ID,
  LABOR_DAY_WINGS_PRODUCT_ID,
  MENU_PRODUCTS,
} = await import("@/lib/menu");

const product = (id: string) => {
  const found = MENU_PRODUCTS.find((entry) => entry.id === id);
  assert.ok(found, `${id} must exist in the menu seed`);
  return found;
};

test("the $1 wing offer is pickup-only, quantity-selectable, and first in the menu seed", () => {
  const wings = product(LABOR_DAY_WINGS_PRODUCT_ID);
  assert.equal(MENU_PRODUCTS[0]?.id, LABOR_DAY_WINGS_PRODUCT_ID);
  assert.equal(wings.basePriceCents, 100);
  assert.equal(wings.productType, "configurable");
  assert.equal(wings.pickupEligible, true);
  assert.equal(wings.deliveryEligible, false);
  assert.equal(wings.configuration?.featured, true);
  assert.equal(wings.configuration?.quantitySelectable, true);
  assert.equal(wings.configuration?.maxQuantity, 40);
  const sections = wings.configuration?.sections as Array<{ source?: string; min: number; max: number }>;
  assert.equal(sections.length, 2);
  assert.deepEqual(sections[1], { id: "wing-flavours", label: "Sauces & dry rubs", source: "wing_flavours", min: 1, max: 1 });
});

test("the $1 wing offer runs only on Labor Day in Toronto", () => {
  assert.equal(isWithinWeeklyAvailability(LABOR_DAY_AVAILABILITY, new Date("2026-09-07T04:00:00Z")), true);
  assert.equal(isWithinWeeklyAvailability(LABOR_DAY_AVAILABILITY, new Date("2026-09-08T03:59:00Z")), true);
  assert.equal(isWithinWeeklyAvailability(LABOR_DAY_AVAILABILITY, new Date("2026-09-07T03:59:00Z")), false);
  assert.equal(isWithinWeeklyAvailability(LABOR_DAY_AVAILABILITY, new Date("2026-09-08T04:00:00Z")), false);
});

test("the existing $25.99 combo includes the full advertised meal and free delivery", () => {
  const combo = product(LABOR_DAY_COMBO_PRODUCT_ID);
  assert.equal(combo.basePriceCents, 2599);
  assert.equal(combo.pickupEligible, true);
  assert.notEqual(combo.deliveryEligible, false);
  assert.equal(combo.configuration?.freeDelivery, true);
  const sections = combo.configuration?.sections as Array<{ id: string; source?: string; included?: number }>;
  assert.equal(sections.filter((section) => section.source === "toppings").length, 1);
  assert.equal(sections.find((section) => section.source === "toppings")?.included, 3);
  assert.equal(sections.filter((section) => section.source === "wing_flavours").length, 1);
  assert.equal(sections.filter((section) => section.source === "drinks").length, 3);
  assert.equal(sections.filter((section) => section.id === "included-dip").length, 1);
});
