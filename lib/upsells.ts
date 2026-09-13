import { isWithinWeeklyAvailability, type WeeklyAvailability } from "@/lib/domain";

/**
 * The small merchandising vocabulary used to complete an order.
 *
 * Product/category inference keeps the current live catalogue useful without a
 * data migration. Owners can override it through `configuration.merchandising`
 * as the menu evolves; those hints never participate in pricing.
 */
export const UPSELL_ROLES = ["meal", "pizza", "wings", "side", "drink", "dip", "dessert"] as const;
export type UpsellRole = typeof UPSELL_ROLES[number];

export type UpsellProduct = {
  id: string;
  category_id: string;
  name: string;
  description?: string | null;
  product_type: "pizza" | "simple" | "bundle" | "configurable";
  image_url?: string | null;
  base_price_cents: number;
  pickup_eligible: number;
  delivery_eligible: number;
  sold_out: number;
  setup_required: number;
  configuration: Record<string, unknown>;
};

export type UpsellCartLine = {
  productId: string;
  name: string;
  categoryId: string;
  variationName?: string;
  quantity: number;
  modifiers?: Array<{
    id: string;
    label: string;
    values: Array<{ value: string; label: string }>;
  }>;
};

export type UpsellRecommendation<TProduct extends UpsellProduct = UpsellProduct> = {
  product: TProduct;
  ruleId: string;
  reason: string;
  sourceProductIds: string[];
};

type Merchandising = {
  roles?: UpsellRole[];
  includes?: UpsellRole[];
  serves?: number;
  preferredUpsellIds?: string[];
  upsellCandidate?: boolean;
  upsellPriority?: number;
};

const roleSet = (value: unknown): Set<UpsellRole> => new Set(
  Array.isArray(value)
    ? value.map(String).filter((role): role is UpsellRole => UPSELL_ROLES.includes(role as UpsellRole))
    : [],
);

function merchandising(product: UpsellProduct): Merchandising {
  const value = product.configuration.merchandising;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const serves = Number(input.serves);
  const priority = Number(input.upsellPriority);
  return {
    roles: [...roleSet(input.roles)],
    includes: [...roleSet(input.includes)],
    serves: Number.isFinite(serves) && serves > 0 ? Math.min(50, serves) : undefined,
    preferredUpsellIds: Array.isArray(input.preferredUpsellIds)
      ? input.preferredUpsellIds.map(String).filter(Boolean).slice(0, 20)
      : undefined,
    upsellCandidate: input.upsellCandidate === false ? false : undefined,
    upsellPriority: Number.isFinite(priority) ? Math.max(-100, Math.min(100, priority)) : undefined,
  };
}

const hasWords = (value: string, pattern: RegExp) => pattern.test(value.toLowerCase());

/** Classifies a product, with explicit owner metadata winning over inference. */
export function productUpsellRoles(product: UpsellProduct): Set<UpsellRole> {
  const explicit = merchandising(product).roles ?? [];
  if (explicit.length) return new Set(explicit);

  const roles = new Set<UpsellRole>();
  const text = `${product.id} ${product.name} ${product.description ?? ""}`.toLowerCase();
  const sections = Array.isArray(product.configuration.sections)
    ? product.configuration.sections as Array<Record<string, unknown>>
    : [];

  if (product.category_id === "drinks") roles.add("drink");
  if (product.category_id === "desserts") roles.add("dessert");
  if (product.id === "standard-dip" || hasWords(text, /\b(dip|dipping sauce)\b/)) roles.add("dip");

  const pizza = product.product_type === "pizza" ||
    ["build-your-own", "specialty-pizzas", "two-for-one"].includes(product.category_id) ||
    hasWords(text, /\b(pizza|slice)\b/) ||
    sections.some((section) => section.source === "toppings" && String(section.group ?? "").toLowerCase().includes("pizza"));
  const wings = product.category_id === "wings" || hasWords(text, /\bwings?\b/) ||
    sections.some((section) => section.source === "wing_flavours");

  if (pizza) roles.add("pizza");
  if (wings) roles.add("wings");

  if (product.category_id === "sides" && !roles.has("dip")) {
    if (hasWords(text, /\b(sub|panzerotti)\b/)) roles.add("meal");
    else roles.add("side");
  }
  if (pizza || wings || product.product_type === "bundle" || hasWords(text, /\bcombo\b/)) roles.add("meal");
  return roles;
}

/**
 * Roles already supplied inside a bundle. Descriptions are read only for
 * bundle-like products because several legacy deals advertise an included dip
 * or pop without representing it as a required modifier section.
 */
