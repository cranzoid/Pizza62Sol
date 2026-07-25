import { env } from "cloudflare:workers";
import { ensureDatabase, getD1, getSetting, safeJson } from "@/db/runtime";
import {
  generateOpaqueToken,
  hashOpaqueToken,
  isWithinWeeklyAvailability,
  priceCart,
  pricePizza,
  validateDelivery,
  type CartLinePrice,
  type Fulfilment,
  type PromotionRule,
  type ToppingSelection,
  type WeeklyAvailability,
} from "@/lib/domain";
import { resolveDeliveryPoint } from "@/lib/delivery-area";
import { DRINK_OPTIONS, PIZZA_BASE_OPTIONS, WING_FLAVOURS, type ModifierSectionSeed } from "@/lib/menu";

type OrderRequest = {
  idempotencyKey?: string;
  fulfilment?: Fulfilment;
  customer?: { name?: string; phone?: string; email?: string };
  items?: Array<{
    productId?: string;
    variationId?: string;
    quantity?: number;
    toppings?: ToppingSelection[];
    extraCheese?: boolean;
    halal?: boolean;
    modifiers?: Array<{ id?: string; values?: string[] }>;
    specialInstructions?: string;
  }>;
  schedule?: { type?: "asap" | "scheduled"; scheduledFor?: number };
  couponCode?: string;
  paymentMethod?: "pay_at_store" | "online";
  tip?:
    | { type: "none" }
    | { type: "percentage"; valueBps: number }
    | { type: "custom"; amountCents: number };
  address?: {
    line1?: string;
    unit?: string;
    city?: string;
    province?: string;
    postalCode?: string;
    instructions?: string;
  };
};

type DbProduct = {
  id: string;
  category_id: string;
  name: string;
  product_type: string;
  base_price_cents: number;
  taxable: number;
  pickup_eligible: number;
  delivery_eligible: number;
  halal_capable: number;
  promotion_eligible: number;
  active: number;
  sold_out: number;
  setup_required: number;
  configuration_json: string;
};

type DbVariation = {
  id: string;
  product_id: string;
  name: string;
  base_price_cents: number;
  extra_topping_price_cents: number;
  included_topping_units_bps: number;
  active: number;
};

type ValidatedItem = {
  id: string;
  productId: string;
  productName: string;
  categoryId: string;
  variationName: string | null;
  quantity: number;
  unitPriceCents: number;
  taxable: boolean;
  promotionEligible: boolean;
  freeDelivery: boolean;
  snapshot: Record<string, unknown>;
  instructions: string | null;
};

type OrderingSetting = {
  enabled: boolean;
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  payAtStorePickupEnabled: boolean;
  cashOnDeliveryEnabled: boolean;
  pickupEstimateMinutes: number;
  deliveryEstimateMinutes: number | null;
  paused: boolean;
  pauseMessage: string;
};

type DeliverySetting = {
  radiusKm: number;
  feeCents: number;
  minimumCents: number;
  feeTaxable: boolean;
  outsideAreaMessage?: string;
};

type BusinessSetting = {
  latitude: number | null;
  longitude: number | null;
};

type TaxTipSetting = {
  taxRateBps: number;
  tippingEnabled: boolean;
  tipPresetBps: number[];
  customTipEnabled: boolean;
  customTipMaxCents: number;
  customTipMaxBasisBps: number;
};

type OperationSetting = {
  halfToppingUnitsBps: number;
  halalSurchargeType: string;
  halalSurchargeAmount: number;
  feedbackDelayMinutes: number;
};

type ProductConfiguration = {
  sections?: ModifierSectionSeed[];
  pizzaBaseOptions?: string[];
  freeDelivery?: boolean;
  availability?: WeeklyAvailability;
  [key: string]: unknown;
};

function normalizeCustomer(customer: OrderRequest["customer"]) {
  const name = customer?.name?.trim() ?? "";
  const phone = customer?.phone?.replace(/[^0-9+]/g, "") ?? "";
  const email = customer?.email?.trim().toLowerCase() ?? "";
  if (name.length < 2 || name.length > 100) throw new OrderValidationError("Enter your full name.");
  if (phone.length < 10 || phone.length > 16) throw new OrderValidationError("Enter a valid phone number.");
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
    throw new OrderValidationError("Enter a valid email address.");
  }
  return { name, phone, email };
}

