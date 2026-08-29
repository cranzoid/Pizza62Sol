import assert from "node:assert/strict";
import test from "node:test";
import {
  ONTARIO_WEEKLY_OVERTIME_MINUTES,
  applyPromotions,
  buildTimesheet,
  cashChange,
  explainPromotionMiss,
  roundCashCents,
  buildWorkSessions,
  grossPayCents,
  payPeriodFor,
  splitOvertime,
  calculatePaidMilliseconds,
  canTransitionOrderStatus,
  generateOpaqueToken,
  hashOpaqueToken,
  hasPermission,
  inspectClockTimeline,
  isWithinWeeklyAvailability,
  isTimeWithinConfiguredHours,
  isStoreOpenAt,
  nextOrderSlots,
  storeStatus,
  zonedParts,
  modifierUnitsBps,
  normalizeModifierValues,
  normalizeToppings,
  orderModifierSections,
  priceCart,
  pricePizza,
  priceSharedToppingPool,
  validateDelivery,
  validateRefundAmount,
  CRUST_OPTIONS,
  compareMenuPrice,
} from "../lib/domain.ts";
import { FEEDBACK_REWARD_PRODUCT_IDS, MENU_PRODUCTS, PIZZA_BY_SIZE_PRODUCT_IDS } from "../lib/menu.ts";
import { PIZZA_BY_SIZE_INCLUDED_TOPPINGS, PIZZA_SIZES, REGULAR_HOURS, LAUNCH_SETTINGS } from "../lib/launch-config.ts";
import { resolveFsaCentroid } from "../lib/delivery-area.ts";

test("charges one Pizza by Size price for any one to four toppings", () => {
  const expected = [
    ["Medium", 1699, 210],
    ["Large", 1799, 230],
    ["X-Large", 1899, 260],
    ["Jumbo", 2399, 290],
    ["Slab", 2799, 290],
  ];
  assert.deepEqual(
    PIZZA_SIZES.map((size) => [size.name, size.basePriceCents, size.extraToppingPriceCents]),
    expected,
  );
  const included = PIZZA_BY_SIZE_INCLUDED_TOPPINGS;
  assert.equal(included, 4);
  const toppings = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ toppingId: `topping-${index}`, placement: "whole" as const }));
  for (const size of PIZZA_SIZES) {
    // One topping or all four, the customer pays the same.
    for (let count = 1; count <= included; count += 1) {
      const price = pricePizza({
        basePriceCents: size.basePriceCents,
        extraToppingPriceCents: size.extraToppingPriceCents,
        includedToppingUnitsBps: included * 10_000,
        halfToppingUnitsBps: 10_000,
        toppings: toppings(count),
        extraCheese: false,
      });
      assert.equal(price.totalCents, size.basePriceCents, `${size.name} with ${count} topping(s)`);
    }
    // The fifth is the first one charged for.
    const fifth = pricePizza({
      basePriceCents: size.basePriceCents,
      extraToppingPriceCents: size.extraToppingPriceCents,
      includedToppingUnitsBps: included * 10_000,
      halfToppingUnitsBps: 10_000,
      toppings: toppings(included + 1),
      extraCheese: false,
    });
    assert.equal(fifth.totalCents, size.basePriceCents + size.extraToppingPriceCents);
  }
});

test("sells Pizza by Size on delivery only, and never under the pickup special", () => {
  const byId = new Map(MENU_PRODUCTS.map((product) => [product.id, product]));
  for (const productId of PIZZA_BY_SIZE_PRODUCT_IDS) {
    const product = byId.get(productId)!;
    assert.equal(product.categoryId, "build-your-own");
    assert.equal(product.pickupEligible, false, `${productId} must not be sellable on pickup`);
    assert.equal(product.deliveryEligible, true, `${productId} must stay sellable on delivery`);
    // One option, not a 1-topping and a 3-topping one, because the price no
    // longer varies with how many of the four included toppings are used.
    assert.equal(product.variations?.length, 1);
    assert.equal(
      product.variations?.[0].includedToppingUnitsBps,
      PIZZA_BY_SIZE_INCLUDED_TOPPINGS * 10_000,
    );
    assert.equal(product.variations?.[0].basePriceCents, product.basePriceCents);
  }
  // The reason pickup is excluded: every pickup single pizza undercuts the
  // delivery list, so offering both on pickup would sell the cheap one twice.
  const pickupSingles = MENU_PRODUCTS.filter(
    (product) => product.categoryId === "pickup-specials" && product.productType === "pizza",
  );
  const cheapestBySize = Math.min(...PIZZA_SIZES.map((size) => size.basePriceCents));
  assert.ok(pickupSingles.length > 0);
  assert.ok(
    pickupSingles.every((product) => product.pickupEligible === true && product.deliveryEligible === false),
  );
  assert.ok(Math.min(...pickupSingles.map((product) => product.basePriceCents)) < cheapestBySize);
});

test("orders a menu category by price, cheapest first", () => {
  const category = [
    { id: "c", name: "Two Large Feast", base_price_cents: 5399 },
    { id: "a", name: "Slice Combo", base_price_cents: 450 },
    { id: "b", name: "2 Slice Combo", base_price_cents: 725 },
    { id: "d", name: "1 Slice", base_price_cents: 275 },
  ];
  assert.deepEqual(
    [...category].sort(compareMenuPrice).map((product) => product.id),
    ["d", "a", "b", "c"],
  );
  // Equal prices settle on the name, so the order does not depend on the order
  // the rows came back in.
  const tied = [
    { id: "second", name: "Water Bottle", base_price_cents: 160 },
    { id: "first", name: "1 Pop", base_price_cents: 160 },
  ];
  assert.deepEqual(
    [...tied].sort(compareMenuPrice).map((product) => product.id),
    ["first", "second"],
  );
  // Sorting is stable enough to be idempotent.
  const once = [...category].sort(compareMenuPrice);
  assert.deepEqual([...once].sort(compareMenuPrice), once);
});