export function includedUpsellRoles(product: UpsellProduct): Set<UpsellRole> {
  const included = roleSet(merchandising(product).includes);
  const sections = Array.isArray(product.configuration.sections)
    ? product.configuration.sections as Array<Record<string, unknown>>
    : [];
  for (const section of sections) {
    if (Number(section.min ?? 0) < 1) continue;
    const text = `${String(section.id ?? "")} ${String(section.label ?? "")} ${String(section.source ?? "")}`.toLowerCase();
    if (hasWords(text, /\b(drink|drinks|pop)\b/)) included.add("drink");
    if (hasWords(text, /\b(dip|dipping)\b/)) included.add("dip");
    if (hasWords(text, /\b(garlic bread|fries|wedges|veggie sticks)\b/)) included.add("side");
    if (hasWords(text, /\b(brownie|dessert)\b/)) included.add("dessert");
  }

  const bundleLike = product.product_type === "bundle" || product.name.toLowerCase().includes("combo");
  if (bundleLike) {
    const description = (product.description ?? "").toLowerCase();
    if (hasWords(description, /\b(pops?|drinks?|2\s*l)\b/)) included.add("drink");
    if (hasWords(description, /\b(dip|dipping sauce|blue cheese)\b/)) included.add("dip");
    if (hasWords(description, /\b(garlic bread|fries|wedges|veggie sticks)\b/)) included.add("side");
    if (hasWords(description, /\b(brownie|dessert)\b/)) included.add("dessert");
  }
  return included;
}

function selectedModifierRoles(line: UpsellCartLine): Set<UpsellRole> {
  const roles = new Set<UpsellRole>();
  for (const modifier of line.modifiers ?? []) {
    if (!modifier.values.length) continue;
    const text = `${modifier.id} ${modifier.label} ${modifier.values.map((value) => `${value.value} ${value.label}`).join(" ")}`.toLowerCase();
    if (hasWords(text, /\b(drink|pop)\b/)) roles.add("drink");
    if (hasWords(text, /\b(dip|dipping)\b/)) roles.add("dip");
    if (hasWords(text, /\b(garlic bread|fries|wedges|veggie sticks)\b/)) roles.add("side");
    if (hasWords(text, /\b(brownie|dessert)\b/)) roles.add("dessert");
  }
  return roles;
}

function estimatedServings(product: UpsellProduct, line: UpsellCartLine): number {
  const explicit = merchandising(product).serves;
  if (explicit) return explicit * line.quantity;
  // A selected variation is more specific than a catalogue name (for example,
  // a product called "Large Pizza" can still expose a Medium variation).
  const text = (line.variationName || line.name).toLowerCase();
  const count = Number(text.match(/\b(\d{2})\s+wings?\b/)?.[1] ?? 0);
  if (count >= 24) return Math.max(3, Math.ceil(count / 8)) * line.quantity;
  if (hasWords(text, /\b(2\s+.*pizzas|two\s+.*pizzas|slab|jumbo|x-large)\b/)) return 4 * line.quantity;
  if (hasWords(text, /\blarge\b/)) return 3 * line.quantity;
  if (hasWords(text, /\bmedium\b|\b1\s*lb\b/)) return 2 * line.quantity;
  return line.quantity;
}

function availableFor(product: UpsellProduct, fulfilment: "pickup" | "delivery", now: Date): boolean {
  if (product.sold_out || product.setup_required) return false;
  if (merchandising(product).upsellCandidate === false) return false;
  if (fulfilment === "pickup" ? !product.pickup_eligible : !product.delivery_eligible) return false;
  return isWithinWeeklyAvailability(product.configuration.availability as WeeklyAvailability | undefined, now);
}

/**
 * Selects a short, diverse list of useful add-ons for the whole cart.
 *
 * No price is calculated here. A selected product enters the ordinary cart and
 * is quoted by the server exactly like an item chosen from the menu.
 */
