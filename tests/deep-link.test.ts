import assert from "node:assert/strict";
import test from "node:test";

const {
  DEEP_LINK_PARAMS,
  hasCustomizer,
  parseDeepLink,
  resolveDeepLink,
  withoutDeepLinkParams,
} = await import("@/lib/deep-link");
const { MENU_PRODUCTS } = await import("@/lib/menu");

type Product = {
  id: string;
  product_type: string;
  pickup_eligible: number;
  delivery_eligible: number;
  sold_out: number;
  setup_required: number;
  configuration: Record<string, unknown>;
};

const product = (overrides: Partial<Product> = {}): Product => ({
  id: "pickup-large-one",
  product_type: "pizza",
  pickup_eligible: 1,
  delivery_eligible: 0,
  sold_out: 0,
  setup_required: 0,
  configuration: {},
  ...overrides,
});

const resolve = (search: string, products: Product[], options: { pickup?: boolean; delivery?: boolean; now?: Date } = {}) =>
  resolveDeepLink({
    request: parseDeepLink(search),
    products,
    pickupEnabled: options.pickup ?? true,
    deliveryEnabled: options.delivery ?? true,
    now: options.now,
  });

/**
 * The seed rows for the two advertised offers, shaped the way the public
 * catalogue serves them. The runtime upsert writes `sold_out = 0` and
 * `setup_required = 0`, so the fixture does too.
 */
const catalogueRow = (id: string): Product => {
  const seed = MENU_PRODUCTS.find((entry) => entry.id === id);
  assert.ok(seed, `${id} must exist in the menu seed`);
  return {
    id: seed.id,
    product_type: seed.productType,
    pickup_eligible: seed.pickupEligible === false ? 0 : 1,
    delivery_eligible: seed.deliveryEligible === false ? 0 : 1,
    sold_out: 0,
    setup_required: 0,
    configuration: seed.configuration ?? {},
  };
};

test("only the two deep-link parameters are recognised", () => {
  assert.deepEqual([...DEEP_LINK_PARAMS], ["fulfilment", "product"]);
  assert.deepEqual(parseDeepLink("?fulfilment=PICKUP"), { fulfilment: "pickup", productId: null });
  assert.deepEqual(parseDeepLink("?fulfilment=%20delivery%20"), { fulfilment: "delivery", productId: null });
  assert.deepEqual(parseDeepLink("?fulfilment=courier"), { fulfilment: null, productId: null });
  assert.deepEqual(parseDeepLink("?product=pickup-large-one"), { fulfilment: null, productId: "pickup-large-one" });
  assert.deepEqual(parseDeepLink("?product="), { fulfilment: null, productId: null });
  assert.deepEqual(parseDeepLink(""), { fulfilment: null, productId: null });
});

test("stripping keeps every campaign parameter the click was paid for", () => {
  const cleaned = withoutDeepLinkParams(
    "https://pizza62.ca/?utm_source=google&fulfilment=pickup&gclid=abc&product=pickup-large-one&fbclid=xyz#menu",
  );
  assert.equal(cleaned, "/?utm_source=google&gclid=abc&fbclid=xyz#menu");
});

test("a URL with nothing to strip asks for no history rewrite", () => {
  assert.equal(withoutDeepLinkParams("https://pizza62.ca/?utm_source=google"), null);
  assert.equal(withoutDeepLinkParams("https://pizza62.ca/"), null);
});

test("a plain visit changes neither the method nor what is on screen", () => {
  const outcome = resolve("?utm_source=google", [product()]);
  assert.equal(outcome.fulfilment, null);
  assert.equal(outcome.product, null);
});

test("the advertised pickup offers open their customizer on pickup", () => {
  for (const id of ["pickup-large-one", "pickup-two-large-six"]) {
    const outcome = resolve(`?fulfilment=pickup&product=${id}`, [catalogueRow(id)]);
    assert.equal(outcome.fulfilment, "pickup", id);
    assert.equal(outcome.product?.id, id, id);
  }
});