test("limits Hamilton Heroes to the flyer window in Toronto", () => {
  const offer = { weekdays: [1, 2, 3, 4, 5], startMinute: 17 * 60, endMinute: 21 * 60, timeZone: "America/Toronto" };
  assert.equal(isWithinWeeklyAvailability(offer, new Date("2026-07-20T21:00:00Z")), true);
  assert.equal(isWithinWeeklyAvailability(offer, new Date("2026-07-21T01:00:00Z")), true);
  assert.equal(isWithinWeeklyAvailability(offer, new Date("2026-07-21T01:01:00Z")), false);
  assert.equal(isWithinWeeklyAvailability(offer, new Date("2026-07-19T22:00:00Z")), false);
});

test("calendar bounds close a one-off offer instead of repeating it weekly", () => {
  const weekend = {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    startMinute: 0,
    endMinute: 1440,
    timeZone: "America/Toronto",
    startDate: "2026-08-29",
    endDate: "2026-08-30",
  };
  assert.equal(isWithinWeeklyAvailability(weekend, new Date("2026-08-29T04:00:00Z")), true);
  assert.equal(isWithinWeeklyAvailability(weekend, new Date("2026-08-31T03:59:00Z")), true);
  assert.equal(isWithinWeeklyAvailability(weekend, new Date("2026-08-29T03:59:00Z")), false);
  assert.equal(isWithinWeeklyAvailability(weekend, new Date("2026-08-31T04:00:00Z")), false);
  assert.equal(isWithinWeeklyAvailability(weekend, new Date("2026-09-05T18:00:00Z")), false);

  // One bound on its own is honoured; a malformed one closes the offer rather
  // than being ignored and letting it run forever.
  assert.equal(isWithinWeeklyAvailability({ ...weekend, endDate: undefined }, new Date("2027-01-01T18:00:00Z")), true);
  assert.equal(isWithinWeeklyAvailability({ ...weekend, startDate: undefined }, new Date("2020-01-01T18:00:00Z")), true);
  assert.equal(isWithinWeeklyAvailability({ ...weekend, endDate: "30/08/2026" }, new Date("2026-08-29T18:00:00Z")), false);
});

test("normalizes the same topping on both halves and prevents triple charging", () => {
  assert.deepEqual(
    normalizeToppings([
      { toppingId: "pepperoni", placement: "left" },
      { toppingId: "pepperoni", placement: "right" },
      { toppingId: "pepperoni", placement: "whole" },
    ]),
    [{ toppingId: "pepperoni", placement: "whole" }],
  );
});

test("counts one-sided half toppings as a full unit at launch", () => {
  const price = pricePizza({
    basePriceCents: 1149,
    extraToppingPriceCents: 230,
    includedToppingUnitsBps: 10_000,
    halfToppingUnitsBps: 10_000,
    toppings: [
      { toppingId: "pepperoni", placement: "left" },
      { toppingId: "jalapeno", placement: "right" },
    ],
    extraCheese: false,
  });
  assert.equal(price.toppingUnitsBps, 20_000);
  assert.equal(price.paidUnitsBps, 10_000);
  assert.equal(price.extraToppingTotalCents, 230);
});

test("supports future half-unit configuration without changing the engine", () => {
  const price = pricePizza({
    basePriceCents: 840,
    extraToppingPriceCents: 210,
    includedToppingUnitsBps: 0,
    halfToppingUnitsBps: 5_000,
    toppings: [{ toppingId: "onion", placement: "left" }],
    extraCheese: false,
  });
  assert.equal(price.toppingUnitsBps, 5_000);
  assert.equal(price.extraToppingTotalCents, 105);
});

test("extra cheese uses the included allowance before becoming paid", () => {
  const included = pricePizza({
    basePriceCents: 840,
    extraToppingPriceCents: 210,
    includedToppingUnitsBps: 10_000,
    halfToppingUnitsBps: 10_000,
    toppings: [],
    extraCheese: true,
  });
  assert.equal(included.extraToppingTotalCents, 0);
  const paid = pricePizza({ ...{
    basePriceCents: 840,
    extraToppingPriceCents: 210,
    includedToppingUnitsBps: 0,
    halfToppingUnitsBps: 10_000,
    toppings: [],
    extraCheese: true,
  }});
  assert.equal(paid.extraToppingTotalCents, 210);
});

test("allocates the shared six-topping pool across two pizzas", () => {
  const createToppings = (count: number) => Array.from({ length: count }, (_, index) => ({
    toppingId: `t${index}`,
    placement: "whole" as const,
  }));
  const result = priceSharedToppingPool(
    [
      { lineId: "one", basePriceCents: 0, extraToppingPriceCents: 230, includedToppingUnitsBps: 0, halfToppingUnitsBps: 10_000, toppings: createToppings(4), extraCheese: false },
      { lineId: "two", basePriceCents: 0, extraToppingPriceCents: 230, includedToppingUnitsBps: 0, halfToppingUnitsBps: 10_000, toppings: createToppings(4), extraCheese: false },
    ],
    60_000,
  );
  assert.equal(result.pizzas[0].paidUnitsBps, 0);
  assert.equal(result.pizzas[1].paidUnitsBps, 20_000);
  assert.equal(result.pizzas[1].extraToppingTotalCents, 460);
  assert.equal(result.remainingUnitsBps, 0);
});