export function recommendUpsells<TProduct extends UpsellProduct>(input: {
  cart: UpsellCartLine[];
  products: TProduct[];
  fulfilment: "pickup" | "delivery";
  now?: Date;
  maximum?: number;
}): UpsellRecommendation<TProduct>[] {
  const { cart, products, fulfilment } = input;
  const maximum = Math.max(0, Math.min(6, input.maximum ?? 3));
  if (!cart.length || maximum === 0) return [];

  const now = input.now ?? new Date();
  const productsById = new Map(products.map((product) => [product.id, product]));
  const cartProductIds = new Set(cart.map((line) => line.productId));
  const sourceProducts = cart.map((line) => productsById.get(line.productId)).filter((product): product is TProduct => Boolean(product));
  const cartRoles = new Set<UpsellRole>();
  const satisfiedRoles = new Set<UpsellRole>();
  let servings = 0;
  for (const line of cart) {
    const product = productsById.get(line.productId);
    if (!product) continue;
    const roles = productUpsellRoles(product);
    roles.forEach((role) => { cartRoles.add(role); satisfiedRoles.add(role); });
    includedUpsellRoles(product).forEach((role) => satisfiedRoles.add(role));
    selectedModifierRoles(line).forEach((role) => satisfiedRoles.add(role));
    // Sides do not make the party larger. Counting a dip and garlic bread as
    // two more diners made a one-person meal receive the four-pop suggestion.
    if (roles.has("meal")) servings += estimatedServings(product, line);
  }

  // Drinks and desserts alone have no honest low-friction complement. Reaching
  // for a whole meal here would be a sales interruption rather than assistance.
  const hasFoodSignal = ["meal", "pizza", "wings", "side"].some((role) => cartRoles.has(role as UpsellRole));
  if (!hasFoodSignal) return [];

  const sourceProductIds = [...new Set(cart.map((line) => line.productId))];
  const recommendations: UpsellRecommendation<TProduct>[] = [];
  const chosenIds = new Set<string>();
  const add = (ruleId: string, ids: string[], role: UpsellRole, reason: string, ignoreSatisfied = false) => {
    if (recommendations.length >= maximum || (!ignoreSatisfied && satisfiedRoles.has(role))) return;
    const candidates = ids
      .map((id) => productsById.get(id))
      .filter((product): product is TProduct => Boolean(product))
      .filter((product) => !cartProductIds.has(product.id) && !chosenIds.has(product.id) && availableFor(product, fulfilment, now));
    const fallback = products
      .filter((product) => productUpsellRoles(product).has(role))
      .filter((product) => !cartProductIds.has(product.id) && !chosenIds.has(product.id) && availableFor(product, fulfilment, now))
      .sort((left, right) =>
        (merchandising(right).upsellPriority ?? 0) - (merchandising(left).upsellPriority ?? 0) ||
        left.base_price_cents - right.base_price_cents,
      );
    const product = candidates[0] ?? fallback[0];
    if (!product) return;
    recommendations.push({ product, ruleId, reason, sourceProductIds });
    chosenIds.add(product.id);
    satisfiedRoles.add(role);
  };

  // Owner-picked relationships lead, but they still pass every live catalogue
  // and fulfilment guard. They are deliberately capped with the rest of the tray.
  for (const product of sourceProducts) {
    for (const id of merchandising(product).preferredUpsellIds ?? []) {
      const target = productsById.get(id);
      if (!target || cartProductIds.has(id) || chosenIds.has(id) || !availableFor(target, fulfilment, now)) continue;
      const targetRole = [...productUpsellRoles(target)].find((role) => !satisfiedRoles.has(role));
      if (!targetRole) continue;
      add(`preferred:${product.id}`, [id], targetRole, `Picked to go with ${product.name}`, true);
    }
  }

  const largeOrder = servings >= 3 || cart.some((line) => line.quantity > 1 && productsById.get(line.productId) && productUpsellRoles(productsById.get(line.productId)!).has("pizza"));
  const drinkIds = largeOrder ? ["four-pops", "one-pop", "water-bottle"] : ["one-pop", "water-bottle", "four-pops"];

  if (cartRoles.has("pizza")) {
    add("pizza-dip", ["standard-dip"], "dip", "Perfect for the crust");
    add("pizza-side", ["garlic-bread-cheese", "garlic-bread"], "side", "A side for the table");
    add("pizza-drink", drinkIds, "drink", largeOrder ? "Drinks for the group" : "Something cold with your pizza");
    add("pizza-dessert", ["chocolate-brownie"], "dessert", "A sweet finish");
  } else if (cartRoles.has("wings")) {
    add("wings-side", ["fries", "wedges", "garlic-bread-cheese"], "side", "A classic side for wings");
    add("wings-drink", drinkIds, "drink", largeOrder ? "Drinks for the group" : "Something cold with your wings");
    add("wings-dessert", ["chocolate-brownie"], "dessert", "A sweet finish");
  } else if (cartRoles.has("meal")) {
    add("meal-side", ["fries", "wedges", "garlic-bread"], "side", "Make it a complete meal");
    add("meal-drink", drinkIds, "drink", "Add something cold");
    add("meal-dessert", ["chocolate-brownie"], "dessert", "A sweet finish");
  } else {
    add("side-drink", drinkIds, "drink", "Add something cold");
    add("side-dessert", ["chocolate-brownie"], "dessert", "A sweet finish");
  }

  return recommendations;
}
