import { ensureDatabase, getD1, getSetting, safeJson } from "@/db/runtime";
import {
  BAKE_SAUCE_OPTIONS,
  CHEESE_OPTIONS,
  CRUST_OPTIONS,
  HALAL_OPTION,
  explainPromotionMiss,
  generateOpaqueToken,
  hashOpaqueToken,
  isWithinWeeklyAvailability,
  modifierUnitsBps,
  normalizeModifierValues,
  orderModifierSections,
  priceCart,
  pricePizza,
  priceToppingUnits,
  validateDelivery,
  type AppliedPromotion,
  type CartLinePrice,
  type Fulfilment,
  type PromotionRule,
  type ToppingPlacement,
  type ToppingSelection,
  type WeeklyAvailability,
} from "@/lib/domain";
import { resolveDeliveryPoint } from "@/lib/delivery-area";
import { closureFor, closureMessage, loadActiveClosures } from "@/lib/closures";
import {
  createCloverCheckout,
  createCloverCharge,
  cloverCheckoutConfigured,
  cloverIframeEnabled,
  CloverDeclinedError,
} from "@/lib/clover";
import { applyPaymentApproved } from "@/lib/payment-completion";
import { anyProviderConfigured } from "@/lib/notifications/config";
import { dispatchSoon } from "@/lib/notifications/dispatcher";
import { DRINK_OPTIONS, PIZZA_BASE_OPTIONS, WING_FLAVOURS, type ModifierSectionSeed } from "@/lib/menu";

export type OrderRequest = {
  idempotencyKey?: string;
  fulfilment?: Fulfilment;
  customer?: { name?: string; phone?: string; email?: string };
  items?: Array<{
    productId?: string;
    variationId?: string;
    quantity?: number;
    toppings?: ToppingSelection[];
    /** H-03: recipe toppings the customer asked to leave off. Must be a subset. */
    omitToppings?: string[];
    extraCheese?: boolean;
    halal?: boolean;
    modifiers?: Array<{ id?: string; values?: Array<string | { value?: string; placement?: string }> }>;
    specialInstructions?: string;
  }>;
  schedule?: { type?: "asap" | "scheduled"; scheduledFor?: number };
  couponCode?: string;
  paymentMethod?: "pay_at_store" | "online";
  /**
   * A single-use card token minted by Clover's iframe in the customer's browser.
   * Present only for inline card entry; its absence selects the hosted-checkout
   * path. It is a token, never card data — the card itself never reaches us.
   */
  paymentToken?: string;
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
  crustOptions?: string[];
  bakeSauceOptions?: string[];
  cheeseEnabled?: boolean;
  requireIncludedToppings?: boolean;
  toppingsFirst?: boolean;
  freeDelivery?: boolean;
  availability?: WeeklyAvailability;
  [key: string]: unknown;
};

// Crust and bake/sauce are separate groups so a customer cannot pick both Thin and
// Thick. Pizzas configured before the split still carry pizzaBaseOptions, which is
// honoured as one combined group so existing products keep validating.
function pizzaOptionSections(configuration: ProductConfiguration): ModifierSectionSeed[] {
  const sections: ModifierSectionSeed[] = [];
  if (configuration.crustOptions?.length) {
    sections.push({ id: "pizza-crust", label: "Crust", source: "crust", options: configuration.crustOptions, min: 0, max: 1 });
  }
  if (configuration.bakeSauceOptions?.length) {
    sections.push({ id: "pizza-bake-sauce", label: "Bake & sauce", source: "bake_sauce", options: configuration.bakeSauceOptions, min: 0, max: 2 });
  }
  if (!sections.length && configuration.pizzaBaseOptions?.length) {
    sections.push({ id: "pizza-base", label: "Crust, bake & sauce", source: "pizza_base", options: configuration.pizzaBaseOptions, min: 0, max: 2 });
  }
  return sections;
}

/**
 * Contact details, with different rules for a customer and for the counter.
 *
 * Online, all three are required: the email is how the confirmation and the
 * tracking link reach the customer, and without it the order is unreachable.
 *
 * At the counter, a name is enough. Someone ordering two slices has not given an
 * email address, and demanding one produces `x@x.com` typed by a member of staff
 * to get past the form — a worse outcome than an empty field, because it looks
 * like data. An order with no email simply gets no confirmation email.
 */
function normalizeCustomer(customer: OrderRequest["customer"], staffEntry = false) {
  const name = customer?.name?.trim() ?? "";
  const phone = customer?.phone?.replace(/[^0-9+]/g, "") ?? "";
  const email = customer?.email?.trim().toLowerCase() ?? "";
  if (name.length < 2 || name.length > 100) {
    throw new OrderValidationError(staffEntry ? "Give the order a name so staff can call it out." : "Enter your full name.");
  }
  if (staffEntry) {
    if (phone && (phone.length < 10 || phone.length > 16)) {
      throw new OrderValidationError("That phone number does not look right.");
    }
    if (email && (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254)) {
      throw new OrderValidationError("That email address does not look right.");
    }
    return { name, phone, email };
  }
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
          : section.source === "crust" ? [...CRUST_OPTIONS]
            : section.source === "bake_sauce" ? [...BAKE_SAUCE_OPTIONS]
              : section.source === "cheese" ? [...CHEESE_OPTIONS]
                : section.source === "halal" ? [HALAL_OPTION]
                  : []
  );
  return new Map(options.map((value) => [value, value]));
}

type ModifierSnapshot = {
  id: string;
  label: string;
  group?: string;
  values: Array<{ value: string; label: string; placement?: ToppingPlacement }>;
};