test("prices gourmet and pizza-sub style included topping allowances generically", () => {
  const gourmet = pricePizza({ basePriceCents: 1800, extraToppingPriceCents: 230, includedToppingUnitsBps: 0, halfToppingUnitsBps: 10_000, toppings: [{ toppingId: "extra", placement: "whole" }], extraCheese: false });
  assert.equal(gourmet.totalCents, 2030);
  const sub = pricePizza({ basePriceCents: 999, extraToppingPriceCents: 120, includedToppingUnitsBps: 30_000, halfToppingUnitsBps: 10_000, toppings: [1,2,3,4].map((index) => ({ toppingId: `t${index}`, placement: "whole" as const })), extraCheese: false });
  assert.equal(sub.totalCents, 1119);
});

test("applies stackable discounts deterministically and blocks incompatible ones", () => {
  const lines = [{ id: "1", productId: "pizza", categoryId: "pizza", quantity: 1, unitPriceCents: 2000, taxable: true, promotionEligible: true }];
  const applied = applyPromotions(lines, [
    { id: "ten", name: "10%", type: "percentage", amount: 1000, priority: 20, combinable: true, exclusive: false, stackGroup: "percent" },
    { id: "five", name: "$5", type: "fixed", amount: 500, priority: 10, combinable: true, exclusive: false },
    { id: "other-percent", name: "20%", type: "percentage", amount: 2000, priority: 1, combinable: true, exclusive: false, stackGroup: "percent" },
  ], "pickup");
  assert.equal(applied.discountCents, 700);
  assert.deepEqual(applied.applied.map((entry) => entry.id), ["ten", "five"]);
});

/**
 * THANKS62 is a garlic bread or a drink, and nothing else.
 *
 * The failure this guards is quiet and expensive: a fixed C$3.99 with no
 * product targeting comes off a C$40 pizza order exactly as happily as off the
 * side it was meant for, and nothing on the receipt says so.
 */
test("the feedback thank-you comes off garlic bread and drinks only", () => {
  const reward = {
    id: "feedback-thank-you",
    name: "Feedback thank-you",
    code: "THANKS62",
    type: "fixed" as const,
    amount: 399,
    priority: 0,
    combinable: true,
    exclusive: false,
    minimumCents: 1500,
    productIds: [...FEEDBACK_REWARD_PRODUCT_IDS],
  };
  const pizzaOnly = [{ id: "1", productId: "large-pizza", categoryId: "build-your-own", quantity: 1, unitPriceCents: 2400, taxable: true, promotionEligible: true }];
  assert.equal(applyPromotions(pizzaOnly, [reward], "pickup").discountCents, 0);

  const withGarlicBread = [
    ...pizzaOnly,
    { id: "2", productId: "garlic-bread", categoryId: "sides", quantity: 1, unitPriceCents: 399, taxable: true, promotionEligible: true },
  ];
  assert.equal(applyPromotions(withGarlicBread, [reward], "pickup").discountCents, 399);

  // Never more than the eligible line is worth: a C$1.60 pop is free, not free
  // with C$2.39 off the pizza beside it.
  const withOnePop = [
    ...pizzaOnly,
    { id: "3", productId: "one-pop", categoryId: "drinks", quantity: 1, unitPriceCents: 160, taxable: true, promotionEligible: true },
  ];
  assert.equal(applyPromotions(withOnePop, [reward], "pickup").discountCents, 160);
});

test("says why a code did not come off, in the order the pricing decides it", () => {
  const reward = {
    id: "feedback-thank-you",
    name: "Feedback thank-you",
    code: "THANKS62",
    type: "fixed" as const,
    amount: 399,
    priority: 0,
    combinable: true,
    exclusive: false,
    minimumCents: 1500,
    productIds: [...FEEDBACK_REWARD_PRODUCT_IDS],
  };
  const pizza = { id: "1", productId: "large-pizza", categoryId: "build-your-own", quantity: 1, unitPriceCents: 2400, taxable: true, promotionEligible: true };
  const bread = { id: "2", productId: "garlic-bread", categoryId: "sides", quantity: 1, unitPriceCents: 399, taxable: true, promotionEligible: true };

  // A big enough order with nothing eligible in it: the reason is the items.
  assert.deepEqual(explainPromotionMiss([pizza], reward, "pickup"), { reason: "items" });

  // The minimum is reported before the items, because it is checked first and
  // because "add C$11.01 more" is the more useful of the two answers.
  const miss = explainPromotionMiss([bread], reward, "pickup");
  assert.deepEqual(miss, { reason: "minimum", minimumCents: 1500, shortfallCents: 1101 });

  // Fulfilment beats both.
  assert.deepEqual(
    explainPromotionMiss([pizza], { ...reward, fulfilments: ["pickup"] }, "delivery"),
    { reason: "fulfilment", fulfilments: ["pickup"] },
  );

  // Eligible on every count, so what stopped it was the offer already applied.
  assert.deepEqual(
    explainPromotionMiss([pizza, bread], reward, "pickup", [{ id: "deal", name: "Two for one", discountCents: 500, reason: "" }]),
    { reason: "combination" },
  );

  // And an offer that would have applied has no explanation to give.
  assert.equal(explainPromotionMiss([pizza, bread], reward, "pickup"), null);
});

/**
 * Change at the counter.
 *
 * The penny has not been minted since 2012, so a cash total settles to the
 * nearest nickel while the bill itself does not move — get that backwards and
 * the till is out against the books by a cent or two on every cash order, which
 * is the kind of drift nobody finds for a month.
 */
test("rounds cash to the nearest nickel without moving the bill", () => {
  assert.equal(roundCashCents(1698), 1700);
  assert.equal(roundCashCents(1697), 1695);
  assert.equal(roundCashCents(1696), 1695);
  assert.equal(roundCashCents(1_23), 125);
  assert.equal(roundCashCents(1702), 1700);
  assert.equal(roundCashCents(0), 0);

  const change = cashChange(1698, 2000);
  assert.equal(change.totalCents, 1698, "the bill is untouched");
  assert.equal(change.roundedTotalCents, 1700);
  assert.equal(change.roundingCents, 2);
  assert.equal(change.changeCents, 300);
  assert.equal(change.shortCents, 0);
  assert.deepEqual(change.breakdown, [
    { label: "toonie", count: 1, valueCents: 200 },
    { label: "loonie", count: 1, valueCents: 100 },
  ]);
});

