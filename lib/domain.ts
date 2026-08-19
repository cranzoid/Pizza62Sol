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

export type WeeklyAvailability = {
  weekdays: number[];
  startMinute: number;
  endMinute: number;
  timeZone: string;
  label?: string;
};

export function isWithinWeeklyAvailability(
  availability: WeeklyAvailability | null | undefined,
  date = new Date(),
): boolean {
  if (!availability) return true;
  if (
    !Array.isArray(availability.weekdays) ||
    !availability.weekdays.length ||
    !availability.weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6) ||
    !Number.isInteger(availability.startMinute) ||
    !Number.isInteger(availability.endMinute) ||
    availability.startMinute < 0 ||
    availability.endMinute > 1440 ||
    availability.startMinute >= availability.endMinute
  ) return false;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: availability.timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const weekdayName = parts.find((part) => part.type === "weekday")?.value;
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName ?? "");
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    const minuteOfDay = hour * 60 + minute;
    return availability.weekdays.includes(weekday) && minuteOfDay >= availability.startMinute && minuteOfDay <= availability.endMinute;
  } catch {
    return false;
  }
}

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

export const CHEESE_OPTIONS = ["No Cheese", "Light Cheese", "Regular Cheese", "Extra Cheese"] as const;
export const DEFAULT_CHEESE_OPTION = "Regular Cheese";
export const EXTRA_CHEESE_OPTION = "Extra Cheese";
export const CRUST_OPTIONS = ["Regular Crust", "Thin Crust", "Thick Crust"] as const;
export const DEFAULT_CRUST_OPTION = "Regular Crust";
export const BAKE_SAUCE_OPTIONS = ["Lightly Done", "Well Done", "Easy on the Sauce", "Extra Sauce"] as const;
export const HALAL_OPTION = "Halal meat toppings";

export type ModifierSource =
  | "toppings"
  | "wing_flavours"
  | "drinks"
  | "pizza_base"
  | "crust"
  | "bake_sauce"
  | "cheese"
  | "halal";

export type ModifierSection = {
  id: string;
  label: string;
  /** Groups sections belonging to the same pizza inside a deal, e.g. "Pizza 1". */
  group?: string;
  source?: ModifierSource;
  options?: string[];
  min: number;
  max: number;
  included?: number;
  extraPriceCents?: number;
  /** Per-option surcharges, e.g. extra cheese. Applied on top of the count allowance. */
  optionPrices?: Record<string, number>;
  sharedGroup?: string;
  sharedIncluded?: number;
};

export type ModifierValue = { value: string; placement: ToppingPlacement };

// The order a customer is asked to build a pizza in: what it is made of first
// (cheese and halal), then how it is baked (crust, bake and sauce), then what goes
// on it. Deals used to ask for toppings before the crust, which made the same
// pizza feel like two different products depending on where it was ordered from.
const SECTION_RANK: Record<string, number> = {
  cheese: 1,
  halal: 2,
  crust: 3,
  bake_sauce: 4,
  pizza_base: 4,
  toppings: 5,
  wing_flavours: 6,
  drinks: 7,
};
const TOPPINGS_FIRST_RANK: Record<string, number> = { ...SECTION_RANK, toppings: 3, crust: 4, bake_sauce: 5, pizza_base: 5 };

export function orderModifierSections<T extends ModifierSection>(
  sections: T[],
  toppingsFirst = false,
): T[] {
  const ranks = toppingsFirst ? TOPPINGS_FIRST_RANK : SECTION_RANK;
  const groupOrder = new Map<string, number>();
  for (const section of sections) {
    const key = section.group ?? "";
    if (!groupOrder.has(key)) groupOrder.set(key, groupOrder.size);
  }
  return sections
    .map((section, index) => ({ section, index }))
    .sort((a, b) => {
      const group = (groupOrder.get(a.section.group ?? "") ?? 0) - (groupOrder.get(b.section.group ?? "") ?? 0);
      if (group !== 0) return group;
      const rank = (ranks[a.section.source ?? ""] ?? 8) - (ranks[b.section.source ?? ""] ?? 8);
      return rank !== 0 ? rank : a.index - b.index;
    })
    .map((entry) => entry.section);
}