function validateModifiers(
  input: Array<{ id?: string; values?: Array<string | { value?: string; placement?: string }> }> | undefined,
  sections: ModifierSectionSeed[],
  toppingNames: Map<string, string>,
  halfToppingUnitsBps: number,
): { snapshot: ModifierSnapshot[]; extraCents: number } {
  const provided = new Map((input ?? []).map((entry) => [entry.id ?? "", entry.values ?? []]));
  if ([...provided.keys()].some((id) => !sections.some((section) => section.id === id))) {
    throw new OrderValidationError("An unsupported item option was submitted.");
  }
  const snapshot: ModifierSnapshot[] = [];
  const sharedUnits = new Map<string, number>();
  let extraCents = 0;
  for (const section of sections) {
    const raw = provided.get(section.id) ?? [];
    const allowed = modifierOptions(section, toppingNames);
    const optionPrices = section.optionPrices ?? {};
    if (section.source === "toppings") {
      // Topping groups carry a placement per selection, so a half topping consumes
      // only part of the included allowance and is charged proportionally.
      let normalized;
      try {
        normalized = normalizeModifierValues(raw);
      } catch {
        throw new OrderValidationError(`Choose valid options for ${section.label}.`);
      }
      if (normalized.length < section.min || normalized.length > section.max || normalized.some((entry) => !allowed.has(entry.value))) {
        throw new OrderValidationError(`Choose valid options for ${section.label}.`);
      }
      const unitsBps = modifierUnitsBps(normalized, halfToppingUnitsBps);
      if (section.sharedGroup) {
        sharedUnits.set(section.sharedGroup, (sharedUnits.get(section.sharedGroup) ?? 0) + unitsBps);
      } else {
        extraCents += priceToppingUnits(unitsBps, (section.included ?? 0) * 10_000, section.extraPriceCents ?? 0);
      }
      extraCents += normalized.reduce((sum, entry) => sum + (optionPrices[entry.value] ?? 0), 0);
      if (normalized.length) {
        snapshot.push({
          id: section.id,
          label: section.label,
          group: section.group,
          values: normalized.map((entry) => ({
            value: entry.value,
            label: allowed.get(entry.value) ?? entry.value,
            placement: entry.placement,
          })),
        });
      }
      continue;
    }
    const values = raw.map((entry) => (typeof entry === "string" ? entry : String(entry?.value ?? "")));
    const unique = [...new Set(values)];
    if (unique.length !== values.length || unique.length < section.min || unique.length > section.max || unique.some((value) => !allowed.has(value))) {
      throw new OrderValidationError(`Choose valid options for ${section.label}.`);
    }
    extraCents += Math.max(0, unique.length - (section.included ?? section.max)) * (section.extraPriceCents ?? 0);
    extraCents += unique.reduce((sum, value) => sum + (optionPrices[value] ?? 0), 0);
    if (unique.length) {
      snapshot.push({
        id: section.id,
        label: section.label,
        group: section.group,
        values: unique.map((value) => ({ value, label: allowed.get(value) ?? value })),
      });
    }
  }
  for (const [group, unitsBps] of sharedUnits) {
    const grouped = sections.filter((section) => section.sharedGroup === group);
    extraCents += priceToppingUnits(unitsBps, (grouped[0]?.sharedIncluded ?? 0) * 10_000, grouped[0]?.extraPriceCents ?? 0);
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

      // H-03: a specialty pizza has to arrive as its recipe. The client could
      // previously drop recipe toppings and the server priced and accepted
      // whatever it was sent, so a "Meat Lovers" could reach the kitchen with no
      // meat on it — at the Meat Lovers price, under the Meat Lovers name.
      //
      // Omissions are still allowed, because "hold the mushrooms" is a normal
      // request. They are just made explicit: named, checked against the recipe,
      // and recorded on the snapshot so the kitchen ticket can print NO
      // MUSHROOMS. What is not allowed is a recipe topping quietly going missing.
      //
      // The price does not move for an omission. Leaving an ingredient off is not
      // a discount, and treating it as one would let a customer pay less for the
      // same named product by removing something and adding it back as an extra.
      const recipeOmissions: string[] = [];
      if (productConfiguration.fixedRecipe) {
        const recipe = Array.isArray(productConfiguration.recipeToppingIds)
          ? productConfiguration.recipeToppingIds.map(String)
          : [];
        const omitted = new Set((input.omitToppings ?? []).map(String));
        for (const toppingId of omitted) {
          if (!recipe.includes(toppingId)) {
            throw new OrderValidationError(
              `${product.name} does not include that topping, so it cannot be left off.`,
            );
          }
          recipeOmissions.push(toppingNames.get(toppingId) ?? toppingId);
        }
        const present = new Set(
          toppings.filter((entry) => entry.placement === "whole").map((entry) => entry.toppingId),
        );
        const missing = recipe.filter((toppingId) => !present.has(toppingId) && !omitted.has(toppingId));
        if (missing.length) {
          throw new OrderValidationError(
            `${product.name} is made to a set recipe. ${missing
              .map((toppingId) => toppingNames.get(toppingId) ?? toppingId)
              .join(", ")} cannot be removed without asking us to leave it off.`,
            422,
            "RECIPE_INCOMPLETE",
          );
        }
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
      if (productConfiguration.requireIncludedToppings) {
        const selectedToppingUnitsBps = modifierUnitsBps(
          pizza.normalizedToppings.map((entry) => ({ value: entry.toppingId, placement: entry.placement })),
          operations.halfToppingUnitsBps,
        );
        if (selectedToppingUnitsBps < variation.included_topping_units_bps) {
          const required = variation.included_topping_units_bps / 10_000;
          throw new OrderValidationError(
            `${product.name} requires at least ${required} topping${required === 1 ? "" : "s"}.`,
            422,
            "TOPPINGS_INCOMPLETE",
          );
        }
      }
      unitPriceCents = pizza.totalCents;
      const validatedModifiers = validateModifiers(
        input.modifiers,
        pizzaOptionSections(productConfiguration),
        toppingNames,
        operations.halfToppingUnitsBps,
      );
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
        // Only present when something was deliberately left off, so the kitchen
        // ticket can print it and a reader can tell "no omissions" from "field
        // not written by an older build".
        ...(recipeOmissions.length ? { recipeOmissions } : {}),
        modifiers: validatedModifiers.snapshot,
      };
    } else if (input.toppings?.length || input.extraCheese) {
      throw new OrderValidationError(`Unsupported customization was added to ${product.name}.`);
    } else {
      // H-05: deals are marked halal-capable but the generic customizer offered
      // no halal control, and the server rejected the flag outright — so the
      // advertised preference could not be ordered on the products that
      // advertise it. Accepted here, gated on the same `halal_capable` flag the
      // pizza branch uses, and carried into the snapshot the kitchen reads.
      if (input.halal && !product.halal_capable) {
        throw new OrderValidationError(`${product.name} is not configured for halal selection.`);
      }
      const validatedModifiers = validateModifiers(
        input.modifiers,
        orderModifierSections(productConfiguration.sections ?? [], Boolean(productConfiguration.toppingsFirst)),
        toppingNames,
        operations.halfToppingUnitsBps,
      );
      unitPriceCents += validatedModifiers.extraCents;
      snapshot = {
        ...snapshot,
        halal: Boolean(input.halal),
        modifiers: validatedModifiers.snapshot,
        modifierExtraCents: validatedModifiers.extraCents,
      };
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
      `SELECT id, name, code, type, amount, priority, combinable, exclusive, stack_group, rule_json,
              min_subtotal_cents, fulfilment, usage_limit, per_customer_limit, usage_count
       FROM promotions WHERE active = 1 AND (starts_at IS NULL OR starts_at <= ?)
       AND (ends_at IS NULL OR ends_at >= ?)
       -- An offer that has been redeemed its full number of times is spent. Read
       -- here as well as enforced at redemption so an exhausted code says so
       -- immediately rather than being accepted and then failing at checkout.
       AND (usage_limit IS NULL OR usage_count < usage_limit)
       ORDER BY priority DESC, id`,
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
    // The columns win over `rule_json` where both exist. The JSON blob predates
    // the columns and is still read so older promotions keep working, but what
    // the owner edits on screen is the column, and a stale JSON value silently
    // overriding it would make the admin form appear not to save.
    const columnFulfilment = row.fulfilment === "pickup" || row.fulfilment === "delivery"
      ? [row.fulfilment as Fulfilment]
      : undefined;
    rules.push({
      id: row.id as string,
      name: row.name as string,
      code: code || null,
      type: row.type as PromotionRule["type"],
      amount: row.amount as number,
      priority: row.priority as number,
      combinable: Boolean(row.combinable),
      exclusive: Boolean(row.exclusive),
      stackGroup: row.stack_group as string | null,
      fulfilments: columnFulfilment ?? (rule.fulfilments as Fulfilment[] | undefined) ?? [fulfilment],
      minimumCents: Number(row.min_subtotal_cents ?? 0) || (rule.minimumCents as number | undefined),
      productIds: rule.productIds as string[] | undefined,
      categoryIds: rule.categoryIds as string[] | undefined,
    });
  }
  if (couponCode && !couponMatched) {
    throw new OrderValidationError("That promo code isn't valid right now.", 400, "PROMO_CODE_INVALID");
  }
  return rules;
}

