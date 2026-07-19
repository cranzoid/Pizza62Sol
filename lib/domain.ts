export const CAD = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
});

export type Fulfilment = "pickup" | "delivery";
export type ToppingPlacement = "whole" | "left" | "right";

export type ToppingSelection = {
  toppingId: string;
  placement: ToppingPlacement;
};

export type PizzaPricingInput = {
  basePriceCents: number;
  extraToppingPriceCents: number;
  includedToppingUnitsBps: number;
  halfToppingUnitsBps: number;
  toppings: ToppingSelection[];
  extraCheese: boolean;
  halalSurchargeCents?: number;
};

export type PizzaPricingResult = {
  normalizedToppings: ToppingSelection[];
  toppingUnitsBps: number;
  includedUnitsBps: number;
  paidUnitsBps: number;
  extraToppingTotalCents: number;
  totalCents: number;
};

export type SharedPizzaInput = PizzaPricingInput & {
  lineId: string;
  includedAllocationUnitsBps?: number;
};

export type CartLinePrice = {
  id: string;
  productId: string;
  categoryId: string;
  quantity: number;
  unitPriceCents: number;
  taxable: boolean;
  promotionEligible: boolean;
};

export type PromotionRule = {
  id: string;
  name: string;
  type: "percentage" | "fixed" | "free_delivery";
  amount: number;
  priority: number;
  combinable: boolean;
  exclusive: boolean;
  stackGroup?: string | null;
  productIds?: string[];
  categoryIds?: string[];
  fulfilments?: Fulfilment[];
  minimumCents?: number;
  maximumApplications?: number;
};

export type AppliedPromotion = {
  id: string;
  name: string;
  discountCents: number;
  reason: string;
};

export type CartPricingInput = {
  lines: CartLinePrice[];
  promotions?: PromotionRule[];
  fulfilment: Fulfilment;
  deliveryFeeCents: number;
  taxRateBps: number;
  deliveryFeeTaxable: boolean;
  tip?:
    | { type: "none" }
    | { type: "percentage"; valueBps: number }
    | { type: "custom"; amountCents: number };
  customTipMaxCents?: number;
  customTipMaxBasisBps?: number;
};

export type CartPricingResult = {
  menuSubtotalCents: number;
  discountCents: number;
  discountedMenuSubtotalCents: number;
  taxableSubtotalCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  tipBasisCents: number;
  tipCents: number;
  totalCents: number;
  appliedPromotions: AppliedPromotion[];
};

export type AddressValidation = {
  validated: boolean;
  latitude: number | null;
  longitude: number | null;
};

export type DeliveryConfig = {
  originLatitude: number | null;
  originLongitude: number | null;
  radiusKm: number;
  feeCents: number;
  minimumCents: number;
};

export type DeliveryEligibility = {
  eligible: boolean;
  distanceKm: number | null;
  feeCents: number;
  reason:
    | "eligible"
    | "address_unverified"
    | "restaurant_origin_unconfigured"
    | "outside_radius"
    | "below_minimum";
};

const STATUS_PATHS = {
  pickup: ["received", "preparing", "ready_for_pickup", "completed"],
  delivery: ["received", "preparing", "out_for_delivery", "completed"],
} as const;

