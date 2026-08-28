/**
 * The sales/tax classification persisted with an order.
 *
 * `pricing_json` is the exact `priceCart` result used for checkout and payment,
 * while the scalar columns remain the durable accounting totals. Reading both
 * means reports use the same taxable allocation that produced HST rather than
 * trying to reconstruct it from product names or from the tax amount later.
 */
export type StoredOrderSales = {
  subtotal_cents?: unknown;
  discount_cents?: unknown;
  tax_cents?: unknown;
  total_cents?: unknown;
  pricing_json?: unknown;
};

export type OrderSalesBreakdown = {
  grossSalesCents: number;
  discountedFoodSalesCents: number;
  taxableSalesCents: number;
  nonTaxableSalesCents: number;
  taxCollectedCents: number;
  finalTotalCents: number;
};

const cents = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

function pricing(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function orderSalesBreakdown(order: StoredOrderSales): OrderSalesBreakdown {
  const storedPricing = pricing(order.pricing_json);
  const grossSalesCents = cents(order.subtotal_cents);
  const discountedFoodSalesCents = Math.min(
    grossSalesCents,
    "discountedMenuSubtotalCents" in storedPricing
      ? cents(storedPricing.discountedMenuSubtotalCents)
      : Math.max(0, grossSalesCents - cents(order.discount_cents)),
  );

  // New and mixed-tax orders always carry this exact value. The fallback keeps
  // older all-taxable orders reportable: before tax-exempt menu items existed,
  // a positive HST amount meant the food subtotal was taxable.
  const persistedTaxable = storedPricing.taxableSubtotalCents;
  const taxableSalesCents = Math.min(
    discountedFoodSalesCents,
    Number.isSafeInteger(Number(persistedTaxable)) && Number(persistedTaxable) >= 0
      ? Number(persistedTaxable)
      : cents(order.tax_cents) > 0
        ? discountedFoodSalesCents
        : 0,
  );
  const persistedNonTaxable = storedPricing.nonTaxableSubtotalCents;
  const nonTaxableSalesCents =
    Number.isSafeInteger(Number(persistedNonTaxable)) && Number(persistedNonTaxable) >= 0
      ? Math.min(discountedFoodSalesCents - taxableSalesCents, Number(persistedNonTaxable))
      : Math.max(0, discountedFoodSalesCents - taxableSalesCents);

  return {
    grossSalesCents,
    discountedFoodSalesCents,
    taxableSalesCents,
    nonTaxableSalesCents,
    taxCollectedCents: cents(order.tax_cents),
    finalTotalCents: cents(order.total_cents),
  };
}
