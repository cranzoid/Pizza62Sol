import assert from "node:assert/strict";
import test from "node:test";

const { isWithinWeeklyAvailability } = await import("@/lib/domain");
const { GAME_DAY_AVAILABILITY, GAME_DAY_SPECIAL_PRODUCT_ID, MENU_PRODUCTS } = await import("@/lib/menu");

const special = MENU_PRODUCTS.find((entry) => entry.id === GAME_DAY_SPECIAL_PRODUCT_ID);

type Section = {
  id: string;
  label: string;
  group?: string;
  source?: string;
  options?: string[];
  min: number;
  max: number;
  included?: number;
  extraPriceCents?: number;
};

const sections = () => ((special?.configuration?.sections ?? []) as Section[]);

test("the game day special is one product, priced and taxed as advertised", () => {
  assert.ok(special, "game-day-special must exist in the menu seed");
  assert.equal(MENU_PRODUCTS.filter((entry) => entry.id === GAME_DAY_SPECIAL_PRODUCT_ID).length, 1);
  assert.equal(special.categoryId, "deals");
  assert.equal(special.name, "Game Day Special");
  assert.equal(special.basePriceCents, 4999);
  // C$49.99 *plus tax* — the seed writes taxable = 1 unless it says otherwise.
  assert.notEqual(special.taxable, false);
  assert.equal(special.productType, "bundle");
});

test("it is sold on both pickup and delivery", () => {
  assert.notEqual(special?.pickupEligible, false);
  assert.notEqual(special?.deliveryEligible, false);
});

test("it contains the two pizzas, the wings, the garlic bread and the 2 L pop", () => {
  const built = sections();
  const toppingSections = built.filter((section) => section.source === "toppings");
  assert.deepEqual(toppingSections.map((section) => section.id), ["pizza-1-toppings", "pizza-2-toppings"]);
  assert.deepEqual(toppingSections.map((section) => section.group), ["Pizza 1", "Pizza 2"]);
  for (const section of toppingSections) {
    assert.equal(section.included, 3, "three toppings are included on each pizza");
    assert.equal(section.extraPriceCents, 230, "a fourth topping is charged at the standard large rate");
  }

  const wings = built.find((section) => section.source === "wing_flavours");
  assert.equal(wings?.min, 1);
  assert.equal(wings?.max, 2, "2 lb of wings can be split across two sauces");

  const garlicBread = built.find((section) => section.id === "included-garlic-bread");
  assert.deepEqual(garlicBread?.options, ["Garlic Bread"]);
  assert.equal(garlicBread?.min, 1, "an included item must reach the kitchen ticket");
  assert.equal(garlicBread?.max, 1);

  const pop = built.find((section) => section.id === "two-litre-pop");
  assert.equal(pop?.source, "drinks");
  assert.equal(pop?.min, 1);
  assert.equal(pop?.max, 1);
  assert.equal(pop?.options, undefined, "pop flavours must stay connected to the canonical live list");
});

test("it leads the offers strip and is drawn in its own colour", () => {
  assert.equal(special?.configuration?.featured, true);
});

test("it runs on 29 and 30 August 2026 in Toronto, and on no other day", () => {
  const availability = GAME_DAY_AVAILABILITY;
  assert.equal(special?.configuration?.availability, availability);

  // 04:00 UTC is midnight in Toronto (EDT), so these are the first and last
  // minutes of the two game days as the restaurant experiences them.
  assert.equal(isWithinWeeklyAvailability(availability, new Date("2026-08-29T04:00:00Z")), true);
  assert.equal(isWithinWeeklyAvailability(availability, new Date("2026-08-30T18:30:00Z")), true);
  assert.equal(isWithinWeeklyAvailability(availability, new Date("2026-08-31T03:59:00Z")), true);

  // The minute before it opens and the minute after it closes.
  assert.equal(isWithinWeeklyAvailability(availability, new Date("2026-08-29T03:59:00Z")), false);
  assert.equal(isWithinWeeklyAvailability(availability, new Date("2026-08-31T04:00:00Z")), false);

  // The following weekend is the failure a weekday-only rule would have caused.
  assert.equal(isWithinWeeklyAvailability(availability, new Date("2026-09-05T18:00:00Z")), false);
  assert.equal(isWithinWeeklyAvailability(availability, new Date("2026-09-06T18:00:00Z")), false);
});

test("the regular deals keep their own prices and stay available every day", () => {
  const untouched = [
    ["deal-two-large-wings", 5399],
    ["deal-two-medium-wings", 4399],
    ["deal-two-xl-wings", 5699],
  ] as const;
  for (const [id, priceCents] of untouched) {
    const deal = MENU_PRODUCTS.find((entry) => entry.id === id);
    assert.ok(deal, `${id} must still exist`);
    assert.equal(deal.basePriceCents, priceCents, `${id} must not be repriced by the game day offer`);
    assert.equal(deal.configuration?.availability, undefined, `${id} must stay on the menu every day`);
  }
});