export function assertIntegerCents(value: number, field = "amount"): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer number of cents`);
  }
  return value;
}

export function formatMoney(cents: number): string {
  assertIntegerCents(cents);
  return CAD.format(cents / 100);
}

export function normalizeToppings(
  selections: ToppingSelection[],
): ToppingSelection[] {
  const placements = new Map<string, Set<ToppingPlacement>>();
  for (const selection of selections) {
    if (!selection.toppingId) throw new Error("A topping identifier is required");
    if (!["whole", "left", "right"].includes(selection.placement)) {
      throw new Error("Invalid topping placement");
    }
    const current = placements.get(selection.toppingId) ?? new Set();
    current.add(selection.placement);
    placements.set(selection.toppingId, current);
  }

  const normalized: ToppingSelection[] = [];
  for (const [toppingId, values] of placements) {
    if (values.has("whole") || (values.has("left") && values.has("right"))) {
      normalized.push({ toppingId, placement: "whole" });
      continue;
    }
    if (values.has("left")) normalized.push({ toppingId, placement: "left" });
    if (values.has("right")) normalized.push({ toppingId, placement: "right" });
  }
  return normalized.sort((a, b) =>
    `${a.toppingId}:${a.placement}`.localeCompare(`${b.toppingId}:${b.placement}`),
  );
}

export function toppingUnitsBps(
  selections: ToppingSelection[],
  halfToppingUnitsBps = 10_000,
): number {
  if (!Number.isSafeInteger(halfToppingUnitsBps) || halfToppingUnitsBps < 0) {
    throw new Error("Half-topping weight must use non-negative basis points");
  }
  return normalizeToppings(selections).reduce(
    (sum, selection) =>
      sum + (selection.placement === "whole" ? 10_000 : halfToppingUnitsBps),
    0,
  );
}

export function pricePizza(input: PizzaPricingInput): PizzaPricingResult {
  assertIntegerCents(input.basePriceCents, "Base price");
  assertIntegerCents(input.extraToppingPriceCents, "Extra topping price");
  assertIntegerCents(input.halalSurchargeCents ?? 0, "Halal surcharge");
  const normalizedToppings = normalizeToppings(input.toppings);
  const selectedUnitsBps =
    toppingUnitsBps(normalizedToppings, input.halfToppingUnitsBps) +
    (input.extraCheese ? 10_000 : 0);
  const includedUnitsBps = Math.min(
    selectedUnitsBps,
    Math.max(0, input.includedToppingUnitsBps),
  );
  const paidUnitsBps = Math.max(0, selectedUnitsBps - includedUnitsBps);
  const extraToppingTotalCents = Math.round(
    (paidUnitsBps * input.extraToppingPriceCents) / 10_000,
  );
  return {
    normalizedToppings,
    toppingUnitsBps: selectedUnitsBps,
    includedUnitsBps,
    paidUnitsBps,
    extraToppingTotalCents,
    totalCents:
      input.basePriceCents +
      extraToppingTotalCents +
      (input.halalSurchargeCents ?? 0),
  };
}

export function priceSharedToppingPool(
  pizzas: SharedPizzaInput[],
  sharedAllowanceUnitsBps: number,
): { pizzas: Array<PizzaPricingResult & { lineId: string }>; remainingUnitsBps: number } {
  let remaining = Math.max(0, sharedAllowanceUnitsBps);
  const priced = pizzas.map((pizza) => {
    const units =
      toppingUnitsBps(pizza.toppings, pizza.halfToppingUnitsBps) +
      (pizza.extraCheese ? 10_000 : 0);
    const requested = pizza.includedAllocationUnitsBps;
    const allocation = Math.min(
      units,
      remaining,
      requested === undefined ? remaining : Math.max(0, requested),
    );
    remaining -= allocation;
    return {
      lineId: pizza.lineId,
      ...pricePizza({ ...pizza, includedToppingUnitsBps: allocation }),
    };
  });
  return { pizzas: priced, remainingUnitsBps: remaining };
}

function eligibleLineSubtotal(
  lines: CartLinePrice[],
  promotion: PromotionRule,
): number {
  return lines.reduce((sum, line) => {
    if (!line.promotionEligible) return sum;
    if (promotion.productIds?.length && !promotion.productIds.includes(line.productId)) {
      return sum;
    }
    if (
      promotion.categoryIds?.length &&
      !promotion.categoryIds.includes(line.categoryId)
    ) {
      return sum;
    }
    return sum + line.unitPriceCents * line.quantity;
  }, 0);
}

export function applyPromotions(
  lines: CartLinePrice[],
  promotions: PromotionRule[],
  fulfilment: Fulfilment,
): { discountCents: number; freeDelivery: boolean; applied: AppliedPromotion[] } {
  const subtotal = lines.reduce(
    (sum, line) => sum + line.unitPriceCents * line.quantity,
    0,
  );
  const sorted = [...promotions].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  );
  const usedStackGroups = new Set<string>();
  const applied: AppliedPromotion[] = [];
  let discountCents = 0;
  let freeDelivery = false;
  let exclusiveApplied = false;

  for (const promotion of sorted) {
    if (exclusiveApplied) break;
    if (promotion.fulfilments?.length && !promotion.fulfilments.includes(fulfilment)) {
      continue;
    }
    if (subtotal < (promotion.minimumCents ?? 0)) continue;
    if (promotion.stackGroup && usedStackGroups.has(promotion.stackGroup)) continue;
    if (!promotion.combinable && applied.length > 0) continue;
    if (applied.some((entry) => entry.id !== promotion.id) && promotion.exclusive) {
      continue;
    }

    const eligibleCents = eligibleLineSubtotal(lines, promotion);
    if (promotion.type !== "free_delivery" && eligibleCents <= 0) continue;
    let amount = 0;
    if (promotion.type === "percentage") {
      amount = Math.round((eligibleCents * promotion.amount) / 10_000);
    } else if (promotion.type === "fixed") {
      amount = Math.min(eligibleCents, promotion.amount);
    } else {
      freeDelivery = true;
    }
    amount = Math.min(amount, subtotal - discountCents);
    if (amount === 0 && promotion.type !== "free_delivery") continue;
    discountCents += amount;
    if (promotion.stackGroup) usedStackGroups.add(promotion.stackGroup);
    exclusiveApplied = promotion.exclusive || !promotion.combinable;
    applied.push({
      id: promotion.id,
      name: promotion.name,
      discountCents: amount,
      reason:
        promotion.type === "free_delivery"
          ? "Eligible free-delivery rule"
          : `Applied by priority ${promotion.priority}`,
    });
  }
  return { discountCents, freeDelivery, applied };
}

export function priceCart(input: CartPricingInput): CartPricingResult {
  for (const line of input.lines) {
    assertIntegerCents(line.unitPriceCents, "Line price");
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) {
      throw new Error("Line quantity must be between 1 and 99");
    }
  }
  const menuSubtotalCents = input.lines.reduce(
    (sum, line) => sum + line.unitPriceCents * line.quantity,
    0,
  );
  const promotionResult = applyPromotions(
    input.lines,
    input.promotions ?? [],
    input.fulfilment,
  );
  const discountedMenuSubtotalCents = Math.max(
    0,
    menuSubtotalCents - promotionResult.discountCents,
  );
  const taxableBeforeDiscount = input.lines.reduce(
    (sum, line) =>
      sum + (line.taxable ? line.unitPriceCents * line.quantity : 0),
    0,
  );
  const taxableShare =
    menuSubtotalCents === 0 ? 0 : taxableBeforeDiscount / menuSubtotalCents;
  const taxableSubtotalCents = Math.round(
    discountedMenuSubtotalCents * taxableShare,
  );
  const deliveryFeeCents =
    input.fulfilment === "delivery" && !promotionResult.freeDelivery
      ? assertIntegerCents(input.deliveryFeeCents, "Delivery fee")
      : 0;
  const taxBasisCents =
    taxableSubtotalCents + (input.deliveryFeeTaxable ? deliveryFeeCents : 0);
  const taxCents = Math.round((taxBasisCents * input.taxRateBps) / 10_000);
  const tipBasisCents = discountedMenuSubtotalCents;
  let tipCents = 0;
  if (input.tip?.type === "percentage") {
    if (input.tip.valueBps < 0 || input.tip.valueBps > 20_000) {
      throw new Error("Tip percentage is outside the configured safe range");
    }
    tipCents = Math.round((tipBasisCents * input.tip.valueBps) / 10_000);
  } else if (input.tip?.type === "custom") {
    tipCents = assertIntegerCents(input.tip.amountCents, "Custom tip");
    const maxByBasis = Math.round(
      (tipBasisCents * (input.customTipMaxBasisBps ?? 20_000)) / 10_000,
    );
    const absoluteMax = input.customTipMaxCents ?? 50_000;
    if (tipCents > Math.min(maxByBasis, absoluteMax)) {
      throw new Error("Custom tip is above the configured maximum");
    }
  }
  return {
    menuSubtotalCents,
    discountCents: promotionResult.discountCents,
    discountedMenuSubtotalCents,
    taxableSubtotalCents,
    taxCents,
    deliveryFeeCents,
    tipBasisCents,
    tipCents,
    totalCents:
      discountedMenuSubtotalCents + taxCents + deliveryFeeCents + tipCents,
    appliedPromotions: promotionResult.applied,
  };
}

export function haversineKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(latitudeB - latitudeA);
  const dLon = toRadians(longitudeB - longitudeA);
  const latA = toRadians(latitudeA);
  const latB = toRadians(latitudeB);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function validateDelivery(
  address: AddressValidation,
  config: DeliveryConfig,
  menuSubtotalCents: number,
  freeDelivery = false,
): DeliveryEligibility {
  if (!address.validated || address.latitude === null || address.longitude === null) {
    return { eligible: false, distanceKm: null, feeCents: 0, reason: "address_unverified" };
  }
  if (config.originLatitude === null || config.originLongitude === null) {
    return {
      eligible: false,
      distanceKm: null,
      feeCents: 0,
      reason: "restaurant_origin_unconfigured",
    };
  }
  const distanceKm = haversineKm(
    config.originLatitude,
    config.originLongitude,
    address.latitude,
    address.longitude,
  );
  if (distanceKm > config.radiusKm) {
    return { eligible: false, distanceKm, feeCents: 0, reason: "outside_radius" };
  }
  if (menuSubtotalCents < config.minimumCents) {
    return { eligible: false, distanceKm, feeCents: 0, reason: "below_minimum" };
  }
  return {
    eligible: true,
    distanceKm,
    feeCents: freeDelivery ? 0 : config.feeCents,
    reason: "eligible",
  };
}

export function isTimeWithinConfiguredHours(
  weekday: number,
  minuteOfDay: number,
  hours: Array<{ weekday: number; openMinute: number; closeMinute: number }>,
): boolean {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return false;
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > 1440) {
    return false;
  }
  const schedule = hours.find((entry) => entry.weekday === weekday);
  return Boolean(
    schedule &&
      minuteOfDay >= schedule.openMinute &&
      minuteOfDay <= schedule.closeMinute,
  );
}

export function validateRefundAmount(
  capturedCents: number,
  alreadyRefundedCents: number,
  requestedCents: number,
): number {
  assertIntegerCents(capturedCents, "Captured amount");
  assertIntegerCents(alreadyRefundedCents, "Previously refunded amount");
  assertIntegerCents(requestedCents, "Requested refund");
  const remaining = capturedCents - alreadyRefundedCents;
  if (remaining < 0 || requestedCents < 1 || requestedCents > remaining) {
    throw new Error("Refund amount exceeds the captured, unrefunded balance");
  }
  return remaining - requestedCents;
}

export function canTransitionOrderStatus(
  fulfilment: Fulfilment,
  from: string,
  to: string,
  override = false,
): boolean {
  if (from === to) return false;
  if (to === "cancelled") return from !== "completed" && from !== "cancelled";
  if (from === "cancelled" || from === "completed") return false;
  if (override) return (STATUS_PATHS[fulfilment] as readonly string[]).includes(to);
  const path = STATUS_PATHS[fulfilment] as readonly string[];
  return path.indexOf(to) === path.indexOf(from) + 1;
}

export type ClockAction = "clock_in" | "break_start" | "break_end" | "clock_out";
export type ClockState = "clocked_out" | "working" | "on_break";

export function nextClockState(state: ClockState, action: ClockAction): ClockState {
  const transitions: Record<ClockState, Partial<Record<ClockAction, ClockState>>> = {
    clocked_out: { clock_in: "working" },
    working: { break_start: "on_break", clock_out: "clocked_out" },
    on_break: { break_end: "working" },
  };
  const next = transitions[state][action];
  if (!next) throw new Error(`Invalid time-clock transition: ${state} → ${action}`);
  return next;
}

export function calculatePaidMilliseconds(
  events: Array<{ action: ClockAction; occurredAt: number }>,
  now = Date.now(),
): number {
  const sorted = [...events].sort((a, b) => a.occurredAt - b.occurredAt);
  let state: ClockState = "clocked_out";
  let paidStartedAt: number | null = null;
  let total = 0;
  for (const event of sorted) {
    const next = nextClockState(state, event.action);
    if (event.action === "clock_in" || event.action === "break_end") {
      paidStartedAt = event.occurredAt;
    }
    if ((event.action === "break_start" || event.action === "clock_out") && paidStartedAt !== null) {
      total += event.occurredAt - paidStartedAt;
      paidStartedAt = null;
    }
    state = next;
  }
  if (state === "working" && paidStartedAt !== null) total += now - paidStartedAt;
  return total;
}

export function hasPermission(
  role: "owner" | "manager" | "employee",
  permissions: string[],
  required: string,
): boolean {
  return role === "owner" || permissions.includes(required);
}

export async function hashOpaqueToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function generateOpaqueToken(bytes = 32): string {
  if (bytes < 24) throw new Error("Public tokens must contain at least 192 bits");
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