test("the delivery link selects delivery and lands on the menu", () => {
  const outcome = resolve("?fulfilment=delivery", [product()]);
  assert.equal(outcome.fulfilment, "delivery");
  assert.equal(outcome.product, null);
});

test("a delivery link to a pickup-only offer opens nothing the cart would refuse", () => {
  const outcome = resolve("?fulfilment=delivery&product=pickup-large-one", [catalogueRow("pickup-large-one")]);
  assert.equal(outcome.fulfilment, "delivery");
  assert.equal(outcome.product, null);
});

test("an unknown product falls back to the menu with the method still applied", () => {
  const outcome = resolve("?fulfilment=pickup&product=nope", [product()]);
  assert.equal(outcome.fulfilment, "pickup");
  assert.equal(outcome.product, null);
});

test("sold out, owner setup and a closed date window all fall back to the menu", () => {
  const gameDay = {
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    startMinute: 0,
    endMinute: 1440,
    timeZone: "America/Toronto",
    startDate: "2026-08-29",
    endDate: "2026-08-30",
  };
  const cases: Array<[string, Partial<Product>, Date | undefined]> = [
    ["sold out", { sold_out: 1 }, undefined],
    ["owner setup", { setup_required: 1 }, undefined],
    ["outside its dates", { configuration: { availability: gameDay } }, new Date("2026-09-05T16:00:00Z")],
  ];
  for (const [label, overrides, now] of cases) {
    const outcome = resolve("?fulfilment=pickup&product=pickup-large-one", [product(overrides)], { now });
    assert.equal(outcome.product, null, label);
    assert.equal(outcome.fulfilment, "pickup", label);
  }
  // The same offer inside its window does open.
  const open = resolve(
    "?fulfilment=pickup&product=pickup-large-one",
    [product({ configuration: { availability: gameDay } })],
    { now: new Date("2026-08-29T16:00:00Z") },
  );
  assert.equal(open.product?.id, "pickup-large-one");
});

test("a product with no customizer is never opened, so nothing reaches the cart", () => {
  const pop = product({ id: "can-pop", product_type: "simple", configuration: {} });
  const outcome = resolve("?fulfilment=pickup&product=can-pop", [pop]);
  assert.equal(hasCustomizer(pop), false);
  assert.equal(outcome.fulfilment, "pickup");
  assert.equal(outcome.product, null);
});

test("a link that names no method opens nothing, so the prompt still runs", () => {
  const both = product({ id: "two-ways", delivery_eligible: 1, configuration: { sections: [{ id: "a" }] } });
  const ambiguous = resolve("?product=two-ways", [both]);
  assert.equal(ambiguous.fulfilment, null, "the delivery-or-pickup prompt must still be asked");
  assert.equal(ambiguous.product, null);

  const explicit = resolve("?fulfilment=delivery&product=two-ways", [both]);
  assert.equal(explicit.fulfilment, "delivery");
  assert.equal(explicit.product?.id, "two-ways");
});

test("a method the restaurant has switched off is never selected", () => {
  const outcome = resolve("?fulfilment=delivery", [product()], { delivery: false });
  assert.equal(outcome.fulfilment, null);
});

test("a pickup-only offer is unreachable while pickup is switched off", () => {
  const outcome = resolve("?fulfilment=pickup&product=pickup-large-one", [catalogueRow("pickup-large-one")], { pickup: false });
  assert.equal(outcome.fulfilment, null);
  assert.equal(outcome.product, null);
});

test("both advertised offers really are pickup-only bundles the seed can build", () => {
  for (const id of ["pickup-large-one", "pickup-two-large-six"]) {
    const row = catalogueRow(id);
    assert.equal(row.delivery_eligible, 0, `${id} is advertised as a pickup special`);
    assert.equal(row.pickup_eligible, 1, id);
    assert.equal(hasCustomizer(row), true, `${id} must open a customizer, never drop into the cart`);
  }
});
