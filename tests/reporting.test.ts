import assert from "node:assert/strict";
import test from "node:test";

const { priceCart } = await import("@/lib/domain");
const { orderSalesBreakdown } = await import("@/lib/reporting");

test("a tax-exempt slice has no taxable basis and no tax", () => {
  const priced = priceCart({
    lines: [{ id: "slice", productId: "slice-combo", categoryId: "pickup-specials", quantity: 1, unitPriceCents: 450, taxable: false, promotionEligible: true }],
    fulfilment: "pickup",
    deliveryFeeCents: 350,
    deliveryFeeTaxable: true,
    taxRateBps: 1300,
    tip: { type: "none" },
  });
  assert.equal(priced.menuSubtotalCents, 450);
  assert.equal(priced.taxableSubtotalCents, 0);
  assert.equal(priced.nonTaxableSubtotalCents, 450);
  assert.equal(priced.taxCents, 0);
  assert.equal(priced.totalCents, 450);
});

test("a mixed cart taxes only the taxable product", () => {
  const priced = priceCart({
    lines: [
      { id: "slice", productId: "slice-combo", categoryId: "pickup-specials", quantity: 1, unitPriceCents: 450, taxable: false, promotionEligible: true },
      { id: "side", productId: "poutine", categoryId: "sides", quantity: 1, unitPriceCents: 899, taxable: true, promotionEligible: true },
    ],
    fulfilment: "pickup",
    deliveryFeeCents: 350,
    deliveryFeeTaxable: true,
    taxRateBps: 1300,
    tip: { type: "none" },
  });
  assert.equal(priced.menuSubtotalCents, 1349);
  assert.equal(priced.taxableSubtotalCents, 899);
  assert.equal(priced.nonTaxableSubtotalCents, 450);
  assert.equal(priced.taxCents, 117);
  assert.equal(priced.totalCents, 1466);
});

test("discounted mixed carts keep taxable and tax-exempt sales reconciled", () => {
  const priced = priceCart({
    lines: [
      { id: "slice", productId: "slice-combo", categoryId: "pickup-specials", quantity: 1, unitPriceCents: 450, taxable: false, promotionEligible: true },
      { id: "side", productId: "poutine", categoryId: "sides", quantity: 1, unitPriceCents: 899, taxable: true, promotionEligible: true },
    ],
    promotions: [{ id: "ten", name: "Ten off", type: "percentage", amount: 1000, priority: 1, combinable: true, exclusive: false }],
    fulfilment: "pickup",
    deliveryFeeCents: 350,
    deliveryFeeTaxable: true,
    taxRateBps: 1300,
    tip: { type: "none" },
  });
  assert.equal(priced.discountedMenuSubtotalCents, 1214);
  assert.equal(priced.taxableSubtotalCents + priced.nonTaxableSubtotalCents, 1214);
  assert.equal(priced.taxableSubtotalCents, 809);
  assert.equal(priced.nonTaxableSubtotalCents, 405);
  assert.equal(priced.taxCents, 105);
});

test("a product-scoped discount reduces the matching tax class only", () => {
  const priced = priceCart({
    lines: [
      { id: "slice", productId: "slice-combo", categoryId: "pickup-specials", quantity: 1, unitPriceCents: 450, taxable: false, promotionEligible: true },
      { id: "side", productId: "poutine", categoryId: "sides", quantity: 1, unitPriceCents: 899, taxable: true, promotionEligible: true },
    ],
    promotions: [{ id: "side-only", name: "$2 off side", type: "fixed", amount: 200, priority: 1, combinable: true, exclusive: false, productIds: ["poutine"] }],
    fulfilment: "pickup",
    deliveryFeeCents: 350,
    deliveryFeeTaxable: true,
    taxRateBps: 1300,
    tip: { type: "none" },
  });
  assert.equal(priced.discountedMenuSubtotalCents, 1149);
  assert.equal(priced.taxableSubtotalCents, 699);
  assert.equal(priced.nonTaxableSubtotalCents, 450);
  assert.equal(priced.taxCents, 91);
});

test("reporting reads the persisted checkout tax classification", () => {
  const breakdown = orderSalesBreakdown({
    subtotal_cents: 1349,
    discount_cents: 0,
    tax_cents: 117,
    total_cents: 1466,
    pricing_json: JSON.stringify({
      discountedMenuSubtotalCents: 1349,
      taxableSubtotalCents: 899,
      nonTaxableSubtotalCents: 450,
    }),
  });
  assert.deepEqual(breakdown, {
    grossSalesCents: 1349,
    discountedFoodSalesCents: 1349,
    taxableSalesCents: 899,
    nonTaxableSalesCents: 450,
    taxCollectedCents: 117,
    finalTotalCents: 1466,
  });
});