function formatDeliveryMinimum(cents: number): string {
  return `$${(Math.max(0, cents) / 100).toFixed(2)}`;
}

function cleanInstructions(value: string | undefined, max = 500): string | null {
  const clean = value?.trim() ?? "";
  if (clean.length > max) throw new OrderValidationError(`Instructions cannot exceed ${max} characters.`);
  return clean || null;
}

function normalizeDeliveryAddress(address: OrderRequest["address"]): Record<string, string> {
  const line1 = address?.line1?.trim() ?? "";
  const unit = address?.unit?.trim() ?? "";
  const city = address?.city?.trim() ?? "";
  const province = address?.province?.trim().toUpperCase() ?? "";
  const postalCode = address?.postalCode?.trim().toUpperCase().replace(/\s/g, "") ?? "";
  if (line1.length < 5 || line1.length > 160) {
    throw new OrderValidationError("Enter a complete delivery street address.");
  }
  if (city.toLowerCase() !== "hamilton" || province !== "ON") {
    throw new OrderValidationError("Online delivery is currently limited to Hamilton, Ontario.");
  }
  if (!/^[A-Z][0-9][A-Z][0-9][A-Z][0-9]$/.test(postalCode)) {
    throw new OrderValidationError("Enter a valid Canadian postal code for delivery.");
  }
  if (unit.length > 40) throw new OrderValidationError("The unit field is too long.");
  return {
    line1,
    unit,
    city: "Hamilton",
    province: "ON",
    postalCode: `${postalCode.slice(0, 3)} ${postalCode.slice(3)}`,
  };
}

function modifierOptions(
  section: ModifierSectionSeed,
  toppingNames: Map<string, string>,
): Map<string, string> {
  if (section.source === "toppings") return toppingNames;
  const options = section.options ?? (
    section.source === "wing_flavours" ? [...WING_FLAVOURS]
      : section.source === "drinks" ? [...DRINK_OPTIONS]
        : section.source === "pizza_base" ? [...PIZZA_BASE_OPTIONS]
          : []
  );
  return new Map(options.map((value) => [value, value]));
}

function validateModifiers(
  input: Array<{ id?: string; values?: string[] }> | undefined,
  sections: ModifierSectionSeed[],
  toppingNames: Map<string, string>,
): { snapshot: Array<{ id: string; label: string; values: Array<{ value: string; label: string }> }>; extraCents: number } {
  const provided = new Map((input ?? []).map((entry) => [entry.id ?? "", entry.values ?? []]));
  if ([...provided.keys()].some((id) => !sections.some((section) => section.id === id))) {
    throw new OrderValidationError("An unsupported item option was submitted.");
  }
  const snapshot: Array<{ id: string; label: string; values: Array<{ value: string; label: string }> }> = [];
  for (const section of sections) {
    const values = provided.get(section.id) ?? [];
    const unique = [...new Set(values)];
    const allowed = modifierOptions(section, toppingNames);
    if (unique.length !== values.length || unique.length < section.min || unique.length > section.max || unique.some((value) => !allowed.has(value))) {
      throw new OrderValidationError(`Choose valid options for ${section.label}.`);
    }
    if (unique.length) {
      snapshot.push({
        id: section.id,
        label: section.label,
        values: unique.map((value) => ({ value, label: allowed.get(value) ?? value })),
      });
    }
  }
  let extraCents = sections
    .filter((section) => !section.sharedGroup)
    .reduce(
      (sum, section) => sum + Math.max(0, (provided.get(section.id)?.length ?? 0) - (section.included ?? section.max)) * (section.extraPriceCents ?? 0),
      0,
    );
  const sharedGroups = new Set(sections.flatMap((section) => section.sharedGroup ? [section.sharedGroup] : []));
  for (const group of sharedGroups) {
    const grouped = sections.filter((section) => section.sharedGroup === group);
    const selected = grouped.reduce((sum, section) => sum + (provided.get(section.id)?.length ?? 0), 0);
    extraCents += Math.max(0, selected - (grouped[0]?.sharedIncluded ?? 0)) * (grouped[0]?.extraPriceCents ?? 0);
  }
  return { snapshot, extraCents };
}