/**
 * The products a targeted promotion can be spent on, named the way the menu
 * names them.
 *
 * Read from the products table rather than kept beside the rule as a sentence,
 * because the two would drift the first time the owner renamed an item or
 * retargeted the offer — and the customer would then be told the code is good
 * for something the checkout refuses. A name that no longer resolves is dropped
 * rather than printed as an id.
 */
async function eligibleProductNames(promotion: PromotionRule): Promise<string[]> {
  const ids = promotion.productIds ?? [];
  if (!ids.length) return [];
  const rows = await getD1()
    .prepare(`SELECT id, name FROM products WHERE active = 1 AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids)
    .all<{ id: string; name: string }>();
  const names = new Map(rows.results.map((row) => [row.id, row.name]));
  // Ordered by the rule, not by the database, so the list reads the way the
  // offer was written.
  return ids.map((id) => names.get(id)).filter((name): name is string => Boolean(name));
}

/** "A, B or C" — an English list, because this ends up in a sentence. */
function listPhrase(items: string[], conjunction: "or" | "and" = "or"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/**
 * What to tell a customer whose code did not come off their total.
 *
 * The one thing this must never do is stay quiet. A checkout that says
 * "THANKS62 applied." beside an unchanged total has told the customer something
 * untrue, and they find out at the counter — which is where a C$3.99 thank-you
 * turns into an argument. So every way a coupon can fail to apply produces a
 * sentence naming the reason and, where there is one, the thing to do about it.
 *
 * The item wording is built from the promotion's own targeting (see
 * `eligibleProductNames`), so restricting an offer to different products changes
 * what the customer is told without anyone editing a string.
 */
async function describeCouponMiss(
  promotion: PromotionRule,
  lines: CartLinePrice[],
  fulfilment: Fulfilment,
  applied: AppliedPromotion[],
): Promise<string> {
  const code = promotion.code ?? "That code";
  const miss = explainPromotionMiss(lines, promotion, fulfilment, applied);
  if (miss?.reason === "fulfilment") {
    const only = miss.fulfilments.includes("delivery") ? "delivery" : "pickup";
    return `${code} is a ${only} offer, and this is a ${fulfilment} order.`;
  }
  if (miss?.reason === "minimum") {
    return `${code} needs an order of ${formatDeliveryMinimum(miss.minimumCents)} before tax. Add ${formatDeliveryMinimum(miss.shortfallCents)} more to use it.`;
  }
  if (miss?.reason === "items") {
    const names = await eligibleProductNames(promotion);
    return names.length
      ? `${code} can only be used on ${listPhrase(names)}. Add one to your order to use it.`
      : `${code} does not apply to anything in this order.`;
  }
  if (miss?.reason === "combination") {
    const other = listPhrase(applied.map((entry) => entry.name), "and");
    return `${code} cannot be combined with ${other || "another offer already on this order"}.`;
  }
  return `${code} did not apply to this order.`;
}

export class OrderValidationError extends Error {
  // Explicit fields rather than parameter properties: Node's strip-only type
  // loader cannot compile the latter, and it is what runs scripts/*.ts. The
  // payment reaper (R1.3) has to import this module to cancel stale orders.
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "ORDER_VALIDATION_FAILED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// --- quoting ----------------------------------------------------------------

export type QuoteIssue = {
  /** Index into the submitted cart, or null for a problem with the order itself. */
  index: number | null;
  productId: string | null;
  code: string;
  message: string;
};

export type OrderQuote = {
  /** False when something would stop this cart being ordered as submitted. */
  ok: boolean;
  fulfilment: Fulfilment;
  currency: string;
  lines: Array<{
    index: number;
    productId: string;
    name: string;
    variationName: string | null;
    quantity: number;
    unitPriceCents: number;
    lineTotalCents: number;
  }>;
  totals: {
    menuSubtotalCents: number;
    discountCents: number;
    discountedMenuSubtotalCents: number;
    taxableSubtotalCents: number;
    nonTaxableSubtotalCents: number;
    taxCents: number;
    deliveryFeeCents: number;
    tipCents: number;
    totalCents: number;
  };
  taxRateBps: number;
  deliveryFeeTaxable: boolean;
  appliedPromotions: Array<{ id: string; name: string; discountCents: number }>;
  coupon: { code: string; accepted: boolean; message: string | null } | null;
  delivery: {
    minimumCents: number;
    /** How much more food is needed to reach the minimum. Zero once it is met. */
    shortfallCents: number;
    feeCents: number;
    meetsMinimum: boolean;
  } | null;
  estimateMinutes: number;
  issues: QuoteIssue[];
};

/**
 * Prices a cart without creating anything.
 *
 * **The reason this exists as its own export.** The checkout page used to
 * compute its own subtotal, HST and total in the browser and label them
 * "estimated", because nothing on the server would tell it otherwise until the
 * order was submitted. Two implementations of tax arithmetic drift — and when
 * they do, the customer consents to one number and is charged another. This runs
 * the *same* pricing path `createOrder` runs, so the figure on the review screen
 * is the figure that will be charged, and there is no second implementation to
 * keep in step.
 *
 * **It reports rather than throws.** `createOrder` must refuse a bad cart
 * outright; a quote has to describe every problem at once so the cart can show
 * all of them (H-23) instead of surfacing them one refusal at a time. So
 * validation failures come back in `issues` with `ok: false`, and only genuinely
 * unusable input (no cart at all) throws.
 *
 * Read-only: no order, no payment, no idempotency key, nothing persisted.
 */
export async function quoteOrder(body: OrderRequest): Promise<OrderQuote> {
  await ensureDatabase();
  const fulfilment: Fulfilment = body.fulfilment === "delivery" ? "delivery" : "pickup";
  const [ordering, delivery, taxTips, operations] = await Promise.all([
    getSetting<OrderingSetting>("ordering"),
    getSetting<DeliverySetting>("delivery"),
    getSetting<TaxTipSetting>("taxAndTips"),
    getSetting<OperationSetting>("operations"),
  ]);

  const issues: QuoteIssue[] = [];
  const submitted = body.items ?? [];
  if (!submitted.length) throw new OrderValidationError("Your cart is empty.");
  if (submitted.length > 50) throw new OrderValidationError("Your cart is too large.");

  // The happy path is one call. Only when it refuses do we pay for per-line
  // validation to find out *which* lines are the problem — that is the rare
  // case, and it keeps `validateItems` (the most safety-critical function here)
  // completely unchanged rather than reworked to collect errors.
  let items: ValidatedItem[] = [];
  try {
    items = await validateItems(submitted, fulfilment, operations);
  } catch {
    for (const [index, line] of submitted.entries()) {
      try {
        const [validated] = await validateItems([line], fulfilment, operations);
        items.push(validated);
      } catch (error) {
        issues.push({
          index,
          productId: line.productId ?? null,
          code: error instanceof OrderValidationError ? error.code : "ITEM_UNAVAILABLE",
          message: error instanceof Error ? error.message : "This item cannot be ordered.",
        });
      }
    }
  }

  const couponCode = normalizeCouponCode(body.couponCode);
  let promotions: PromotionRule[] = [];
  let coupon: OrderQuote["coupon"] = null;
  try {
    promotions = await activePromotions(fulfilment, couponCode);
    if (couponCode) coupon = { code: couponCode, accepted: true, message: null };
  } catch (error) {
    // A bad code must not stop the rest of the cart being priced — the customer
    // needs to see their total *and* that the code did not apply.
    promotions = await activePromotions(fulfilment, null);
    coupon = {
      code: couponCode ?? "",
      accepted: false,
      message: error instanceof Error ? error.message : "That promo code isn't valid right now.",
    };
  }
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

  const cartLines: CartLinePrice[] = items.map((item) => ({
    id: item.id,
    productId: item.productId,
    categoryId: item.categoryId,
    quantity: item.quantity,
    unitPriceCents: item.unitPriceCents,
    taxable: item.taxable,
    promotionEligible: item.promotionEligible,
  }));

  let price;
  try {
    price = priceCart({
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
  } catch (error) {
    // Almost always the tip: a custom amount above the configured ceiling. Report
    // it and price the cart without one rather than returning no total at all.
    issues.push({
      index: null,
      productId: null,
      code: "TIP_INVALID",
      message: error instanceof Error ? error.message : "That tip could not be applied.",
    });
    price = priceCart({
      lines: cartLines,
      promotions,
      fulfilment,
      deliveryFeeCents: delivery.feeCents,
      taxRateBps: taxTips.taxRateBps,
      deliveryFeeTaxable: delivery.feeTaxable,
      tip: { type: "none" },
    });
  }

  // A code that matched a live promotion but came off nothing.
  //
  // `activePromotions` answers "is this a real code", which is not the question
  // the customer is asking — they are asking whether it took anything off. A
  // targeted offer (THANKS62 is only good on garlic bread or a drink) matches
  // the cart at neither step and is dropped in silence by `applyPromotions`, so
  // without this the review screen reads "THANKS62 applied." above an unchanged
  // total. The order is still placeable: the coupon is reported as not applied,
  // the discount is genuinely zero, and nobody is stopped from buying dinner
  // over a C$3.99 thank-you they can use next time.
  const acceptedCoupon = coupon?.accepted ? coupon : null;
  if (acceptedCoupon) {
    const couponRule = promotions.find((rule) => rule.code === acceptedCoupon.code);
    const missed = couponRule && !price.appliedPromotions.some((entry) => entry.id === couponRule.id);
    if (missed) {
      coupon = {
        code: acceptedCoupon.code,
        accepted: false,
        message: await describeCouponMiss(couponRule, cartLines, fulfilment, price.appliedPromotions),
      };
    }
  }

  // The delivery minimum is checked against the pre-tax menu subtotal, so a
  // customer cannot reach it with the fee or a tip. Reported as a shortfall
  // rather than a refusal: "add $4.01 more" is actionable, "not eligible" is not.
  let deliveryQuote: OrderQuote["delivery"] = null;
  if (fulfilment === "delivery") {
    const shortfall = Math.max(0, (delivery.minimumCents ?? 0) - price.menuSubtotalCents);
    deliveryQuote = {
      minimumCents: delivery.minimumCents ?? 0,
      shortfallCents: shortfall,
      feeCents: price.deliveryFeeCents,
      meetsMinimum: shortfall === 0,
    };
    if (shortfall > 0) {
      issues.push({
        index: null,
        productId: null,
        code: "DELIVERY_BELOW_MINIMUM",
        message: `Delivery orders must be at least ${formatDeliveryMinimum(delivery.minimumCents)} before tax. Add ${formatDeliveryMinimum(shortfall)} more to your order.`,
      });
    }
  }

  if (!ordering.enabled || ordering.paused) {
    issues.push({ index: null, productId: null, code: "ORDERING_PAUSED", message: ordering.pauseMessage });
  }
  if (
    (fulfilment === "pickup" && !ordering.pickupEnabled) ||
    (fulfilment === "delivery" && !ordering.deliveryEnabled)
  ) {
    issues.push({
      index: null,
      productId: null,
      code: "FULFILMENT_UNAVAILABLE",
      message: `${fulfilment === "delivery" ? "Delivery" : "Pickup"} ordering is currently unavailable.`,
    });
  }

  // The payment method, checked against the same rules `createOrder` applies.
  //
  // These were missed on the first pass and the quote said `ok: true` for a
  // delivery order paying at the store, which the API refuses outright. Same
  // class of bug as the schedule check: `ok` has to mean "this will be
  // accepted", and every rule `createOrder` enforces has to be mirrored here or
  // the review screen enables a button that cannot work.
  //
  // Only checked when a payment method was actually named — the cart is quoted
  // long before the customer has chosen one.
  if (body.paymentMethod === "pay_at_store" && (fulfilment !== "pickup" || !ordering.payAtStorePickupEnabled)) {
    issues.push({
      index: null,
      productId: null,
      code: "PAYMENT_METHOD_UNAVAILABLE",
      message: "Pay at store is available for pickup orders only.",
    });
  }
  if (body.paymentMethod === "online" && !(await cloverCheckoutConfigured())) {
    issues.push({
      index: null,
      productId: null,
      code: "PAYMENT_SETUP_REQUIRED",
      message: "Online payment is ready for the restaurant's Clover credentials. No payment was taken.",
    });
  }

  const estimateMinutes =
    fulfilment === "delivery" ? ordering.deliveryEstimateMinutes ?? 30 : ordering.pickupEstimateMinutes;

  // `ok` has to mean "this will be accepted", not "the arithmetic worked". A
  // quote that says yes to a time the store is shut leaves the review screen
  // enabling a button guaranteed to fail — the same class of problem as quoting
  // the wrong total, just further down the funnel.
  //
  // Checked unconditionally, and defaulting to ASAP exactly as `createOrder`
  // does when no schedule is supplied. An earlier version only checked when a
  // schedule was present, which meant a quote with none omitted the check that
  // `createOrder` would then apply anyway — and at 4am, with the store shut, the
  // quote said yes to an order the API refused.
  // The time this order is *for*. For a scheduled order that is the chosen slot;
  // for ASAP it is now plus the current lead time.
  const wantedAt =
    body.schedule?.type === "scheduled" && Number.isSafeInteger(body.schedule.scheduledFor)
      ? Number(body.schedule.scheduledFor)
      : Date.now() + estimateMinutes * 60_000;

  // H-08, checked first and independently of the schedule.
  //
  // Order matters here. Both checks can fail at once — during a holiday the
  // store is also outside its weekly hours — and "we are closed for Christmas"
  // is a far more useful thing to be told than "that time is outside the
  // restaurant's configured hours". Running the closure check inside the same
  // try as `validateSchedule` meant the schedule error was thrown first and the
  // closure was never looked at, so the customer got the unhelpful message.
  const closure = closureFor(wantedAt, await loadActiveClosures(), fulfilment);
  if (closure) {
    issues.push({ index: null, productId: null, code: "STORE_CLOSED", message: closureMessage(closure) });
  }

  try {
    const hours = await getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours");
    validateSchedule(body.schedule ?? { type: "asap" }, estimateMinutes, hours);
  } catch (error) {
    // Suppressed when a closure already explained it: two refusals for one cause
    // reads as two separate problems to fix.
    if (!closure) {
      issues.push({
        index: null,
        productId: null,
        code: error instanceof OrderValidationError ? error.code : "SCHEDULE_INVALID",
        message: error instanceof Error ? error.message : "That order time cannot be accepted.",
      });
    }
  }

  return {
    ok: issues.length === 0,
    fulfilment,
    currency: "CAD",
    lines: items.map((item, index) => ({
      index,
      productId: item.productId,
      name: item.productName,
      variationName: item.variationName,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: item.unitPriceCents * item.quantity,
    })),
    totals: {
      menuSubtotalCents: price.menuSubtotalCents,
      discountCents: price.discountCents,
      discountedMenuSubtotalCents: price.discountedMenuSubtotalCents,
      taxableSubtotalCents: price.taxableSubtotalCents,
      nonTaxableSubtotalCents: price.nonTaxableSubtotalCents,
      taxCents: price.taxCents,
      deliveryFeeCents: price.deliveryFeeCents,
      tipCents: price.tipCents,
      totalCents: price.totalCents,
    },
    taxRateBps: taxTips.taxRateBps,
    deliveryFeeTaxable: Boolean(delivery.feeTaxable),
    appliedPromotions: price.appliedPromotions.map((entry) => ({
      id: entry.id,
      name: entry.name,
      discountCents: entry.discountCents,
    })),
    coupon,
    delivery: deliveryQuote,
    estimateMinutes,
    issues,
  };
}

// `origin` used to be a parameter here: Stripe's success_url was built per
// session and needed the caller's host. Clover's return URL is configured once
// in its merchant dashboard and is the same for every order, so there is nothing
// left for a request origin to influence — the browser stashes the tracking
// credentials before redirecting instead (see /order/return).
/**
 * Options only a trusted caller may set.
 *
 * Deliberately a second argument rather than fields on `OrderRequest`: the
 * public route hands the parsed request body straight to `createOrder`, so
 * anything reachable from `body` is settable by whoever is on the internet.
 * `channel: "walk_in"` from a stranger would make the owner's in-store figures a
 * fiction, and `staffEntry` would let them skip having to give an email address.
 */
export type CreateOrderContext = {
  /** Where the order was taken. Defaults to the customer web app. */
  channel?: "online" | "phone" | "walk_in";
  /**
   * True when a member of staff is keying this in at the counter or on the
   * phone. Relaxes the contact requirements — a walk-in customer has not given
   * an email address and should not be invented one — and records who took it.
   */
  staffEntry?: boolean;
  staffUserId?: string;
};

export async function createOrder(body: OrderRequest, context: CreateOrderContext = {}) {
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
    const customer = normalizeCustomer(body.customer, context.staffEntry);
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
    // Trimmed to a bounded string: it is forwarded to Clover, so an oversized or
    // whitespace-only value should be rejected here rather than becoming a
    // confusing failure at the charge call.
    const paymentToken = typeof body.paymentToken === "string" ? body.paymentToken.trim() : "";
    if (paymentToken.length > 500) {
      throw new OrderValidationError("That payment could not be read.", 400, "INVALID_PAYMENT_TOKEN");
    }
    if (paymentMethod !== "pay_at_store" && paymentMethod !== "online") {
      throw new OrderValidationError("Choose an available payment method.");
    }
    // Paying on collection is a *public website* setting, and the website only
    // offers it on pickup: a stranger promising to pay a driver at a door is a
    // risk the restaurant did not agree to take.
    //
    // A member of staff keying in a phone delivery is not that. They have the
    // customer on the line, they decide whether to take the card number now or
    // send the machine out with the driver, and refusing them here is what kept
    // phone deliveries on paper and out of the books entirely. The relaxation is
    // gated on `staffEntry`, which is a trusted context argument set after
    // authentication and unreachable from a request body — see CreateOrderContext.
    if (paymentMethod === "pay_at_store" && !context.staffEntry && (fulfilment !== "pickup" || !ordering.payAtStorePickupEnabled)) {
      throw new OrderValidationError("Pay at store is available for pickup orders only.");
    }
    if (paymentMethod === "online" && !(await cloverCheckoutConfigured())) {
      throw new OrderValidationError(
        "Online payment is ready for the restaurant's Clover credentials. No payment was taken.",
        503,
        "PAYMENT_SETUP_REQUIRED",
      );
    }
    const deliveryAddress = fulfilment === "delivery" ? normalizeDeliveryAddress(body.address) : null;
    // A driver with no number to call is a delivery that fails at the door. The
    // website asks every customer for a phone number, but staff entry does not
    // (see normalizeCustomer on why demanding one at a counter produces junk), so
    // the requirement is reinstated for the one case that cannot do without it.
    if (fulfilment === "delivery" && !customer.phone) {
      throw new OrderValidationError("A delivery needs a phone number the driver can call.");
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
      // H-06b: geocodes the full street address through Azure Maps, falling back
      // to the coarse FSA centroid only if Maps cannot answer.
      const point = await resolveDeliveryPoint({
        line1: deliveryAddress.line1,
        unit: deliveryAddress.unit,
        city: deliveryAddress.city,
        province: deliveryAddress.province,
        postalCode: deliveryAddress.postalCode,
      });
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
    // H-08, before the schedule check rather than after it. During a holiday both
    // fail, and "we are closed for Christmas" is far more useful than "that time
    // is outside the restaurant's configured hours". Judged against the time the
    // order is *for*, so a Christmas Day pickup ordered on the Monday is caught
    // on the Monday.
    const wantedAt =
      body.schedule?.type === "scheduled" && Number.isSafeInteger(body.schedule.scheduledFor)
        ? Number(body.schedule.scheduledFor)
        : Date.now() + estimateMinutes * 60_000;
    const closure = closureFor(wantedAt, await loadActiveClosures(), fulfilment);
    if (closure) {
      throw new OrderValidationError(closureMessage(closure), 409, "STORE_CLOSED");
    }
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
    // Only a trusted caller can say this is anything but a website order — see
    // CreateOrderContext on why it is not reachable from the request body.
    const channel = context.channel ?? "online";
    const orderStatus = paymentMethod === "online" ? "awaiting_payment" : "received";
    const paymentStatus = paymentMethod === "online" ? "awaiting_checkout" : "pending_at_store";
    const paymentProvider = paymentMethod === "online" ? "clover" : "store";
    // An online order's notifications are parked until Clover confirms payment:
    // confirming an order nobody paid for, and calling the kitchen about it, are
    // both worse than saying nothing. The webhook releases them.
    //
    // `pending_provider_setup` is the no-credentials state. It exists so that a
    // deployment without a provider does not burn every row's retry budget and
    // bury real notifications in `failed` — the dispatcher leaves these alone
    // until something can actually deliver.
    const outboxStatus = paymentMethod === "online"
      ? "waiting_payment"
      : (await anyProviderConfigured())
        ? "pending"
        : "pending_provider_setup";
    const operationsBatch: D1PreparedStatement[] = [
      getD1()
        .prepare(
          `INSERT INTO orders
           (id, order_number, tracking_token_hash, feedback_token_hash, customer_name, customer_phone,
            customer_email, fulfilment, channel, status, payment_status, payment_method, schedule_type,
            scheduled_for, estimated_for, address_json, instructions, pricing_json, subtotal_cents,
            discount_cents, tax_cents, delivery_fee_cents, tip_cents, total_cents, acknowledged_at,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          channel,
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
          // The employee who entered a walk-in is already standing in front of
          // that order. Treating it as unseen creates a false acknowledgement
          // alarm for an order the restaurant itself just accepted.
          channel === "walk_in" ? now : null,
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
            ? "Order validated; waiting for Clover payment"
            : "Order accepted after server validation",
          now,
        ),
      // H-09: the post-order feedback request. Queued here rather than when the
      // order completes, for the same reason the tracking token is — the
      // feedback token cannot be recovered later, `orders` keeps only its hash,
      // and the link in the customer's confirmation has to keep working, so
      // minting a fresh one at completion is not an option.
      //
      // It sits in `waiting_completion` until staff actually complete the order,
      // at which point it is released with the configured delay. An order that
      // never completes leaves an inert row that no dispatcher will ever claim.
      getD1()
        .prepare(
          "UPDATE idempotency_keys SET resource_id = ?, status = 'completed' WHERE key_hash = ?",
        )
        .bind(orderId, keyHash),
    ];
    // A customer order needs to get the restaurant's attention. A walk-in order
    // was entered by the restaurant itself and is printed from that same tap, so
    // ringing the kitchen phone to tell staff about their own action is both
    // redundant and disruptive. Phone orders retain the alert: only the trusted
    // walk_in channel is exempt, and the public route cannot set that channel.
    if (channel !== "walk_in") {
      operationsBatch.push(
        getD1()
          .prepare(
            `INSERT INTO notification_outbox
             (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
             VALUES (?, 'restaurant_new_order', NULL, ?, ?, 0, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            JSON.stringify({ orderId, orderNumber }),
            outboxStatus,
            now,
            now,
            now,
          ),
      );
    }
    // A usage limit is only meaningful if redemptions are counted. Incremented
    // in the same batch that creates the order, so a promotion cannot be
    // recorded as used by an order that then fails to commit.
    //
    // The guard is on the UPDATE rather than only in the earlier SELECT, so two
    // orders racing for the last redemption cannot both take it. The counter can
    // still be read as available and then found spent between the two — an
    // over-issue is bounded by concurrency and is the right way round to fail:
    // honouring one offer too many costs the discount, refusing a customer who
    // was told it applied costs the customer.
    //
    // `included-free-delivery` is synthesised from a product flag rather than
    // stored, so it has no row to count.
    for (const promotion of price.appliedPromotions) {
      if (promotion.id === "included-free-delivery") continue;
      operationsBatch.push(
        getD1()
          .prepare(
            `UPDATE promotions SET usage_count = usage_count + 1, updated_at = ?
             WHERE id = ? AND (usage_limit IS NULL OR usage_count < usage_limit)`,
          )
          .bind(now, promotion.id),
      );
    }

    // Both of these are addressed to the customer, so neither is queued when
    // there is no address to send them to. A walk-in ordering two slices has not
    // given an email, and queuing a message to nowhere produces one permanently
    // failed row per counter order — noise in the exact place someone has to look
    // to find a real delivery failure.
    if (customer.email) {
      operationsBatch.push(
        getD1()
          .prepare(
            `INSERT INTO notification_outbox
             (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
             VALUES (?, 'customer_order_confirmation', ?, ?, ?, 0, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            customer.email,
            // The tracking token is handed over here because it cannot be
            // recovered later: `orders` keeps only its hash. The dispatcher
            // scrubs it from the payload once the message is sent — see
            // lib/notifications/messages.ts for the trade this makes.
            JSON.stringify({ orderId, orderNumber, trackingToken }),
            outboxStatus,
            now,
            now,
            now,
          ),
        // H-09: the post-order feedback request. Queued here rather than when
        // the order completes, for the same reason the tracking token is — the
        // feedback token cannot be recovered later, `orders` keeps only its
        // hash, and the link in the customer's confirmation has to keep working,
        // so minting a fresh one at completion is not an option.
        //
        // It sits in `waiting_completion` until staff actually complete the
        // order, at which point it is released with the configured delay. An
        // order that never completes leaves an inert row nothing will claim.
        getD1()
          .prepare(
            `INSERT INTO notification_outbox
             (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
             VALUES (?, 'feedback_request', ?, ?, 'waiting_completion', 0, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            customer.email,
            JSON.stringify({ orderId, orderNumber, feedbackToken }),
            now,
            now,
            now,
          ),
      );
    }

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
    if (paymentMethod === "online" && paymentToken && (await cloverIframeEnabled())) {
      // The inline path. Unlike the hosted one, the outcome is known inside this
      // request: the order is paid before the customer is answered, so there is
      // no `awaiting_payment` window for the reaper to cancel through and no
      // dependence on a webhook arriving for anyone to be told what happened.
      try {
        const charge = await createCloverCharge({
          amountCents: price.totalCents,
          sourceToken: paymentToken,
          // The browser's durable checkout key, not a fresh one. It survives a
          // refresh, a double tap and a retry after an ambiguous failure, so a
          // second attempt presents the same key to Clover and resolves to the
          // original charge instead of taking the money twice. That is the whole
          // reason this is threaded through rather than generated here.
          idempotencyKey: idempotencyKey,
          orderNumber,
          customerEmail: customer.email,
        });
        await applyPaymentApproved({
          orderId,
          note: `Clover charge approved (${charge.chargeId})`,
          providerReference: charge.chargeId,
        });
        return {
          duplicate: false,
          orderId,
          orderNumber,
          trackingToken,
          feedbackToken,
          status: "received",
          paymentStatus: "paid",
          estimateAt: schedule.estimatedFor,
          price,
        };
      } catch (error) {
        const declined = error instanceof CloverDeclinedError;
        await getD1().batch([
          getD1()
            .prepare(
              "UPDATE payments SET status = ?, failure_reason = ?, updated_at = ? WHERE order_id = ? AND provider = 'clover'",
            )
            .bind(
              declined ? "declined" : "failed",
              error instanceof Error ? error.message.slice(0, 500) : "Clover charge failed",
              Date.now(),
              orderId,
            ),
          getD1()
            .prepare("UPDATE orders SET status = 'cancelled', payment_status = 'failed', updated_at = ? WHERE id = ?")
            .bind(Date.now(), orderId),
          getD1()
            .prepare(
              `INSERT INTO order_events
               (id, order_id, previous_status, next_status, actor_type, actor_id, note, created_at)
               VALUES (?, ?, 'awaiting_payment', 'cancelled', 'clover', NULL, ?, ?)`,
            )
            .bind(
              crypto.randomUUID(),
              orderId,
              declined ? "Clover declined the card" : "Clover charge failed",
              Date.now(),
            ),
          // Nobody paid, so the confirmation and the kitchen alert parked on this
          // order must never be sent.
          getD1()
            .prepare(
              `UPDATE notification_outbox SET status = 'cancelled', updated_at = ?
               WHERE status IN ('waiting_payment', 'waiting_completion')
                 AND payload_json::jsonb->>'orderId' = ?`,
            )
            .bind(Date.now(), orderId),
          // Releases the key so the customer's next attempt is a fresh order
          // rather than resolving to this cancelled one. Safe against
          // double-charging because the *Clover* key is the browser's, which does
          // not change across the retry — see the note on it above.
          getD1().prepare("DELETE FROM idempotency_keys WHERE key_hash = ?").bind(keyHash),
        ]);
        throw new OrderValidationError(
          declined
            ? "That card was declined. No payment was taken — try another card, or pay at the store."
            : "The payment could not be completed. No payment was taken; please try again.",
          declined ? 402 : 502,
          declined ? "PAYMENT_DECLINED" : "PAYMENT_PROVIDER_ERROR",
        );
      }
    }

    if (paymentMethod === "online") {
      try {
        const checkout = await createCloverCheckout({
          orderNumber,
          customerName: customer.name,
          customerEmail: customer.email,
          customerPhone: customer.phone,
          totalCents: price.totalCents,
          summary: items
            .map((item) => `${item.quantity}x ${item.productName}`)
            .join(", "),
        });
        // Clover has no metadata passthrough, so this row is the *only* link from
        // the checkout session back to the order. It is written before the URL is
        // handed to the customer: if the write fails, the catch below cancels the
        // order rather than leaving a payable session no webhook could ever
        // reconcile.
        await getD1()
          .prepare("UPDATE payments SET provider_reference = ?, updated_at = ? WHERE order_id = ? AND provider = 'clover'")
          .bind(checkout.checkoutSessionId, Date.now(), orderId)
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
          checkoutUrl: checkout.href,
        };
      } catch (error) {
        await getD1().batch([
          getD1()
            .prepare("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE order_id = ?")
            .bind(error instanceof Error ? error.message.slice(0, 500) : "Clover checkout failed", Date.now(), orderId),
          getD1()
            .prepare("UPDATE orders SET status = 'cancelled', payment_status = 'failed', updated_at = ? WHERE id = ?")
            .bind(Date.now(), orderId),
          // H-17: releasing the idempotency key lets the customer retry the same
          // checkout attempt and get a fresh order instead of resolving to this
          // cancelled one. The failed order/payment rows remain for reconciliation.
          //
          // H-17b: that retry only works because payments_idempotency_uq is a
          // partial index excluding status = 'failed' (drizzle/0001). The row
          // left behind above still holds this key; under an unconditional
          // unique index it would collide with the retry's insert and the
          // customer would be locked out of their own order forever. The
          // status = 'failed' update is therefore load-bearing, not just
          // bookkeeping — it is what releases the key.
          getD1()
            .prepare("DELETE FROM idempotency_keys WHERE key_hash = ?")
            .bind(keyHash),
        ]);
        throw new OrderValidationError(
          "Clover checkout could not start. No payment was taken; please try again.",
          502,
          "PAYMENT_PROVIDER_ERROR",
        );
      }
    }
    // A pay-at-store order is real the instant it commits, so it is dispatched
    // now rather than waiting up to a minute for the cron floor. Deliberately not
    // awaited: the outbox row is already durable, so a crash here loses nothing
    // and the sweeper will pick it up. An online order is dispatched by the
    // webhook instead, once payment is confirmed.
    dispatchSoon();
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
