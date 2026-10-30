import assert from "node:assert/strict";
import test, { after, mock } from "node:test";
import { dailySpecialVisitKey, todaysSpecials } from "@/lib/daily-specials";
import { isWithinWeeklyAvailability } from "@/lib/domain";
import { MENU_PRODUCTS, MONDAY_WINGS_PRODUCT_ID } from "@/lib/menu";
import { HALLOWEEN_AVAILABILITY, HALLOWEEN_WINGS_PRODUCT_ID, isHalloween, isStorefrontProductVisible } from "@/lib/seasonal";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";
const { getPool, closePool } = await import("@/db/pg-driver");
const { quoteOrder, createOrder } = await import("@/lib/order-service");
const { loadPublicCatalog } = await import("@/lib/public-catalog");
const reachable = await getPool().query("SELECT 1").then(() => true).catch(() => false);
after(closePool);

const halloween = MENU_PRODUCTS.find((product) => product.id === HALLOWEEN_WINGS_PRODUCT_ID)!;
const monday = MENU_PRODUCTS.find((product) => product.id === MONDAY_WINGS_PRODUCT_ID)!;
const OPEN = Date.parse("2026-10-31T18:00:00-04:00");
const modifiers = (style = "Breaded") => [
  { id: "wing-style", values: [style] },
  { id: "wing-flavours", values: ["Hot"] },
];
const cart = (fulfilment: "pickup" | "delivery", quantity = 20) => ({
  fulfilment,
  items: [{ productId: HALLOWEEN_WINGS_PRODUCT_ID, quantity, modifiers: modifiers() }],
  tip: { type: "none" as const },
});
async function at<T>(instant: number, body: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["Date"], now: instant });
  try { return await body(); } finally { mock.timers.reset(); }
}

test("Halloween copies Monday's $1 wing choices and cap, and enables both methods", () => {
  assert.ok(halloween);
  assert.equal(halloween.basePriceCents, 100);
  assert.equal(halloween.pickupEligible, true);
  assert.equal(halloween.deliveryEligible, true);
  assert.deepEqual(halloween.configuration?.sections, monday.configuration?.sections);
  assert.equal(halloween.configuration?.maxQuantity, 40);
  assert.equal(halloween.configuration?.dailySpecial, true);
  assert.equal(monday.deliveryEligible, false);
});

test("the offer, decorations and visibility share exact Toronto date boundaries", () => {
  for (const [instant, active] of [
    ["2026-10-31T03:59:59.999Z", false],
    ["2026-10-31T04:00:00Z", true],
    ["2026-11-01T03:59:59.999Z", true],
    ["2026-11-01T04:00:00Z", false],
    ["2026-11-07T18:00:00Z", false],
    ["2027-10-31T18:00:00Z", false],
  ] as const) {
    const now = new Date(instant);
    assert.equal(isHalloween(now), active, instant);
    assert.equal(isWithinWeeklyAvailability(HALLOWEEN_AVAILABILITY, now), active, instant);
    assert.equal(isStorefrontProductVisible({ configuration: halloween.configuration! }, now), active, instant);
  }
  assert.equal(isStorefrontProductVisible({ configuration: monday.configuration! }, new Date(OPEN)), true);
});

test("Halloween's popup works for delivery-only and pickup-only operation", () => {
  const candidate = { ...halloween, configuration: halloween.configuration!, pickup_eligible: 1, delivery_eligible: 1 };
  for (const methods of [{ pickupEnabled: true, deliveryEnabled: false }, { pickupEnabled: false, deliveryEnabled: true }]) {
    assert.deepEqual(todaysSpecials([candidate], new Date(OPEN), methods), [candidate]);
  }
  assert.deepEqual(todaysSpecials([{ ...candidate, sold_out: 1 }], new Date(OPEN), { pickupEnabled: true, deliveryEnabled: true }), []);
});

