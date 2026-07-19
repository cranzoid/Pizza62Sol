import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPromotions,
  calculatePaidMilliseconds,
  canTransitionOrderStatus,
  generateOpaqueToken,
  hashOpaqueToken,
  hasPermission,
  isTimeWithinConfiguredHours,
  normalizeToppings,
  priceCart,
  pricePizza,
  priceSharedToppingPool,
  validateDelivery,
  validateRefundAmount,
} from "../lib/domain.ts";
import { PIZZA_SIZES, REGULAR_HOURS } from "../lib/launch-config.ts";

test("uses every confirmed pizza size and extra-topping price", () => {
  const expected = [
    ["Medium", 840, 210],
    ["Large", 1149, 230],
    ["X-Large", 1249, 260],
    ["Jumbo", 1999, 290],
    ["Slab", 2149, 290],
  ];
  assert.deepEqual(
    PIZZA_SIZES.map((size) => [size.name, size.basePriceCents, size.extraToppingPriceCents]),
    expected,
  );
  for (const size of PIZZA_SIZES) {
    const price = pricePizza({
      basePriceCents: size.basePriceCents,
      extraToppingPriceCents: size.extraToppingPriceCents,
      includedToppingUnitsBps: 0,
      halfToppingUnitsBps: 10_000,
      toppings: [{ toppingId: "approved-topping", placement: "whole" }],
      extraCheese: false,
    });
    assert.equal(price.totalCents, size.basePriceCents + size.extraToppingPriceCents);
  }
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

test("excludes delivery fee from HST and bases tips on discounted food", () => {
  const total = priceCart({
    lines: [{ id: "1", productId: "pizza", categoryId: "pizza", quantity: 1, unitPriceCents: 2000, taxable: true, promotionEligible: true }],
    promotions: [{ id: "coupon", name: "$5 off", type: "fixed", amount: 500, priority: 1, combinable: true, exclusive: false }],
    fulfilment: "delivery",
    deliveryFeeCents: 350,
    taxRateBps: 1300,
    deliveryFeeTaxable: false,
    tip: { type: "percentage", valueBps: 1500 },
  });
  assert.equal(total.discountedMenuSubtotalCents, 1500);
  assert.equal(total.taxCents, 195);
  assert.equal(total.tipBasisCents, 1500);
  assert.equal(total.tipCents, 225);
  assert.equal(total.totalCents, 2270);
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