test("counts change out into notes and coins that add up", () => {
  const change = cashChange(1234, 5000);
  // 12.34 pays as 12.35, so 37.65 back.
  assert.equal(change.changeCents, 3765);
  assert.equal(
    change.breakdown.reduce((sum, part) => sum + part.count * part.valueCents, 0),
    change.changeCents,
    "the coins handed back have to equal the change owed",
  );
  assert.deepEqual(change.breakdown, [
    { label: "$20", count: 1, valueCents: 2000 },
    { label: "$10", count: 1, valueCents: 1000 },
    { label: "$5", count: 1, valueCents: 500 },
    { label: "toonie", count: 1, valueCents: 200 },
    { label: "quarter", count: 2, valueCents: 25 },
    { label: "dime", count: 1, valueCents: 10 },
    { label: "nickel", count: 1, valueCents: 5 },
  ]);
});

test("reports a short payment rather than negative change", () => {
  const change = cashChange(2000, 1000);
  assert.equal(change.changeCents, 0);
  assert.equal(change.shortCents, 1000);
  assert.deepEqual(change.breakdown, []);
  // Exact money is neither short nor owed.
  const exact = cashChange(2000, 2000);
  assert.equal(exact.changeCents, 0);
  assert.equal(exact.shortCents, 0);
});

// Owner decision, 2026-08-21: HST applies to the delivery fee. The tip basis is
// deliberately NOT the tax basis — a tip is calculated on discounted food alone,
// so it moves neither with the delivery fee nor with HST.
test("taxes the delivery fee and bases tips on discounted food only", () => {
  const total = priceCart({
    lines: [{ id: "1", productId: "pizza", categoryId: "pizza", quantity: 1, unitPriceCents: 2000, taxable: true, promotionEligible: true }],
    promotions: [{ id: "coupon", name: "$5 off", type: "fixed", amount: 500, priority: 1, combinable: true, exclusive: false }],
    fulfilment: "delivery",
    deliveryFeeCents: 350,
    taxRateBps: 1300,
    deliveryFeeTaxable: true,
    tip: { type: "percentage", valueBps: 1500 },
  });
  assert.equal(total.discountedMenuSubtotalCents, 1500);
  // 13% of (1500 discounted food + 350 delivery) = 240.5 -> 241, not 195.
  assert.equal(total.taxCents, 241);
  assert.equal(total.tipBasisCents, 1500);
  assert.equal(total.tipCents, 225);
  assert.equal(total.totalCents, 1500 + 241 + 350 + 225);
});

/**
 * The owner's own receipt, from the system this replaces.
 *
 * $30.99 of food, $5.00 shipping, $4.68 tax, $40.67 total. It is here as a test
 * rather than a comment because it is the only independent evidence of what the
 * restaurant has actually been charging: 13% on food *plus* shipping, not on
 * food alone. Reproducing it exactly is what confirms the rule was read right.
 *
 * The $5.00 is that system's shipping, not this one's $3.50 delivery fee — the
 * fee is a setting, the rule is not.
 */
test("reproduces the owner's real receipt exactly", () => {
  const total = priceCart({
    lines: [{ id: "1", productId: "pizza", categoryId: "pizza", quantity: 1, unitPriceCents: 3099, taxable: true, promotionEligible: true }],
    fulfilment: "delivery",
    deliveryFeeCents: 500,
    taxRateBps: 1300,
    deliveryFeeTaxable: true,
    tip: { type: "none" },
  });
  assert.equal(total.menuSubtotalCents, 3099);
  assert.equal(total.deliveryFeeCents, 500);
  // 13% of (3099 + 500) = 467.87 -> 468. On food alone it would be 403, and the
  // receipt would not match — which is the whole point of this test.
  assert.equal(total.taxCents, 468);
  assert.equal(total.totalCents, 4067);
});

// The flag is owner-editable in Admin → Settings, so both branches have to keep
// working — not just today's default.
test("honours delivery.feeTaxable in both directions", () => {
  const base = {
    lines: [{ id: "1", productId: "pizza", categoryId: "pizza", quantity: 1, unitPriceCents: 3999, taxable: true, promotionEligible: true }],
    fulfilment: "delivery" as const,
    deliveryFeeCents: 350,
    taxRateBps: 1300,
    tip: { type: "none" as const },
  };
  const taxed = priceCart({ ...base, deliveryFeeTaxable: true });
  const untaxed = priceCart({ ...base, deliveryFeeTaxable: false });
  // 13% of 4349 = 565.37 -> 565; 13% of 3999 = 519.87 -> 520.
  assert.equal(taxed.taxCents, 565);
  assert.equal(untaxed.taxCents, 520);
  assert.equal(taxed.totalCents, 3999 + 565 + 350);
  assert.equal(taxed.totalCents - untaxed.totalCents, 45);
});

// The minimum is measured against the pre-tax menu subtotal, so a customer
// cannot reach it with the delivery fee or a tip.
test("blocks delivery below the configured minimum (owner decision: $20)", () => {
  const config = {
    originLatitude: LAUNCH_SETTINGS.business.latitude,
    originLongitude: LAUNCH_SETTINGS.business.longitude,
    radiusKm: LAUNCH_SETTINGS.delivery.radiusKm,
    feeCents: LAUNCH_SETTINGS.delivery.feeCents,
    minimumCents: LAUNCH_SETTINGS.delivery.minimumCents,
  };
  assert.equal(LAUNCH_SETTINGS.delivery.minimumCents, 2000);
  const nearby = { validated: true, latitude: 43.2557, longitude: -79.8711 };
  const under = validateDelivery(nearby, config, 1999);
  assert.equal(under.eligible, false);
  assert.equal(under.reason, "below_minimum");
  assert.equal(under.feeCents, 0);
  // Exactly the minimum is inside it, not below it.
  const exact = validateDelivery(nearby, config, 2000);
  assert.equal(exact.eligible, true);
  assert.equal(exact.feeCents, LAUNCH_SETTINGS.delivery.feeCents);
});