function torontoParts(timestamp: number): { weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekday = weekdayMap[parts.find((part) => part.type === "weekday")?.value ?? ""];
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return { weekday, minute: hour * 60 + minute };
}

function validateSchedule(
  schedule: OrderRequest["schedule"],
  estimateMinutes: number,
  hours: Array<{ weekday: number; openMinute: number; closeMinute: number }>,
): { type: "asap" | "scheduled"; scheduledFor: number | null; estimatedFor: number } {
  const now = Date.now();
  const type = schedule?.type === "scheduled" ? "scheduled" : "asap";
  const requested = type === "scheduled" ? schedule?.scheduledFor : now;
  if (!requested || !Number.isSafeInteger(requested)) {
    throw new OrderValidationError("Choose a valid order time.");
  }
  if (type === "scheduled" && (requested < now + estimateMinutes * 60_000 || requested > now + 14 * 86_400_000)) {
    throw new OrderValidationError("Scheduled time must respect the current lead time and be within 14 days.");
  }
  const local = torontoParts(requested);
  const day = hours.find((entry) => entry.weekday === local.weekday);
  if (!day || local.minute < day.openMinute || local.minute > day.closeMinute) {
    throw new OrderValidationError("That time is outside the restaurant's configured hours.");
  }
  return {
    type,
    scheduledFor: type === "scheduled" ? requested : null,
    estimatedFor: type === "scheduled" ? requested : now + estimateMinutes * 60_000,
  };
}

