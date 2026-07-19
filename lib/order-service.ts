import { ensureDatabase, getD1, getSetting, safeJson } from "@/db/runtime";
import {
  generateOpaqueToken,
  hashOpaqueToken,
  priceCart,
  pricePizza,
  type CartLinePrice,
  type Fulfilment,
  type PromotionRule,
  type ToppingSelection,
} from "@/lib/domain";

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
    specialInstructions?: string;
  }>;
  schedule?: { type?: "asap" | "scheduled"; scheduledFor?: number };
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

function cleanInstructions(value: string | undefined, max = 500): string | null {
  const clean = value?.trim() ?? "";
  if (clean.length > max) throw new OrderValidationError(`Instructions cannot exceed ${max} characters.`);
  return clean || null;
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
    .prepare("SELECT id FROM toppings WHERE active = 1")
    .all<{ id: string }>();
  const allowedToppings = new Set(toppingRows.results.map((row) => row.id));
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
    let variation: DbVariation | null = null;
    let unitPriceCents = product.base_price_cents;
    let snapshot: Record<string, unknown> = {
      productType: product.product_type,
      productConfiguration: safeJson(product.configuration_json, {}),
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
      };
    } else if (input.toppings?.length || input.extraCheese || input.halal) {
      throw new OrderValidationError(`Unsupported customization was added to ${product.name}.`);
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
      snapshot,
      instructions,
    });
  }
  return validated;
}

async function activePromotions(fulfilment: Fulfilment): Promise<PromotionRule[]> {
  const now = Date.now();
  const result = await getD1()
    .prepare(
      `SELECT id, name, type, amount, priority, combinable, exclusive, stack_group, rule_json
       FROM promotions WHERE active = 1 AND (starts_at IS NULL OR starts_at <= ?)
       AND (ends_at IS NULL OR ends_at >= ?) ORDER BY priority DESC, id`,
    )
    .bind(now, now)
    .all<Record<string, unknown>>();
  return result.results.map((row) => {
    const rule = safeJson<Record<string, unknown>>(row.rule_json as string, {});
    return {
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
    };
  });
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

export async function createOrder(body: OrderRequest) {
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
    return {
      duplicate: true,
      orderId: existing?.resource_id ?? null,
      message: "This checkout was already submitted. Use the tracking link from the original confirmation.",
    };
  }
  try {
    const customer = normalizeCustomer(body.customer);
    const fulfilment = body.fulfilment;
    if (fulfilment !== "pickup" && fulfilment !== "delivery") {
      throw new OrderValidationError("Choose pickup or delivery.");
    }
    const [ordering, delivery, taxTips, operations, hours] = await Promise.all([
      getSetting<OrderingSetting>("ordering"),
      getSetting<DeliverySetting>("delivery"),
      getSetting<TaxTipSetting>("taxAndTips"),
      getSetting<OperationSetting>("operations"),
      getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours"),
    ]);
    if (!ordering.enabled || ordering.paused) {
      throw new OrderValidationError(ordering.pauseMessage, 409, "ORDERING_PAUSED");
    }
    if ((fulfilment === "pickup" && !ordering.pickupEnabled) || (fulfilment === "delivery" && !ordering.deliveryEnabled)) {
      throw new OrderValidationError(`${fulfilment} ordering is currently unavailable.`, 409);
    }
    if (fulfilment === "delivery") {
      throw new OrderValidationError(
        "Delivery checkout will open after the owner configures the restaurant origin and address-validation provider.",
        503,
        "DELIVERY_SETUP_REQUIRED",
      );
    }
    if (body.paymentMethod === "online") {
      throw new OrderValidationError(
        "Online payment is not configured yet. No payment was taken.",
        503,
        "PAYMENT_SETUP_REQUIRED",
      );
    }
    if (body.paymentMethod !== "pay_at_store" || !ordering.payAtStorePickupEnabled) {
      throw new OrderValidationError("Choose an available payment method.");
    }
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
    const price = priceCart({
      lines: cartLines,
      promotions: await activePromotions(fulfilment),
      fulfilment,
      deliveryFeeCents: delivery.feeCents,
      taxRateBps: taxTips.taxRateBps,
      deliveryFeeTaxable: delivery.feeTaxable,
      tip: taxTips.tippingEnabled ? body.tip ?? { type: "none" } : { type: "none" },
      customTipMaxCents: taxTips.customTipMaxCents,
      customTipMaxBasisBps: taxTips.customTipMaxBasisBps,
    });
    const schedule = validateSchedule(body.schedule, ordering.pickupEstimateMinutes, hours);
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
    const operationsBatch: D1PreparedStatement[] = [
      getD1()
        .prepare(
          `INSERT INTO orders
           (id, order_number, tracking_token_hash, feedback_token_hash, customer_name, customer_phone,
            customer_email, fulfilment, status, payment_status, payment_method, schedule_type,
            scheduled_for, estimated_for, address_json, instructions, pricing_json, subtotal_cents,
            discount_cents, tax_cents, delivery_fee_cents, tip_cents, total_cents, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', 'pending_at_store', 'pay_at_store', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          schedule.type,
          schedule.scheduledFor,
          schedule.estimatedFor,
          null,
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
           VALUES (?, ?, 'store', 'pay_at_store', 'pending', ?, 'CAD', ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), orderId, price.totalCents, idempotencyKey, now, now),
      getD1()
        .prepare(
          `INSERT INTO order_events
           (id, order_id, previous_status, next_status, actor_type, actor_id, note, created_at)
           VALUES (?, ?, NULL, 'received', 'system', NULL, 'Order accepted after server validation', ?)`,
        )
        .bind(crypto.randomUUID(), orderId, now),
      getD1()
        .prepare(
          `INSERT INTO notification_outbox
           (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
           VALUES (?, 'customer_order_confirmation', ?, ?, 'pending_provider_setup', 0, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          customer.email,
          JSON.stringify({ orderId, orderNumber }),
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
    return {
      duplicate: false,
      orderId,
      orderNumber,
      trackingToken,
      feedbackToken,
      status: "received",
      paymentStatus: "pending_at_store",
      estimateAt: schedule.estimatedFor,
      price,
    };
  } catch (error) {
    await getD1().prepare("DELETE FROM idempotency_keys WHERE key_hash = ? AND status = 'pending'").bind(keyHash).run();
    throw error;
  }
}