test("validates custom tip limits", () => {
  assert.throws(() => priceCart({
    lines: [{ id: "1", productId: "pizza", categoryId: "pizza", quantity: 1, unitPriceCents: 1000, taxable: true, promotionEligible: true }],
    fulfilment: "pickup", deliveryFeeCents: 350, taxRateBps: 1300, deliveryFeeTaxable: false,
    tip: { type: "custom", amountCents: 2500 }, customTipMaxBasisBps: 20_000,
  }), /above the configured maximum/);
});

test("validates delivery radius, fee, minimum, and free-delivery boundary", () => {
  const config = { originLatitude: 43.2557, originLongitude: -79.8711, radiusKm: 10, feeCents: 350, minimumCents: 0 };
  const inside = validateDelivery({ validated: true, latitude: 43.30, longitude: -79.87 }, config, 0);
  assert.equal(inside.eligible, true);
  assert.equal(inside.feeCents, 350);
  const free = validateDelivery({ validated: true, latitude: 43.30, longitude: -79.87 }, config, 0, true);
  assert.equal(free.feeCents, 0);
  const outside = validateDelivery({ validated: true, latitude: 43.38, longitude: -79.87 }, config, 0, true);
  assert.equal(outside.eligible, false);
  assert.equal(outside.reason, "outside_radius");
  assert.equal(outside.feeCents, 0);
  const unverified = validateDelivery({ validated: false, latitude: 43.25, longitude: -79.87 }, config, 0);
  assert.equal(unverified.reason, "address_unverified");
});

test("resolves Hamilton delivery addresses and blocks out-of-area postal codes (C-01)", () => {
  const origin = LAUNCH_SETTINGS.business;
  const config = { originLatitude: origin.latitude, originLongitude: origin.longitude, radiusKm: LAUNCH_SETTINGS.delivery.radiusKm, feeCents: LAUNCH_SETTINGS.delivery.feeCents, minimumCents: LAUNCH_SETTINGS.delivery.minimumCents };

  // Above the $20 minimum, so this test isolates geography rather than spend.
  const overMinimum = LAUNCH_SETTINGS.delivery.minimumCents + 500;

  // A Hamilton postal code resolves and is inside the delivery radius.
  const local = resolveFsaCentroid("L8H 5W7");
  assert.ok(local, "Hamilton FSA should resolve to a point");
  const eligible = validateDelivery({ validated: local !== null, latitude: local?.latitude ?? null, longitude: local?.longitude ?? null }, config, overMinimum);
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.feeCents, LAUNCH_SETTINGS.delivery.feeCents);

  // An Ottawa postal code (K1A 0B1) is not in the delivery-area table -> unverified -> blocked.
  const ottawa = resolveFsaCentroid("K1A 0B1");
  assert.equal(ottawa, null);
  const blocked = validateDelivery({ validated: false, latitude: null, longitude: null }, config, overMinimum);
  assert.equal(blocked.eligible, false);
  assert.equal(blocked.reason, "address_unverified");
});

test("keeps unconfirmed public product claims disabled until owner confirmation (H-21)", () => {
  assert.equal(LAUNCH_SETTINGS.featureFlags.halalPreparationClaim, false);
  assert.equal(LAUNCH_SETTINGS.featureFlags.dryRubLabel, false);
});

test("accepts orders through exact closing time and handles midnight", () => {
  assert.equal(isTimeWithinConfiguredHours(1, 1320, [...REGULAR_HOURS]), true);
  assert.equal(isTimeWithinConfiguredHours(1, 1321, [...REGULAR_HOURS]), false);
  assert.equal(isTimeWithinConfiguredHours(5, 1440, [...REGULAR_HOURS]), true);
});

test("enforces fulfilment-specific order status paths", () => {
  assert.equal(canTransitionOrderStatus("pickup", "received", "preparing"), true);
  assert.equal(canTransitionOrderStatus("pickup", "preparing", "out_for_delivery"), false);
  assert.equal(canTransitionOrderStatus("delivery", "preparing", "out_for_delivery"), true);
  assert.equal(canTransitionOrderStatus("delivery", "completed", "cancelled"), false);
});

test("owner permissions supersede explicit grants while employees remain restricted", () => {
  assert.equal(hasPermission("owner", [], "issue_refunds"), true);
  assert.equal(hasPermission("employee", ["view_orders"], "issue_refunds"), false);
});

test("calculates paid time exactly minus unpaid breaks", () => {
  const hour = 3_600_000;
  const paid = calculatePaidMilliseconds([
    { action: "clock_in", occurredAt: 0 },
    { action: "break_start", occurredAt: 2 * hour },
    { action: "break_end", occurredAt: 2.5 * hour },
    { action: "clock_out", occurredAt: 8.5 * hour },
  ]);
  assert.equal(paid, 8 * hour);
});

test("keeps refund amounts within the captured, unrefunded balance", () => {
  assert.equal(validateRefundAmount(5000, 1000, 2500), 1500);
  assert.throws(() => validateRefundAmount(5000, 1000, 4001), /exceeds/);
});

test("generates unique high-entropy public tokens and hashes them", async () => {
  const one = generateOpaqueToken(); const two = generateOpaqueToken();
  assert.notEqual(one, two);
  assert.ok(one.length >= 43);
  assert.notEqual(await hashOpaqueToken(one), one);
  assert.notEqual(await hashOpaqueToken(one), await hashOpaqueToken(two));
});