async function validateItems(
  items: OrderRequest["items"],
  fulfilment: Fulfilment,
  operations: OperationSetting,
): Promise<ValidatedItem[]> {
  if (!items?.length || items.length > 50) throw new OrderValidationError("Your cart is empty or too large.");
  const database = getD1();
  const toppingRows = await database
    .prepare("SELECT id, name, is_meat, has_halal_version, halal_available FROM toppings WHERE active = 1")
    .all<{ id: string; name: string; is_meat: number; has_halal_version: number; halal_available: number }>();
  const allowedToppings = new Set(toppingRows.results.map((row) => row.id));
  const toppingNames = new Map(toppingRows.results.map((row) => [row.id, row.name]));
  const meatToppings = new Set(toppingRows.results.filter((row) => row.is_meat).map((row) => row.id));
  const halalMeatToppings = new Set(toppingRows.results.filter((row) => row.is_meat && row.has_halal_version && row.halal_available).map((row) => row.id));
  const validated: ValidatedItem[] = [];
  for (const input of items) {
    const product = await database
      .prepare(
        `SELECT id, category_id, name, product_type, base_price_cents, taxable,
                pickup_eligible, delivery_eligible, halal_capable, promotion_eligible,
                active, sold_out, setup_required, configuration_json
         FROM products WHERE id = ?`,
      )
      .bind(input.productId ?? "")
      .first<DbProduct>();
    if (!product || !product.active || product.sold_out) {
      throw new OrderValidationError("An item in your cart is no longer available.");
    }
    if (product.setup_required) {
      throw new OrderValidationError(`${product.name} needs owner setup before it can be ordered.`);
    }
    if ((fulfilment === "pickup" && !product.pickup_eligible) || (fulfilment === "delivery" && !product.delivery_eligible)) {
      throw new OrderValidationError(`${product.name} is not available for ${fulfilment}.`);
    }
    const quantity = input.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new OrderValidationError("Item quantity must be between 1 and 20.");
    }
    const instructions = cleanInstructions(input.specialInstructions);
    const productConfiguration = safeJson<ProductConfiguration>(product.configuration_json, {});
    if (!isWithinWeeklyAvailability(productConfiguration.availability)) {
      throw new OrderValidationError(
        `${product.name} is only available ${productConfiguration.availability?.label ?? "during its advertised offer hours"}.`,
        409,
        "PRODUCT_OUTSIDE_OFFER_HOURS",
      );
    }
    let variation: DbVariation | null = null;
    let unitPriceCents = product.base_price_cents;
    let snapshot: Record<string, unknown> = {
      productType: product.product_type,
      productConfiguration,
    };
    if (product.product_type === "pizza") {
      variation = await database
        .prepare(
          `SELECT id, product_id, name, base_price_cents, extra_topping_price_cents,
                  included_topping_units_bps, active
           FROM product_variations WHERE id = ? AND product_id = ?`,
        )
        .bind(input.variationId ?? "", product.id)
        .first<DbVariation>();
      if (!variation?.active) throw new OrderValidationError("Choose an available pizza size.");
      const toppings = input.toppings ?? [];
      if (toppings.length > 100 || toppings.some((entry) => !allowedToppings.has(entry.toppingId))) {
        throw new OrderValidationError("One or more selected toppings are unavailable.");
      }
      if (input.halal && !product.halal_capable) {
        throw new OrderValidationError(`${product.name} is not configured for halal selection.`);
      }
      if (input.halal && toppings.some((entry) => meatToppings.has(entry.toppingId) && !halalMeatToppings.has(entry.toppingId))) {
        throw new OrderValidationError("One or more selected meat toppings do not currently have a halal alternative.");
      }
      const halalSurchargeCents =
        input.halal && operations.halalSurchargeType === "fixed_product"
          ? operations.halalSurchargeAmount
          : 0;
      const pizza = pricePizza({
        basePriceCents: variation.base_price_cents,
        extraToppingPriceCents: variation.extra_topping_price_cents,
        includedToppingUnitsBps: variation.included_topping_units_bps,
        halfToppingUnitsBps: operations.halfToppingUnitsBps,
        toppings,
        extraCheese: Boolean(input.extraCheese),
        halalSurchargeCents,
      });
      unitPriceCents = pizza.totalCents;
      const pizzaBaseSections: ModifierSectionSeed[] = productConfiguration.pizzaBaseOptions?.length
        ? [{ id: "pizza-base", label: "Crust, bake & sauce", options: productConfiguration.pizzaBaseOptions, min: 0, max: 2 }]
        : [];
      const validatedModifiers = validateModifiers(input.modifiers, pizzaBaseSections, toppingNames);
      snapshot = {
        ...snapshot,
        variationId: variation.id,
        variationName: variation.name,
        toppings: pizza.normalizedToppings,
        toppingUnitsBps: pizza.toppingUnitsBps,
        includedUnitsBps: pizza.includedUnitsBps,
        paidUnitsBps: pizza.paidUnitsBps,
        extraCheese: Boolean(input.extraCheese),
        halal: Boolean(input.halal),
        modifiers: validatedModifiers.snapshot,
      };
    } else if (input.toppings?.length || input.extraCheese || input.halal) {
      throw new OrderValidationError(`Unsupported customization was added to ${product.name}.`);
    } else {
      const validatedModifiers = validateModifiers(input.modifiers, productConfiguration.sections ?? [], toppingNames);
      unitPriceCents += validatedModifiers.extraCents;
      snapshot = { ...snapshot, modifiers: validatedModifiers.snapshot, modifierExtraCents: validatedModifiers.extraCents };
    }
    validated.push({
      id: crypto.randomUUID(),
      productId: product.id,
      productName: product.name,
      categoryId: product.category_id,
      variationName: variation?.name ?? null,
      quantity,
      unitPriceCents,
      taxable: Boolean(product.taxable),
      promotionEligible: Boolean(product.promotion_eligible),
      freeDelivery: Boolean(productConfiguration.freeDelivery),
      snapshot,
      instructions,
    });
  }
  return validated;
}

function normalizeCouponCode(code: string | undefined): string | null {
  const clean = code?.trim().toUpperCase() ?? "";
  if (!clean) return null;
  if (clean.length > 40 || !/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(clean)) {
    throw new OrderValidationError("That promo code isn't valid.", 400, "PROMO_CODE_INVALID");
  }
  return clean;
}