/** Collapses duplicates and merges a left+right pair of the same option into a whole. */
export function normalizeModifierValues(
  values: Array<string | { value?: string; placement?: string }>,
): ModifierValue[] {
  const selections = values.map((entry) =>
    typeof entry === "string"
      ? { toppingId: entry, placement: "whole" as ToppingPlacement }
      : { toppingId: entry.value ?? "", placement: (entry.placement ?? "whole") as ToppingPlacement },
  );
  return normalizeToppings(selections).map((entry) => ({
    value: entry.toppingId,
    placement: entry.placement,
  }));
}

export function modifierUnitsBps(values: ModifierValue[], halfToppingUnitsBps = 10_000): number {
  return toppingUnitsBps(
    values.map((entry) => ({ toppingId: entry.value, placement: entry.placement })),
    halfToppingUnitsBps,
  );
}

/** Cost of the topping units that exceed the allowance the flyer price already covers. */
export function priceToppingUnits(
  unitsBps: number,
  includedUnitsBps: number,
  extraPriceCents: number,
): number {
  assertIntegerCents(extraPriceCents, "Extra topping price");
  return Math.round((Math.max(0, unitsBps - Math.max(0, includedUnitsBps)) * extraPriceCents) / 10_000);
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
    } else if (promotion.type === "free_delivery") {
      freeDelivery = true;
    } else {
      // H-11b: this used to be a bare `else`, so any value that was not
      // "percentage" or "fixed" granted free delivery. The type is a string
      // column with no database constraint and the admin route checked only that
      // it was truthy, so a typo — or an old row from a renamed type — silently
      // gave away every delivery fee. Unknown types are now inert.
      continue;
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

export type ClockEventRecord = { action: ClockAction; occurredAt: number };

export type WorkSession = {
  clockIn: number;
  clockOut: number | null;
  breakMs: number;
  paidMs: number;
  open: boolean;
};

/**
 * Turns the raw clock event log into the shifts a person actually worked. Unpaid
 * breaks are subtracted; a session still open (or one whose clock-out is missing)
 * is returned with `open: true` and paid time measured up to `asOf`, so an
 * in-progress shift shows a running total instead of vanishing from a timesheet.
 */
export function buildWorkSessions(events: ClockEventRecord[], asOf = Date.now()): WorkSession[] {
  const ordered = [...events].sort((left, right) => left.occurredAt - right.occurredAt);
  const sessions: WorkSession[] = [];
  let current: WorkSession | null = null;
  let breakStartedAt: number | null = null;
  for (const event of ordered) {
    if (event.action === "clock_in") {
      if (current) sessions.push(current);
      current = { clockIn: event.occurredAt, clockOut: null, breakMs: 0, paidMs: 0, open: true };
      breakStartedAt = null;
      continue;
    }
    if (!current) continue;
    if (event.action === "break_start") breakStartedAt = event.occurredAt;
    if (event.action === "break_end" && breakStartedAt !== null) {
      current.breakMs += Math.max(0, event.occurredAt - breakStartedAt);
      breakStartedAt = null;
    }
    if (event.action === "clock_out") {
      if (breakStartedAt !== null) {
        current.breakMs += Math.max(0, event.occurredAt - breakStartedAt);
        breakStartedAt = null;
      }
      current.clockOut = event.occurredAt;
      current.open = false;
      sessions.push(current);
      current = null;
    }
  }
  if (current) {
    if (breakStartedAt !== null) current.breakMs += Math.max(0, asOf - breakStartedAt);
    sessions.push(current);
  }
  return sessions.map((session) => {
    const end = session.clockOut ?? asOf;
    return { ...session, paidMs: Math.max(0, end - session.clockIn - session.breakMs) };
  });
}

export type TimesheetDay = {
  date: string;
  paidMs: number;
  breakMs: number;
  firstIn: number | null;
  lastOut: number | null;
  open: boolean;
};

const dayKey = (timestamp: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(timestamp));

/** A shift is counted on the day it started, so an overnight close stays on one day. */
export function buildTimesheet(
  events: ClockEventRecord[],
  timeZone: string,
  asOf = Date.now(),
): { days: TimesheetDay[]; totalPaidMs: number; totalBreakMs: number; openSession: boolean } {
  const sessions = buildWorkSessions(events, asOf);
  const byDay = new Map<string, TimesheetDay>();
  for (const session of sessions) {
    const key = dayKey(session.clockIn, timeZone);
    const day = byDay.get(key) ?? { date: key, paidMs: 0, breakMs: 0, firstIn: null, lastOut: null, open: false };
    day.paidMs += session.paidMs;
    day.breakMs += session.breakMs;
    day.firstIn = day.firstIn === null ? session.clockIn : Math.min(day.firstIn, session.clockIn);
    day.lastOut = session.clockOut === null ? day.lastOut : Math.max(day.lastOut ?? 0, session.clockOut);
    day.open = day.open || session.open;
    byDay.set(key, day);
  }
  const days = [...byDay.values()].sort((left, right) => left.date.localeCompare(right.date));
  return {
    days,
    totalPaidMs: days.reduce((sum, day) => sum + day.paidMs, 0),
    totalBreakMs: days.reduce((sum, day) => sum + day.breakMs, 0),
    openSession: sessions.some((session) => session.open),
  };
}

export type PayrollPeriod = "weekly" | "biweekly";

/**
 * The pay period containing `now`, counted forward from the employer's anchor
 * date so periods never drift. Returned bounds are inclusive of the start and
 * exclusive of the end.
 */
export function payPeriodFor(
  now: number,
  options: { period?: PayrollPeriod; anchor: number; offsetPeriods?: number },
): { start: number; end: number; index: number } {
  const length = (options.period === "weekly" ? 7 : 14) * 86_400_000;
  const elapsed = now - options.anchor;
  const index = Math.floor(elapsed / length) + (options.offsetPeriods ?? 0);
  const start = options.anchor + index * length;
  return { start, end: start + length, index };
}

export const ONTARIO_WEEKLY_OVERTIME_MINUTES = 44 * 60;

/**
 * Ontario pays overtime after 44 hours in a work week, not after 8 in a day, so
 * hours are banked per week before the threshold is applied. `weekStartsOn` is a
 * weekday index (0 = Sunday) matching the employer's declared work week.
 */
export function splitOvertime(
  days: Array<{ date: string; paidMs: number }>,
  options: { weeklyOvertimeMinutes?: number; weekStartsOn?: number; timeZone?: string } = {},
): { regularMs: number; overtimeMs: number; weeks: Array<{ weekStart: string; paidMs: number; regularMs: number; overtimeMs: number }> } {
  const threshold = Math.max(0, options.weeklyOvertimeMinutes ?? ONTARIO_WEEKLY_OVERTIME_MINUTES) * 60_000;
  const weekStartsOn = options.weekStartsOn ?? 0;
  const weeks = new Map<string, number>();
  for (const day of days) {
    const [year, month, date] = day.date.split("-").map(Number);
    const utc = Date.UTC(year, month - 1, date);
    const offset = (new Date(utc).getUTCDay() - weekStartsOn + 7) % 7;
    const key = new Date(utc - offset * 86_400_000).toISOString().slice(0, 10);
    weeks.set(key, (weeks.get(key) ?? 0) + day.paidMs);
  }
  const rows = [...weeks.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([weekStart, paidMs]) => ({
      weekStart,
      paidMs,
      regularMs: threshold ? Math.min(paidMs, threshold) : paidMs,
      overtimeMs: threshold ? Math.max(0, paidMs - threshold) : 0,
    }));
  return {
    regularMs: rows.reduce((sum, row) => sum + row.regularMs, 0),
    overtimeMs: rows.reduce((sum, row) => sum + row.overtimeMs, 0),
    weeks: rows,
  };
}

/** Gross pay for a period at the standard time-and-a-half overtime rate. */
export function grossPayCents(regularMs: number, overtimeMs: number, wageCents: number, overtimeMultiplierBps = 15_000): number {
  if (!Number.isSafeInteger(wageCents) || wageCents < 0) throw new Error("Wage must be a non-negative whole number of cents");
  const hourly = wageCents / 3_600_000;
  return Math.round(regularMs * hourly + (overtimeMs * hourly * overtimeMultiplierBps) / 10_000);
}

export type WeeklyHours = Array<{ weekday: number; openMinute: number; closeMinute: number; label?: string }>;

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The weekday and minute-of-day a timestamp falls on in the restaurant's zone. */
export function zonedParts(timestamp: number, timeZone: string): { weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    weekday: WEEKDAY_INDEX[value("weekday")] ?? 0,
    minute: Number(value("hour")) * 60 + Number(value("minute")),
  };
}

