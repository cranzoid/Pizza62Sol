import assert from "node:assert/strict";
import test from "node:test";
import {
  ONTARIO_WEEKLY_OVERTIME_MINUTES,
  applyPromotions,
  buildTimesheet,
  buildWorkSessions,
  grossPayCents,
  payPeriodFor,
  splitOvertime,
  calculatePaidMilliseconds,
  canTransitionOrderStatus,
  generateOpaqueToken,
  hashOpaqueToken,
  hasPermission,
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
} from "../lib/domain.ts";
import { MENU_PRODUCTS } from "../lib/menu.ts";
import { PIZZA_SIZES, REGULAR_HOURS, LAUNCH_SETTINGS } from "../lib/launch-config.ts";
import { resolveFsaCentroid } from "../lib/delivery-area.ts";

test("uses flyer prices and only charges toppings beyond each included offer", () => {
  const expected = [
    ["Medium", 840, 1260, 210],
    ["Large", 1149, 1609, 230],
    ["X-Large", 1249, 1769, 260],
    ["Jumbo", 1999, 2579, 290],
    ["Slab", 2149, 2729, 290],
  ];
  assert.deepEqual(
    PIZZA_SIZES.map((size) => [size.name, size.basePriceCents, size.threeToppingPriceCents, size.extraToppingPriceCents]),
    expected,
  );
  for (const size of PIZZA_SIZES) {
    const included = pricePizza({
      basePriceCents: size.basePriceCents,
      extraToppingPriceCents: size.extraToppingPriceCents,
      includedToppingUnitsBps: 10_000,
      halfToppingUnitsBps: 10_000,
      toppings: [{ toppingId: "approved-topping", placement: "whole" }],
      extraCheese: false,
    });
    assert.equal(included.totalCents, size.basePriceCents);
    const extra = pricePizza({
      basePriceCents: size.basePriceCents,
      extraToppingPriceCents: size.extraToppingPriceCents,
      includedToppingUnitsBps: 10_000,
      halfToppingUnitsBps: 10_000,
      toppings: [
        { toppingId: "approved-topping", placement: "whole" },
        { toppingId: "extra-topping", placement: "whole" },
      ],
      extraCheese: false,
    });
    assert.equal(extra.totalCents, size.basePriceCents + size.extraToppingPriceCents);
  }
});

test("limits Hamilton Heroes to the flyer window in Toronto", () => {
  const offer = { weekdays: [1, 2, 3, 4, 5], startMinute: 17 * 60, endMinute: 21 * 60, timeZone: "America/Toronto" };
  assert.equal(isWithinWeeklyAvailability(offer, new Date("2026-07-20T21:00:00Z")), true);
  assert.equal(isWithinWeeklyAvailability(offer, new Date("2026-07-21T01:00:00Z")), true);
  assert.equal(isWithinWeeklyAvailability(offer, new Date("2026-07-21T01:01:00Z")), false);
  assert.equal(isWithinWeeklyAvailability(offer, new Date("2026-07-19T22:00:00Z")), false);
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

test("resolves Hamilton delivery addresses and blocks out-of-area postal codes (C-01)", () => {
  const origin = LAUNCH_SETTINGS.business;
  const config = { originLatitude: origin.latitude, originLongitude: origin.longitude, radiusKm: LAUNCH_SETTINGS.delivery.radiusKm, feeCents: LAUNCH_SETTINGS.delivery.feeCents, minimumCents: LAUNCH_SETTINGS.delivery.minimumCents };

  // A Hamilton postal code resolves and is inside the delivery radius.
  const local = resolveFsaCentroid("L8H 5W7");
  assert.ok(local, "Hamilton FSA should resolve to a point");
  const eligible = validateDelivery({ validated: local !== null, latitude: local?.latitude ?? null, longitude: local?.longitude ?? null }, config, 0);
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.feeCents, LAUNCH_SETTINGS.delivery.feeCents);

  // An Ottawa postal code (K1A 0B1) is not in the delivery-area table -> unverified -> blocked.
  const ottawa = resolveFsaCentroid("K1A 0B1");
  assert.equal(ottawa, null);
  const blocked = validateDelivery({ validated: false, latitude: null, longitude: null }, config, 0);
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