// C-02: coded promotions must never apply automatically. Promotions with a `code`
// are only eligible when the customer supplies that exact code; promotions without
// a code remain automatic. A supplied code that matches nothing is rejected so the
// customer gets explicit feedback rather than a silently ignored coupon.
async function activePromotions(
  fulfilment: Fulfilment,
  couponCode: string | null,
): Promise<PromotionRule[]> {
  const now = Date.now();
  const result = await getD1()
    .prepare(
      `SELECT id, name, code, type, amount, priority, combinable, exclusive, stack_group, rule_json
       FROM promotions WHERE active = 1 AND (starts_at IS NULL OR starts_at <= ?)
       AND (ends_at IS NULL OR ends_at >= ?) ORDER BY priority DESC, id`,
    )
    .bind(now, now)
    .all<Record<string, unknown>>();
  let couponMatched = false;
  const rules: PromotionRule[] = [];
  for (const row of result.results) {
    const code = row.code ? String(row.code).trim().toUpperCase() : "";
    if (code) {
      if (!couponCode || code !== couponCode) continue;
      couponMatched = true;
    }
    const rule = safeJson<Record<string, unknown>>(row.rule_json as string, {});
    rules.push({
      id: row.id as string,
      name: row.name as string,
      type: row.type as PromotionRule["type"],
      amount: row.amount as number,
      priority: row.priority as number,
      combinable: Boolean(row.combinable),
      exclusive: Boolean(row.exclusive),
      stackGroup: row.stack_group as string | null,
      fulfilments: (rule.fulfilments as Fulfilment[] | undefined) ?? [fulfilment],
      minimumCents: rule.minimumCents as number | undefined,
      productIds: rule.productIds as string[] | undefined,
      categoryIds: rule.categoryIds as string[] | undefined,
    });
  }
  if (couponCode && !couponMatched) {
    throw new OrderValidationError("That promo code isn't valid right now.", 400, "PROMO_CODE_INVALID");
  }
  return rules;
}

async function createStripeCheckout(input: {
  origin: string;
  orderId: string;
  orderNumber: string;
  trackingToken: string;
  customerEmail: string;
  totalCents: number;
}): Promise<{ id: string; url: string }> {
  const secret = (env as unknown as Record<string, string | undefined>).STRIPE_SECRET_KEY;
  if (!secret) {
    throw new OrderValidationError(
      "Online payment is ready for the restaurant's Stripe key. No payment was taken.",
      503,
      "PAYMENT_SETUP_REQUIRED",
    );
  }
  const successUrl = new URL("/track", input.origin);
  successUrl.searchParams.set("order", input.orderNumber);
  successUrl.searchParams.set("token", input.trackingToken);
  successUrl.searchParams.set("payment", "success");
  const cancelUrl = new URL("/", input.origin);
  cancelUrl.searchParams.set("checkout", "cancelled");
  const form = new URLSearchParams({
    mode: "payment",
    success_url: successUrl.toString(),
    cancel_url: cancelUrl.toString(),
    customer_email: input.customerEmail,
    client_reference_id: input.orderId,
    "metadata[order_id]": input.orderId,
    "metadata[order_number]": input.orderNumber,
    "line_items[0][price_data][currency]": "cad",
    "line_items[0][price_data][unit_amount]": String(input.totalCents),
    "line_items[0][price_data][product_data][name]": `Pizza 62 order ${input.orderNumber}`,
    "line_items[0][quantity]": "1",
  });
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const result = await response.json() as { id?: string; url?: string; error?: { message?: string } };
  if (!response.ok || !result.id || !result.url) {
    throw new Error(result.error?.message ?? "Stripe checkout session could not be created");
  }
  return { id: result.id, url: result.url };
}

export class OrderValidationError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "ORDER_VALIDATION_FAILED",
  ) {
    super(message);
  }
}