test("half toppings consume the owner-configured share of the included allowance", () => {
  const large = PIZZA_SIZES.find((size) => size.id === "large")!;
  const base = {
    basePriceCents: large.basePriceCents,
    extraToppingPriceCents: large.extraToppingPriceCents,
    includedToppingUnitsBps: 10_000,
    extraCheese: false,
  };
  const halves = [
    { toppingId: "pepperoni", placement: "left" as const },
    { toppingId: "mushrooms", placement: "right" as const },
  ];
  // Charged as full toppings: two halves use one allowance and one paid topping.
  const asFull = pricePizza({ ...base, halfToppingUnitsBps: 10_000, toppings: halves });
  assert.equal(asFull.toppingUnitsBps, 20_000);
  assert.equal(asFull.extraToppingTotalCents, large.extraToppingPriceCents);
  // Charged as half toppings: the two halves fit inside the single included topping.
  const asHalf = pricePizza({ ...base, halfToppingUnitsBps: 5_000, toppings: halves });
  assert.equal(asHalf.toppingUnitsBps, 10_000);
  assert.equal(asHalf.extraToppingTotalCents, 0);
  assert.equal(asHalf.totalCents, large.basePriceCents);
  // A third half is charged pro rata, never rounded up to a whole topping.
  const three = pricePizza({
    ...base,
    halfToppingUnitsBps: 5_000,
    toppings: [...halves, { toppingId: "onions", placement: "left" }],
  });
  assert.equal(three.extraToppingTotalCents, Math.round(large.extraToppingPriceCents / 2));
});

test("the same topping on both halves is one whole topping, not two", () => {
  assert.deepEqual(
    normalizeModifierValues([
      { value: "pepperoni", placement: "left" },
      { value: "pepperoni", placement: "right" },
    ]),
    [{ value: "pepperoni", placement: "whole" }],
  );
  assert.equal(
    modifierUnitsBps(normalizeModifierValues([
      { value: "pepperoni", placement: "left" },
      { value: "pepperoni", placement: "right" },
    ]), 5_000),
    10_000,
  );
  assert.deepEqual(normalizeModifierValues(["ham"]), [{ value: "ham", placement: "whole" }]);
  assert.throws(() => normalizeModifierValues([{ value: "ham", placement: "middle" }]), /placement/);
});

test("every pizza is built in the same order wherever it is ordered from", () => {
  const sections = [
    { id: "t", label: "Toppings", source: "toppings" as const, min: 0, max: 3, group: "Pizza 1" },
    { id: "b", label: "Bake & sauce", source: "bake_sauce" as const, min: 0, max: 2, group: "Pizza 1" },
    { id: "c", label: "Crust", source: "crust" as const, min: 0, max: 1, group: "Pizza 1" },
    { id: "h", label: "Halal meat", source: "halal" as const, min: 0, max: 1, group: "Pizza 1" },
    { id: "ch", label: "Cheese", source: "cheese" as const, min: 1, max: 1, group: "Pizza 1" },
    { id: "w", label: "Wings", source: "wing_flavours" as const, min: 1, max: 2 },
  ];
  assert.deepEqual(
    orderModifierSections(sections).map((section) => section.id),
    ["ch", "h", "c", "b", "t", "w"],
  );
  // The owner can move toppings ahead of the crust; cheese and halal stay first.
  assert.deepEqual(
    orderModifierSections(sections, true).map((section) => section.id),
    ["ch", "h", "t", "c", "b", "w"],
  );
  // Groups stay together in the order they first appear.
  const twoPizzas = [
    { id: "p2c", label: "Crust", source: "crust" as const, min: 0, max: 1, group: "Pizza 2" },
    { id: "p1t", label: "Toppings", source: "toppings" as const, min: 0, max: 3, group: "Pizza 1" },
    { id: "p1c", label: "Crust", source: "crust" as const, min: 0, max: 1, group: "Pizza 1" },
  ];
  assert.deepEqual(orderModifierSections(twoPizzas).map((section) => section.id), ["p2c", "p1c", "p1t"]);
});

test("deals ask for cheese, halal and crust on every pizza they contain", () => {
  const twoForOne = MENU_PRODUCTS.find((product) => product.id === "two-for-one-large")!;
  const sections = (twoForOne.configuration as { sections: Array<{ id: string; source?: string; group?: string }> }).sections;
  for (const pizza of ["Pizza 1", "Pizza 2"]) {
    const sources = sections.filter((section) => section.group === pizza).map((section) => section.source);
    assert.deepEqual(sources, ["cheese", "halal", "crust", "bake_sauce", "toppings"]);
  }
});

test("crust is a single choice that always offers regular, thin and thick", () => {
  assert.deepEqual([...CRUST_OPTIONS], ["Regular Crust", "Thin Crust", "Thick Crust"]);
  const large = MENU_PRODUCTS.find((product) => product.id === "large-pizza")!;
  const configuration = large.configuration as { crustOptions: string[]; bakeSauceOptions: string[]; cheeseEnabled: boolean };
  assert.deepEqual(configuration.crustOptions, [...CRUST_OPTIONS]);
  assert.equal(configuration.bakeSauceOptions.includes("Thin Crust"), false);
  assert.equal(configuration.cheeseEnabled, true);
  const crustSections = MENU_PRODUCTS.flatMap((product) =>
    (((product.configuration ?? {}) as { sections?: Array<{ source?: string; max: number }> }).sections ?? [])
      .filter((section) => section.source === "crust"),
  );
  assert.ok(crustSections.length > 0);
  assert.ok(crustSections.every((section) => section.max === 1));
});