test("an earlier popup dismissal cannot suppress Halloween in the same tab", () => {
  const products = [{ id: HALLOWEEN_WINGS_PRODUCT_ID }];
  const key = (instant: string) => dailySpecialVisitKey(products, new Date(instant), "America/Toronto");
  assert.notEqual(key("2026-10-31T03:59:00Z"), key("2026-10-31T04:00:00Z"));
  assert.equal(key("2026-10-31T04:00:00Z"), key("2026-11-01T03:59:00Z"));
  assert.notEqual(key("2026-10-31T04:00:00Z"), dailySpecialVisitKey([{ id: MONDAY_WINGS_PRODUCT_ID }], new Date(OPEN), "America/Toronto"));
});

test("the real server quotes $1 wings for both methods, with normal delivery rules", { skip: !reachable }, async () => at(OPEN, async () => {
  for (const fulfilment of ["pickup", "delivery"] as const) {
    const quote = await quoteOrder(cart(fulfilment));
    assert.equal(quote.ok, true, JSON.stringify(quote.issues));
    assert.equal(quote.lines[0]?.unitPriceCents, 100);
    assert.equal(quote.totals.menuSubtotalCents, 2000);
    assert.ok(quote.totals.taxCents > 0);
    if (fulfilment === "delivery") assert.ok(quote.totals.deliveryFeeCents > 0);
  }
  const belowMinimum = await quoteOrder(cart("delivery", 1));
  assert.ok(belowMinimum.issues.some((issue) => issue.code === "DELIVERY_BELOW_MINIMUM"));
  const capped = await quoteOrder({ ...cart("pickup"), items: [
    { productId: HALLOWEEN_WINGS_PRODUCT_ID, quantity: 21, modifiers: modifiers() },
    { productId: HALLOWEEN_WINGS_PRODUCT_ID, quantity: 20, modifiers: modifiers("Classic (non-breaded)") },
  ] });
  assert.equal(capped.ok, false);
  assert.ok(capped.issues.some((issue) => /limited to 40/.test(issue.message)));
}));

test("the server refuses Halloween wings before and after the campaign", { skip: !reachable }, async () => {
  for (const instant of ["2026-10-30T18:00:00-04:00", "2026-11-01T18:00:00-05:00"]) {
    await at(Date.parse(instant), async () => {
      const quote = await quoteOrder(cart("pickup"));
      assert.equal(quote.ok, false);
      assert.ok(quote.issues.some((issue) => issue.code === "PRODUCT_OUTSIDE_OFFER_HOURS"));
    });
  }
});

test("scheduled orders cannot carry the Halloween price into November", { skip: !reachable }, async () => at(OPEN, async () => {
  const sameDay = { ...cart("pickup"), schedule: { type: "scheduled" as const, scheduledFor: Date.parse("2026-10-31T19:00:00-04:00") } };
  assert.equal((await quoteOrder(sameDay)).ok, true);
  const nextDay = { ...sameDay, schedule: { type: "scheduled" as const, scheduledFor: Date.parse("2026-11-01T18:00:00-05:00") } };
  const quote = await quoteOrder(nextDay);
  assert.ok(quote.issues.some((issue) => issue.code === "PRODUCT_OUTSIDE_OFFER_HOURS"));
  await assert.rejects(createOrder({ ...nextDay, customer: { name: "Halloween Test", phone: "9055550199", email: "halloween@example.test" }, paymentMethod: "pay_at_store", idempotencyKey: crypto.randomUUID() }), /cannot be scheduled outside/);
}));

test("the public catalog removes the seasonal item on either side of Halloween", { skip: !reachable }, async () => {
  for (const [instant, visible] of [[OPEN - 86_400_000, false], [OPEN, true], [OPEN + 86_400_000, false]] as const) {
    await at(instant, async () => {
      const catalog = await loadPublicCatalog();
      assert.equal(catalog.products.some((product) => product.id === HALLOWEEN_WINGS_PRODUCT_ID), visible);
    });
  }
});