export async function createOrder(body: OrderRequest, origin: string) {
  await ensureDatabase();
  const idempotencyKey = body.idempotencyKey?.trim() ?? "";
  if (idempotencyKey.length < 20 || idempotencyKey.length > 200) {
    throw new OrderValidationError("A valid checkout idempotency key is required.");
  }
  const keyHash = await hashOpaqueToken(`order:${idempotencyKey}`);
  const now = Date.now();
  const reservation = await getD1()
    .prepare(
      `INSERT INTO idempotency_keys (key_hash, scope, status, expires_at, created_at)
       VALUES (?, 'order.create', 'pending', ?, ?) ON CONFLICT(key_hash) DO NOTHING`,
    )
    .bind(keyHash, now + 24 * 60 * 60 * 1000, now)
    .run();
  if (!reservation.meta.changes) {
    const existing = await getD1()
      .prepare("SELECT resource_id, status FROM idempotency_keys WHERE key_hash = ?")
      .bind(keyHash)
      .first<{ resource_id: string | null; status: string }>();
    // C-07: a reserved-but-unresolved key means a concurrent submission of the same
    // checkout attempt is still running. That is transient, not terminal — the caller
    // must keep its key and retry, so we throw before the try block (which would
    // otherwise release the key the in-flight request still owns).
    if (!existing?.resource_id) {
      throw new OrderValidationError(
        "This checkout is still being processed. Wait a moment and try again.",
        409,
        "CHECKOUT_IN_PROGRESS",
      );
    }
    // Terminal duplicate: the order exists. Return enough of it for the customer to
    // recognise their order and stop retrying. Tracking/feedback tokens are stored
    // only as hashes and are deliberately not recoverable here.
    const order = await getD1()
      .prepare(
        `SELECT order_number, status, payment_status, estimated_for, total_cents
         FROM orders WHERE id = ?`,
      )
      .bind(existing.resource_id)
      .first<Record<string, unknown>>();
    return {
      duplicate: true,
      orderId: existing.resource_id,
      orderNumber: order?.order_number ?? null,
      status: order?.status ?? null,
      paymentStatus: order?.payment_status ?? null,
      estimateAt: order?.estimated_for ?? null,
      totalCents: order?.total_cents ?? null,
      message: "This checkout was already submitted, so we did not place a second order.",
    };
  }
  try {
    const customer = normalizeCustomer(body.customer);
    const fulfilment = body.fulfilment;
    if (fulfilment !== "pickup" && fulfilment !== "delivery") {
      throw new OrderValidationError("Choose pickup or delivery.");
    }
    const [ordering, delivery, taxTips, operations, hours, business] = await Promise.all([
      getSetting<OrderingSetting>("ordering"),
      getSetting<DeliverySetting>("delivery"),
      getSetting<TaxTipSetting>("taxAndTips"),
      getSetting<OperationSetting>("operations"),
      getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours"),
      getSetting<BusinessSetting>("business"),
    ]);
    if (!ordering.enabled || ordering.paused) {
      throw new OrderValidationError(ordering.pauseMessage, 409, "ORDERING_PAUSED");
    }
    if ((fulfilment === "pickup" && !ordering.pickupEnabled) || (fulfilment === "delivery" && !ordering.deliveryEnabled)) {
      throw new OrderValidationError(`${fulfilment} ordering is currently unavailable.`, 409);
    }
    const paymentMethod = body.paymentMethod;
    if (paymentMethod !== "pay_at_store" && paymentMethod !== "online") {
      throw new OrderValidationError("Choose an available payment method.");
    }
    if (paymentMethod === "pay_at_store" && (fulfilment !== "pickup" || !ordering.payAtStorePickupEnabled)) {
      throw new OrderValidationError("Pay at store is available for pickup orders only.");
    }
    if (paymentMethod === "online" && !(env as unknown as Record<string, string | undefined>).STRIPE_SECRET_KEY) {
      throw new OrderValidationError(
        "Online payment is ready for the restaurant's Stripe key. No payment was taken.",
        503,
        "PAYMENT_SETUP_REQUIRED",
      );
    }
    const deliveryAddress = fulfilment === "delivery" ? normalizeDeliveryAddress(body.address) : null;
    const items = await validateItems(body.items, fulfilment, operations);
    const cartLines: CartLinePrice[] = items.map((item) => ({
      id: item.id,
      productId: item.productId,
      categoryId: item.categoryId,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      taxable: item.taxable,
      promotionEligible: item.promotionEligible,
    }));
    const couponCode = normalizeCouponCode(body.couponCode);
    const promotions = await activePromotions(fulfilment, couponCode);
    if (fulfilment === "delivery" && items.some((item) => item.freeDelivery)) {
      promotions.push({
        id: "included-free-delivery",
        name: "Included free delivery",
        type: "free_delivery",
        amount: 0,
        priority: 10_000,
        combinable: true,
        exclusive: false,
      });
    }
    const price = priceCart({
      lines: cartLines,
      promotions,
      fulfilment,
      deliveryFeeCents: delivery.feeCents,
      taxRateBps: taxTips.taxRateBps,
      deliveryFeeTaxable: delivery.feeTaxable,
      tip: taxTips.tippingEnabled ? body.tip ?? { type: "none" } : { type: "none" },
      customTipMaxCents: taxTips.customTipMaxCents,
      customTipMaxBasisBps: taxTips.customTipMaxBasisBps,
    });
    if (fulfilment === "delivery" && deliveryAddress) {
      // C-01/H-06: enforce geographic eligibility from the immutable store origin
      // before any order/payment is created. Free-delivery items never widen the
      // radius — they only zero the fee for an already-eligible address.
      const hasFreeDeliveryItem = items.some((item) => item.freeDelivery);
      const point = resolveDeliveryPoint(deliveryAddress.postalCode);
      const eligibility = validateDelivery(
        {
          validated: point !== null,
          latitude: point?.latitude ?? null,
          longitude: point?.longitude ?? null,
        },
        {
          originLatitude: business.latitude,
          originLongitude: business.longitude,
          radiusKm: delivery.radiusKm,
          feeCents: delivery.feeCents,
          minimumCents: delivery.minimumCents,
        },
        price.menuSubtotalCents,
        hasFreeDeliveryItem,
      );
      if (!eligibility.eligible) {
        const message =
          eligibility.reason === "below_minimum"
            ? `Delivery orders must be at least ${formatDeliveryMinimum(delivery.minimumCents)} before tax.`
            : delivery.outsideAreaMessage ??
              "This address is outside our delivery area. Please call Pizza 62 to ask about an exception.";
        throw new OrderValidationError(message, 422, "DELIVERY_ADDRESS_INELIGIBLE");
      }
    }
    const estimateMinutes = fulfilment === "delivery"
      ? ordering.deliveryEstimateMinutes ?? 30
      : ordering.pickupEstimateMinutes;
    const schedule = validateSchedule(body.schedule, estimateMinutes, hours);
    const sequence = await getD1()
      .prepare(
        "UPDATE order_sequences SET current_number = current_number + 1 WHERE key = 'public_order' RETURNING current_number",
      )
      .first<{ current_number: number }>();
    if (!sequence) throw new Error("Order number sequence is unavailable");
    const orderId = crypto.randomUUID();
    const orderNumber = `P62-${sequence.current_number}`;
    const trackingToken = generateOpaqueToken();
    const feedbackToken = generateOpaqueToken();
    const trackingTokenHash = await hashOpaqueToken(trackingToken);
    const feedbackTokenHash = await hashOpaqueToken(feedbackToken);
    const orderStatus = paymentMethod === "online" ? "awaiting_payment" : "received";
    const paymentStatus = paymentMethod === "online" ? "awaiting_checkout" : "pending_at_store";
    const paymentProvider = paymentMethod === "online" ? "stripe" : "store";
    const outboxStatus = paymentMethod === "online"
      ? "waiting_payment"
      : (env as unknown as Record<string, string | undefined>).EMAIL_API_KEY
        ? "pending"
        : "pending_provider_setup";
    const operationsBatch: D1PreparedStatement[] = [
      getD1()
        .prepare(
          `INSERT INTO orders
           (id, order_number, tracking_token_hash, feedback_token_hash, customer_name, customer_phone,
            customer_email, fulfilment, status, payment_status, payment_method, schedule_type,
            scheduled_for, estimated_for, address_json, instructions, pricing_json, subtotal_cents,
            discount_cents, tax_cents, delivery_fee_cents, tip_cents, total_cents, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          orderId,
          orderNumber,
          trackingTokenHash,
          feedbackTokenHash,
          customer.name,
          customer.phone,
          customer.email,
          fulfilment,
          orderStatus,
          paymentStatus,
          paymentMethod,
          schedule.type,
          schedule.scheduledFor,
          schedule.estimatedFor,
          deliveryAddress ? JSON.stringify(deliveryAddress) : null,
          cleanInstructions(body.address?.instructions),
          JSON.stringify(price),
          price.menuSubtotalCents,
          price.discountCents,
          price.taxCents,
          price.deliveryFeeCents,
          price.tipCents,
          price.totalCents,
          now,
          now,
        ),
      getD1()
        .prepare(
          `INSERT INTO payments
           (id, order_id, provider, method, status, amount_cents, currency, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'CAD', ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          orderId,
          paymentProvider,
          paymentMethod,
          paymentMethod === "online" ? "pending" : "pending",
          price.totalCents,
          idempotencyKey,
          now,
          now,
        ),
      getD1()
        .prepare(
          `INSERT INTO order_events
           (id, order_id, previous_status, next_status, actor_type, actor_id, note, created_at)
           VALUES (?, ?, NULL, ?, 'system', NULL, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          orderId,
          orderStatus,
          paymentMethod === "online"
            ? "Order validated; waiting for Stripe payment"
            : "Order accepted after server validation",
          now,
        ),
      getD1()
        .prepare(
          `INSERT INTO notification_outbox
           (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
           VALUES (?, 'customer_order_confirmation', ?, ?, ?, 0, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          customer.email,
          JSON.stringify({ orderId, orderNumber }),
          outboxStatus,
          now,
          now,
          now,
        ),
      getD1()
        .prepare(
          "UPDATE idempotency_keys SET resource_id = ?, status = 'completed' WHERE key_hash = ?",
        )
        .bind(orderId, keyHash),
    ];
    for (const item of items) {
      operationsBatch.push(
        getD1()
          .prepare(
            `INSERT INTO order_items
             (id, order_id, product_id, product_name, variation_name, quantity, unit_price_cents,
              line_total_cents, taxable, snapshot_json, instructions, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            item.id,
            orderId,
            item.productId,
            item.productName,
            item.variationName,
            item.quantity,
            item.unitPriceCents,
            item.unitPriceCents * item.quantity,
            item.taxable ? 1 : 0,
            JSON.stringify(item.snapshot),
            item.instructions,
            now,
          ),
      );
    }
    await getD1().batch(operationsBatch);
    if (paymentMethod === "online") {
      try {
        const checkout = await createStripeCheckout({
          origin,
          orderId,
          orderNumber,
          trackingToken,
          customerEmail: customer.email,
          totalCents: price.totalCents,
        });
        await getD1()
          .prepare("UPDATE payments SET provider_reference = ?, updated_at = ? WHERE order_id = ? AND provider = 'stripe'")
          .bind(checkout.id, Date.now(), orderId)
          .run();
        return {
          duplicate: false,
          orderId,
          orderNumber,
          trackingToken,
          feedbackToken,
          status: orderStatus,
          paymentStatus,
          estimateAt: schedule.estimatedFor,
          price,
          checkoutUrl: checkout.url,
        };
      } catch (error) {
        await getD1().batch([
          getD1()
            .prepare("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE order_id = ?")
            .bind(error instanceof Error ? error.message.slice(0, 500) : "Stripe checkout failed", Date.now(), orderId),
          getD1()
            .prepare("UPDATE orders SET status = 'cancelled', payment_status = 'failed', updated_at = ? WHERE id = ?")
            .bind(Date.now(), orderId),
          // H-17: releasing the idempotency key lets the customer retry the same
          // checkout attempt and get a fresh order instead of resolving to this
          // cancelled one. The failed order/payment rows remain for reconciliation.
          getD1()
            .prepare("DELETE FROM idempotency_keys WHERE key_hash = ?")
            .bind(keyHash),
        ]);
        throw new OrderValidationError(
          "Stripe checkout could not start. No payment was taken; please try again.",
          502,
          "PAYMENT_PROVIDER_ERROR",
        );
      }
    }
    return {
      duplicate: false,
      orderId,
      orderNumber,
      trackingToken,
      feedbackToken,
      status: orderStatus,
      paymentStatus,
      estimateAt: schedule.estimatedFor,
      price,
    };
  } catch (error) {
    await getD1().prepare("DELETE FROM idempotency_keys WHERE key_hash = ? AND status = 'pending'").bind(keyHash).run();
    throw error;
  }
}