/**
 * The instant `dayOffset` local days from now at `minuteOfDay` local time. Adding
 * plain milliseconds would drift by an hour across a daylight-saving change, so
 * the result is corrected once against the zone it actually lands in.
 */
function zonedTimestamp(now: number, dayOffset: number, minuteOfDay: number, timeZone: string): number {
  const from = zonedParts(now, timeZone);
  const naive = now + (dayOffset * 1440 + minuteOfDay - from.minute) * 60_000;
  const landed = zonedParts(naive, timeZone);
  const drift = ((minuteOfDay - landed.minute + 720) % 1440 + 1440) % 1440 - 720;
  return naive + drift * 60_000;
}

export function isStoreOpenAt(timestamp: number, hours: WeeklyHours, timeZone: string): boolean {
  const { weekday, minute } = zonedParts(timestamp, timeZone);
  return isTimeWithinConfiguredHours(weekday, minute, hours);
}

export type StoreStatus = {
  open: boolean;
  /** When the restaurant next opens, or when it closes if it is open now. */
  changesAt: number | null;
  weekdayLabel: string;
};

export function storeStatus(now: number, hours: WeeklyHours, timeZone: string): StoreStatus {
  if (!hours.length) return { open: true, changesAt: null, weekdayLabel: "" };
  const { weekday, minute } = zonedParts(now, timeZone);
  const today = hours.find((entry) => entry.weekday === weekday);
  if (today && minute >= today.openMinute && minute <= today.closeMinute) {
    return { open: true, changesAt: zonedTimestamp(now, 0, today.closeMinute, timeZone), weekdayLabel: today.label ?? "" };
  }
  for (let offset = 0; offset < 8; offset += 1) {
    const day = hours.find((entry) => entry.weekday === (weekday + offset) % 7);
    if (!day) continue;
    if (offset === 0 && minute > day.openMinute) continue;
    return { open: false, changesAt: zonedTimestamp(now, offset, day.openMinute, timeZone), weekdayLabel: day.label ?? "" };
  }
  return { open: false, changesAt: null, weekdayLabel: "" };
}