test("knows when the restaurant is closed and when it opens next", () => {
  const zone = "America/Toronto";
  const hours = REGULAR_HOURS.map((entry) => ({ ...entry }));
  // Monday 09:00 Toronto — before the 11:00 opening.
  const mondayMorning = Date.parse("2026-07-27T13:00:00Z");
  const beforeOpen = storeStatus(mondayMorning, hours, zone);
  assert.equal(beforeOpen.open, false);
  assert.equal(beforeOpen.weekdayLabel, "Monday");
  assert.equal(zonedParts(beforeOpen.changesAt!, zone).minute, 660);
  assert.equal(beforeOpen.changesAt! - mondayMorning, 2 * 60 * 60_000);
  // Monday 13:00 Toronto — open, and the countdown points at closing time.
  const mondayAfternoon = Date.parse("2026-07-27T17:00:00Z");
  const duringService = storeStatus(mondayAfternoon, hours, zone);
  assert.equal(duringService.open, true);
  assert.equal(zonedParts(duringService.changesAt!, zone).minute, 1320);
  // Monday 23:30 Toronto — after close, so the next opening rolls to Tuesday.
  const afterClose = storeStatus(Date.parse("2026-07-28T03:30:00Z"), hours, zone);
  assert.equal(afterClose.open, false);
  assert.equal(afterClose.weekdayLabel, "Tuesday");
  assert.equal(zonedParts(afterClose.changesAt!, zone).weekday, 2);
});

test("only offers order times the kitchen can accept", () => {
  const zone = "America/Toronto";
  const hours = REGULAR_HOURS.map((entry) => ({ ...entry }));
  // Closed at 09:00 Monday: every slot must be inside opening hours and ahead of
  // the pickup lead time.
  const now = Date.parse("2026-07-27T13:00:00Z");
  const slots = nextOrderSlots({ now, hours, timeZone: zone, leadMinutes: 15 });
  assert.ok(slots.length > 0);
  assert.ok(slots.every((slot) => slot >= now + 15 * 60_000));
  assert.ok(slots.every((slot) => isStoreOpenAt(slot, hours, zone)));
  assert.equal(zonedParts(slots[0], zone).minute, 660);
  assert.ok(slots.every((slot, index) => index === 0 || slot > slots[index - 1]));
  // Mid-service at 13:07 the 13:15 slot is inside the 15-minute lead time, so the
  // first bookable slot is 13:30 — never one the kitchen could not make.
  const midday = Date.parse("2026-07-27T17:07:00Z");
  const later = nextOrderSlots({ now: midday, hours, timeZone: zone, leadMinutes: 15 });
  assert.equal(zonedParts(later[0], zone).minute, 810);
  // Friday closes at minute 1440. That value means the end of Friday in the
  // settings model, but its timestamp is Saturday 00:00 and must not be offered
  // as a Friday slot that validation will reject.
  const lateFriday = Date.parse("2026-08-01T03:20:00Z"); // Friday 23:20 Toronto
  const afterMidnightBoundary = nextOrderSlots({
    now: lateFriday,
    hours,
    timeZone: zone,
    leadMinutes: 30,
    limit: 1,
  });
  assert.equal(zonedParts(afterMidnightBoundary[0], zone).weekday, 6);
  assert.equal(zonedParts(afterMidnightBoundary[0], zone).minute, 660);
  assert.ok(isStoreOpenAt(afterMidnightBoundary[0], hours, zone));
  // Hours that have not been configured cannot produce a bookable time.
  assert.deepEqual(nextOrderSlots({ now, hours: [], timeZone: zone, leadMinutes: 15 }), []);
});

test("builds shifts from the punch log and subtracts unpaid breaks", () => {
  const hour = 3_600_000;
  const start = Date.parse("2026-07-27T15:00:00Z");
  const sessions = buildWorkSessions([
    { action: "clock_in", occurredAt: start },
    { action: "break_start", occurredAt: start + 3 * hour },
    { action: "break_end", occurredAt: start + 3.5 * hour },
    { action: "clock_out", occurredAt: start + 8 * hour },
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].breakMs, 0.5 * hour);
  assert.equal(sessions[0].paidMs, 7.5 * hour);
  assert.equal(sessions[0].open, false);
  // A shift still running is measured up to now rather than dropped.
  const open = buildWorkSessions([{ action: "clock_in", occurredAt: start }], start + 2 * hour);
  assert.equal(open[0].open, true);
  assert.equal(open[0].paidMs, 2 * hour);
  // A break left open when the shift ends still counts as unpaid time.
  const unclosedBreak = buildWorkSessions([
    { action: "clock_in", occurredAt: start },
    { action: "break_start", occurredAt: start + hour },
    { action: "clock_out", occurredAt: start + 2 * hour },
  ]);
  assert.equal(unclosedBreak[0].breakMs, hour);
  assert.equal(unclosedBreak[0].paidMs, hour);
});

test("rejects a duplicate or out-of-order punch before it can inflate a timesheet", () => {
  const start = Date.parse("2026-08-22T14:00:00Z");
  const valid = inspectClockTimeline([
    { id: "in", sessionId: "shift-1", action: "clock_in", occurredAt: start },
    { id: "break", sessionId: "shift-1", action: "break_start", occurredAt: start + 3_600_000 },
    { id: "resume", sessionId: "shift-1", action: "break_end", occurredAt: start + 4_200_000 },
    { id: "out", sessionId: "shift-1", action: "clock_out", occurredAt: start + 8 * 3_600_000 },
  ]);
  assert.equal(valid.state, "clocked_out");
  assert.deepEqual(valid.issues, []);

  const duplicateOut = inspectClockTimeline([
    { id: "bad-out", sessionId: "shift-1", action: "clock_out", occurredAt: start - 1 },
    { id: "in", sessionId: "shift-1", action: "clock_in", occurredAt: start },
    { id: "out", sessionId: "shift-1", action: "clock_out", occurredAt: start + 8 * 3_600_000 },
    { id: "bad-out-2", sessionId: "shift-1", action: "clock_out", occurredAt: start + 8 * 3_600_000 },
  ]);
  assert.equal(duplicateOut.issues.length, 2);
  assert.match(duplicateOut.issues[0].message, /Cannot clock out while clocked out/);
  assert.match(duplicateOut.issues[1].message, /Cannot clock out while clocked out/);

  const crossedSessions = inspectClockTimeline([
    { id: "in", sessionId: "shift-1", action: "clock_in", occurredAt: start },
    { id: "out", sessionId: "shift-2", action: "clock_out", occurredAt: start + 3_600_000 },
  ]);
  assert.equal(crossedSessions.issues.length, 1);
  assert.match(crossedSessions.issues[0].message, /different shift/);
});

test("counts an overnight shift on the day it started", () => {
  const zone = "America/Toronto";
  const hour = 3_600_000;
  // 8pm Friday to 2am Saturday, Toronto time.
  const timesheet = buildTimesheet([
    { action: "clock_in", occurredAt: Date.parse("2026-07-25T00:00:00Z") },
    { action: "clock_out", occurredAt: Date.parse("2026-07-25T06:00:00Z") },
  ], zone);
  assert.equal(timesheet.days.length, 1);
  assert.equal(timesheet.days[0].date, "2026-07-24");
  assert.equal(timesheet.days[0].paidMs, 6 * hour);
  assert.equal(timesheet.totalPaidMs, 6 * hour);
});

test("pays overtime after 44 hours in a week, not after 8 in a day", () => {
  const hour = 3_600_000;
  // Six ten-hour days in one week: 60 hours worked, 44 regular and 16 overtime.
  const days = ["2026-07-26", "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"]
    .map((date) => ({ date, paidMs: 10 * hour }));
  const split = splitOvertime(days, { weeklyOvertimeMinutes: ONTARIO_WEEKLY_OVERTIME_MINUTES, weekStartsOn: 0 });
  assert.equal(split.weeks.length, 1);
  assert.equal(split.regularMs, 44 * hour);
  assert.equal(split.overtimeMs, 16 * hour);
  // A twelve-hour day inside a short week is all regular time.
  const shortWeek = splitOvertime([{ date: "2026-07-27", paidMs: 12 * hour }]);
  assert.equal(shortWeek.overtimeMs, 0);
  // Each week is banked separately, so hours never spill across the boundary.
  const twoWeeks = splitOvertime([
    { date: "2026-07-25", paidMs: 40 * hour },
    { date: "2026-07-27", paidMs: 40 * hour },
  ]);
  assert.equal(twoWeeks.weeks.length, 2);
  assert.equal(twoWeeks.overtimeMs, 0);
});

test("pays overtime at time and a half", () => {
  const hour = 3_600_000;
  assert.equal(grossPayCents(40 * hour, 0, 2000), 80_000);
  assert.equal(grossPayCents(44 * hour, 6 * hour, 2000), 44 * 2000 + 6 * 3000);
  assert.equal(grossPayCents(0, 0, 0), 0);
  assert.throws(() => grossPayCents(hour, 0, -1), /non-negative/);
});

test("pay periods follow on from each other without drifting", () => {
  const anchor = Date.UTC(2026, 6, 5); // a Sunday
  const first = payPeriodFor(anchor + 3 * 86_400_000, { period: "biweekly", anchor });
  assert.equal(first.start, anchor);
  assert.equal(first.end, anchor + 14 * 86_400_000);
  const next = payPeriodFor(anchor + 20 * 86_400_000, { period: "biweekly", anchor });
  assert.equal(next.start, first.end);
  assert.equal(next.index, first.index + 1);
  // Looking back a period lands exactly on the one before.
  const previous = payPeriodFor(anchor + 20 * 86_400_000, { period: "biweekly", anchor, offsetPeriods: -1 });
  assert.equal(previous.start, first.start);
  assert.equal(payPeriodFor(anchor, { period: "weekly", anchor }).end, anchor + 7 * 86_400_000);
});

test("Toronto pay periods stay on local midnight across daylight saving time", () => {
  const zone = "America/Toronto";
  const anchor = Date.parse("2026-03-01T05:00:00Z"); // Sunday 00:00 EST
  const period = payPeriodFor(Date.parse("2026-03-09T16:00:00Z"), { period: "weekly", anchor, timeZone: zone });
  assert.equal(period.start, Date.parse("2026-03-08T05:00:00Z"));
  assert.equal(period.end, Date.parse("2026-03-15T04:00:00Z"));
  assert.equal(period.end - period.start, 167 * 3_600_000, "the spring-forward week has 167 real hours");
});

test("an unrecognised promotion type grants nothing, least of all free delivery (H-11b)", () => {
  const lines = [{ id: "1", productId: "pizza", categoryId: "pizza", quantity: 1, unitPriceCents: 2000, taxable: true, promotionEligible: true }];

  // The regression: the type test used to end in a bare `else`, so anything that
  // was not "percentage" or "fixed" landed in the free-delivery arm. A typo in
  // the admin form, or a row left over from a renamed type, quietly waived the
  // delivery fee on every qualifying order.
  const unknown = applyPromotions(
    lines,
    [{ id: "typo", name: "Free Delivry", type: "free_delivry" as never, amount: 0, priority: 1, combinable: true, exclusive: false }],
    "delivery",
  );
  assert.equal(unknown.freeDelivery, false, "an unknown type must not waive the delivery fee");
  assert.equal(unknown.discountCents, 0);
  assert.deepEqual(unknown.applied, []);

  // The real type still works, so the guard has not over-corrected.
  const genuine = applyPromotions(
    lines,
    [{ id: "fd", name: "Free delivery", type: "free_delivery", amount: 0, priority: 1, combinable: true, exclusive: false }],
    "delivery",
  );
  assert.equal(genuine.freeDelivery, true);
});