/**
 * Order times the restaurant can actually accept: inside opening hours, far enough
 * ahead to cover the current lead time, and on the interval the store schedules by.
 * Offering only these keeps a customer from picking a time the kitchen must reject.
 */
export function nextOrderSlots(options: {
  now: number;
  hours: WeeklyHours;
  timeZone: string;
  leadMinutes: number;
  intervalMinutes?: number;
  limit?: number;
  horizonDays?: number;
}): number[] {
  const { now, hours, timeZone, leadMinutes } = options;
  const interval = Math.max(5, options.intervalMinutes ?? 15);
  const limit = options.limit ?? 48;
  const horizon = options.horizonDays ?? 7;
  if (!hours.length) return [];
  const earliest = now + leadMinutes * 60_000;
  const { weekday, minute } = zonedParts(now, timeZone);
  const slots: number[] = [];
  for (let offset = 0; offset <= horizon && slots.length < limit; offset += 1) {
    const day = hours.find((entry) => entry.weekday === (weekday + offset) % 7);
    if (!day) continue;
    const first = Math.ceil(day.openMinute / interval) * interval;
    for (let slotMinute = first; slotMinute <= day.closeMinute && slots.length < limit; slotMinute += interval) {
      // A slot on today's row that has already passed is skipped rather than moved.
      if (offset === 0 && slotMinute < minute) continue;
      const timestamp = zonedTimestamp(now, offset, slotMinute, timeZone);
      if (timestamp >= earliest) slots.push(timestamp);
    }
  }
  return slots;
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
