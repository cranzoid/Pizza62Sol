/**
 * Spoken words to real menu items, deterministically.
 *
 * A phone caller says "a large pep for pickup" or "two large pizzas and three
 * pounds of wings"; `createOrder` needs product and variation ids. This turns
 * the first into candidates for the second, and it is the highest correctness
 * risk in the voice project, so the rules it follows are narrow:
 *
 * - **It reads the live menu.** The index is built from `loadPublicCatalog`,
 *   the same source the website renders. No ids, names or prices are kept
 *   here; counter-only (`staffOnly`) products are never in it, because the
 *   public catalogue never contains them.
 * - **No model, no embeddings, no fuzzy guessing.** Words are normalized
 *   (case, accents, plurals, number words, a short list of spoken aliases) and
 *   compared exactly against the words of real product names and real option
 *   values. The alias list maps slang onto words the live menu actually uses;
 *   a test fails if one points at a word no product, topping or option has.
 * - **Clarification over guessing.** The answer is `match` only when exactly
 *   one product explains every word the caller said and nothing else on the
 *   menu does as well. Two plausible products are `ambiguous`; a word nobody
 *   on the menu explains stops a confident match. A wrong product is a failure;
 *   a question back to the caller is not.
 * - **Fulfilment-aware.** Build-your-own pizzas are different products for
 *   pickup and delivery. A delivery query never resolves to a pickup-only
 *   product or the other way round; with no fulfilment known, a pizza that
 *   exists as both is ambiguous until the caller says which.
 *
 * Everything below the loader is pure: `buildMenuIndex` and `resolveMenuQuery`
 * take the catalogue and a clock, so the golden tests can pin behaviour.
 */
import {
  BAKE_SAUCE_OPTIONS,
  CHEESE_OPTIONS,
  CRUST_OPTIONS,
  DRINK_OPTIONS,
  isRetiredSection,
  isWithinWeeklyAvailability,
  PIZZA_EXTRA_OPTIONS,
  SAUCE_OPTIONS,
  TWO_LITRE_DRINK_OPTIONS,
  WING_FLAVOURS,
  type Fulfilment,
  type ModifierSection,
  type ToppingPlacement,
  type WeeklyAvailability,
} from "@/lib/domain";

// --- the catalogue the index is built from ------------------------------------

export type VoiceCatalogVariation = {
  id: string;
  name: string;
  basePriceCents: number;
  extraToppingPriceCents: number;
  includedToppingUnitsBps: number;
};

export type VoiceCatalogProduct = {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  productType: string;
  basePriceCents: number;
  pickupEligible: boolean;
  deliveryEligible: boolean;
  soldOut: boolean;
  setupRequired: boolean;
  configuration: Record<string, unknown>;
  /** The option sections `validateItems` uses (`orderableSections`), retired ones removed. */
  sections: ModifierSection[];
  variations: VoiceCatalogVariation[];
};

export type VoiceCatalog = {
  products: VoiceCatalogProduct[];
  toppings: Array<{ id: string; name: string }>;
};

/**
 * The public menu, in the shape the index needs.
 *
 * `loadPublicCatalog` has already dropped inactive products, inactive
 * variations, inactive toppings and every `staffOnly` product. Sold-out and
 * setup-required products are kept so the resolver can say "that's sold out"
 * rather than "we don't have that".
 */
export async function loadVoiceCatalog(): Promise<VoiceCatalog> {
  const [{ loadPublicCatalog }, { orderableSections }] = await Promise.all([
    import("@/lib/public-catalog"),
    import("@/lib/order-service"),
  ]);
  const catalog = await loadPublicCatalog();
  const categoryNames = new Map(catalog.categories.map((category) => [String(category.id), String(category.name)]));
  const variationsByProduct = new Map<string, VoiceCatalogVariation[]>();
  for (const variation of catalog.variations as unknown as Array<Record<string, unknown>>) {
    const list = variationsByProduct.get(String(variation.product_id)) ?? [];
    list.push({
      id: String(variation.id),
      name: String(variation.name),
      basePriceCents: Number(variation.base_price_cents),
      extraToppingPriceCents: Number(variation.extra_topping_price_cents),
      includedToppingUnitsBps: Number(variation.included_topping_units_bps),
    });
    variationsByProduct.set(String(variation.product_id), list);
  }
  return {
    products: (catalog.products as unknown as Array<Record<string, unknown>>).map((product) => {
      const configuration = (product.configuration ?? {}) as Record<string, unknown>;
      return {
        id: String(product.id),
        name: String(product.name),
        categoryId: String(product.category_id),
        categoryName: categoryNames.get(String(product.category_id)) ?? String(product.category_id),
        productType: String(product.product_type),
        basePriceCents: Number(product.base_price_cents),
        pickupEligible: Boolean(Number(product.pickup_eligible)),
        deliveryEligible: Boolean(Number(product.delivery_eligible)),
        soldOut: Boolean(Number(product.sold_out)),
        setupRequired: Boolean(Number(product.setup_required)),
        configuration,
        sections: orderableSections(String(product.product_type), configuration).filter((section) => !isRetiredSection(section)),
        variations: variationsByProduct.get(String(product.id)) ?? [],
      };
    }),
    toppings: (catalog.toppings as unknown as Array<Record<string, unknown>>).map((topping) => ({
      id: String(topping.id),
      name: String(topping.name),
    })),
  };
}

// --- words ---------------------------------------------------------------------

export type Size = "medium" | "large" | "xl" | "jumbo" | "slab";
export const SIZE_WORDS: readonly Size[] = ["medium", "large", "xl", "jumbo", "slab"];
const SIZE_SET = new Set<string>(SIZE_WORDS);
/** Sizes callers ask for that the menu does not sell. Recognised so they are refused, not ignored. */
const UNOFFERED_SIZES = new Set(["small", "personal", "mini", "individual"]);

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

/** Never singularized: they end in "s" without being plurals. */
const SINGULAR_EXCEPTIONS = new Set(["this", "is", "was", "has", "his", "its", "us", "yes", "plus", "bbq", "lbs", "less", "christmas"]);

/**
 * Spoken forms mapped onto the words the menu itself uses, applied to product
 * names, option values and queries alike so both sides always agree. Every
 * target must exist somewhere on the live menu — tested in
 * `tests/voice-menu-resolver.test.ts`.
 */
export const PHRASE_ALIASES: ReadonlyArray<readonly [string[], string[]]> = [
  [["extra", "large"], ["xl"]],
  [["xtra", "large"], ["xl"]],
  [["x", "large"], ["xl"]],
  [["ex", "large"], ["xl"]],
  [["xlarge"], ["xl"]],
  [["lg"], ["large"]],
  [["lrg"], ["large"]],
  [["med"], ["medium"]],
  [["md"], ["medium"]],
  [["pound"], ["lb"]],
  [["lbs"], ["lb"]],
  [["chicken", "wing"], ["wing"]],
  [["can", "of", "pop"], ["pop"]],
  [["can", "of", "soda"], ["pop"]],
  [["pop", "can"], ["pop"]],
  [["bottle", "of", "water"], ["water"]],
  [["bottled", "water"], ["water"]],
  [["water", "bottle"], ["water"]],
  [["pep"], ["pepperoni"]],
  [["pepp"], ["pepperoni"]],
  [["peperoni"], ["pepperoni"]],
  [["pepperonni"], ["pepperoni"]],
  [["roni"], ["pepperoni"]],
  [["shroom"], ["mushroom"]],
  [["veggie"], ["vegetarian"]],
  [["mexican"], ["mexicana"]],
  [["hawaian"], ["hawaiian"]],
  [["panzo"], ["panzerotti"]],
  [["panzarotti"], ["panzerotti"]],
  [["panzerotto"], ["panzerotti"]],
  [["panzarotto"], ["panzerotti"]],
  [["mozza"], ["mozzarella"]],
  [["mozarella"], ["mozzarella"]],
  [["bread", "stick"], ["breadstick"]],
  [["cheesy"], ["cheese"]],
  [["jalapeno", "popper"], ["jalapeno"]],
  [["stuffed", "jalapeno"], ["jalapeno"]],
  [["potato", "wedge"], ["wedge"]],
  [["dipping", "sauce"], ["dip"]],
  [["2", "for", "1"], ["2for1"]],
  [["buy", "1", "get", "1"], ["2for1"]],
  [["bogo"], ["2for1"]],
  [["loonie"], ["dollar"]],
  [["buck"], ["dollar"]],
  [["barbecue"], ["bbq"]],
  [["barbeque"], ["bbq"]],
  [["sundried"], ["sun", "dried"]],
  [["anchovy"], ["anchovie"]],
  [["fry"], ["frie"]],
];

/** Drink and wing-style names as callers say them, mapped to the option value. */
const OPTION_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["coca cola", "Coke"],
  ["diet coca cola", "Diet Coke"],
  ["ginger ale", "Canada Dry"],
  ["cream soda", "Crush Cream Soda"],
  ["grape crush", "Crush Grape"],
  ["grape soda", "Crush Grape"],
  ["orange fanta", "Fanta Orange"],
  ["pineapple fanta", "Fanta Pineapple"],
  ["doctor pepper", "Dr Pepper"],
  ["dr pepper", "Dr Pepper"],
  ["naked", "Classic (non-breaded)"],
  ["non breaded", "Classic (non-breaded)"],
  ["classic", "Classic (non-breaded)"],
  ["plain", "Classic (non-breaded)"],
];

/** Polite filler a caller wraps an order in. Never evidence of anything. */
const STOPWORDS = new Set([
  "a", "an", "the", "i", "id", "im", "ill", "can", "could", "get", "got", "have", "want", "wanna", "would", "like",
  "please", "pls", "thank", "thanks", "you", "me", "my", "for", "of", "with", "and", "or", "some", "also", "plus",
  "just", "um", "uh", "hi", "hey", "hello", "yeah", "yes", "ok", "okay", "order", "to", "it", "that", "this",
  "be", "will", "need", "give", "gimme", "let", "lets", "do", "does", "is", "are", "what", "there", "all", "any",
  "make", "add", "another", "too", "as", "well", "in", "at", "up", "from", "today", "tonight", "now", "asap",
  "piece", "pc", "order", "go", "take", "takeout", "both", "them", "those", "these", "they", "we", "our", "us",
  "so", "then", "maybe", "think", "guess", "actually", "really", "oh", "hmm", "how", "about", "on", "side",
  "lemme", "gonna", "gotta", "kinda", "sorta", "umm", "uhh", "er", "erm", "know", "yknow", "sir", "maam", "buddy",
  "bud", "mean", "said", "say", "go", "with", "great", "good", "perfect", "sure", "alright", "right", "now",
]);

/** Words that say which way the order goes, recorded and otherwise ignored. */
const FULFILMENT_WORDS: Record<string, Fulfilment> = {
  pickup: "pickup", pick: "pickup", collect: "pickup", collection: "pickup",
  delivery: "delivery", deliver: "delivery", delivered: "delivery",
};

/** How a caller shapes a topping: placement, omission, quantity. */
const MODIFIER_WORDS = new Set(["half", "left", "right", "whole", "no", "without", "hold", "minus", "extra", "light", "double", "easy", "lite"]);

type Noun = "pizza" | "wing" | "pop" | "slice" | "water";
const NOUN_SYNONYMS: Record<string, Noun> = {
  pizza: "pizza", pie: "pizza", za: "pizza",
  wing: "wing",
  pop: "pop", soda: "pop", cola: "pop",
  slice: "slice",
  water: "water",
};

/** Name words that describe a bundle rather than identify it. */
const MARKERS = new Set(["combo", "deal", "special", "offer", "2for1"]);
/** Name words that are quantities or measures, read structurally instead. */
const UNIT_WORDS = new Set(["lb", "item", "topping", "each", "shared", "dollar", "size", "by"]);
const CONNECTORS = new Set(["and", "with", "of", "the", "a", "on", "all", "your"]);

function singularize(token: string): string {
  if (/^\d/.test(token) || SINGULAR_EXCEPTIONS.has(token)) return token;
  if (token.length > 4 && token.endsWith("oes")) return token.slice(0, -2);
  if (token.length <= 3 || token.endsWith("ss")) return token;
  return token.endsWith("s") ? token.slice(0, -1) : token;
}

function convertNumbers(tokens: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "dozen") {
      const previous = out.at(-1);
      if (previous && /^\d+$/.test(previous)) out[out.length - 1] = String(Number(previous) * 12);
      else if (previous === "a" || previous === "an") out[out.length - 1] = "12";
      else if (previous === "half") out[out.length - 1] = "6";
      else out.push("12");
      continue;
    }
    if (token in NUMBER_WORDS) {
      let value = NUMBER_WORDS[token];
      const next = tokens[index + 1];
      if (value >= 20 && value % 10 === 0 && next && next in NUMBER_WORDS && NUMBER_WORDS[next] < 10 && NUMBER_WORDS[next] > 0) {
        value += NUMBER_WORDS[next];
        index += 1;
      }
      out.push(String(value));
      continue;
    }
    out.push(token);
  }
  return out;
}

function applyPhraseAliases(tokens: string[]): string[] {
  const out: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    let replaced = false;
    // Longest alias first, so "can of pop" wins over a shorter one inside it.
    for (const [from, to] of [...PHRASE_ALIASES].sort((a, b) => b[0].length - a[0].length)) {
      if (from.every((word, offset) => tokens[index + offset] === word)) {
        out.push(...to);
        index += from.length;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      out.push(tokens[index]);
      index += 1;
    }
  }
  return out;
}

/** The one normalizer, for product names, option values and queries alike. */
export function normalizeWords(text: string): string[] {
  const base = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/1\/2/g, " half ")
    .replace(/&|\+/g, " and ")
    .replace(/\$\s*(\d+)/g, " $1 dollar ")
    .replace(/(\d)\s*(lbs?|pounds?)\b/g, "$1 lb")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!base) return [];
  return applyPhraseAliases(convertNumbers(base.split(/\s+/)).map(singularize));
}

// --- the index -----------------------------------------------------------------

export type MenuFamily = "pizza" | "specialty" | "wings" | "bundle" | "slice" | "drink" | "item";

type OptionPhrase = { tokens: string[]; value: string; source: string; sectionId: string };

type IndexedProduct = {
  product: VoiceCatalogProduct;
  family: MenuFamily;
  /** Every word that names it: its name, its category's name and id. */
  vocabulary: Set<string>;
  /** The words that tell it apart from the rest of its family. */
  distinctive: string[];
  nouns: Set<Noun>;
  sizes: Size[];
  variationBySize: Map<Size, VoiceCatalogVariation>;
  pizzaCount: number;
  includedToppings: number | null;
  sharedToppings: number | null;
  /** "Up to N" (delivery Pizza by Size) rather than "exactly N" (pickup 1 Item / 3 Items). */
  toppingsUpTo: boolean;
  wingCount: number | null;
  wingLb: number | null;
  popCount: number;
  sliceCount: number;
  /** Markers in the product's own name (combo, special) as opposed to its category. */
  nameMarkers: Set<string>;
  markers: Set<string>;
  /** A count can be read as a quantity of this product: two slices, three pops, two poutines. */
  unit: Noun | "lb" | "item" | null;
  acceptsToppings: boolean;
  recipeToppingIds: string[];
  options: OptionPhrase[];
  fulfilments: Fulfilment[];
  state: "available" | "sold_out" | "setup_required" | "outside_offer_hours";
  availabilityLabel: string | null;
  /** Another product that is the same item (same name, price and options), kept instead. */
  duplicateOf: string | null;
};

export type MenuIndex = {
  products: IndexedProduct[];
  toppings: Array<{ id: string; name: string; tokens: string[] }>;
  /** Toppings by a single word, where that word names more than one ("olive"). */
  toppingWords: Map<string, string[]>;
  /** How many products use each distinctive word: "breadstick" is one product, "poutine" three. */
  distinctiveFrequency: Map<string, number>;
  builtAt: number;
};

const torontoDate = (now: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));

/** An offer whose last date has passed is not on the menu at all, rather than "not right now". */
function hasExpired(availability: WeeklyAvailability | undefined, now: number): boolean {
  if (!availability?.endDate) return false;
  return availability.endDate < torontoDate(now);
}

function sectionValues(section: ModifierSection): string[] {
  if (section.options?.length) return section.options;
  switch (section.source) {
    case "wing_flavours": return [...WING_FLAVOURS];
    case "drinks": return [...DRINK_OPTIONS];
    case "two_litre_drinks": return [...TWO_LITRE_DRINK_OPTIONS];
    case "crust": return [...CRUST_OPTIONS];
    case "bake_sauce": return [...BAKE_SAUCE_OPTIONS];
    case "cheese": return [...CHEESE_OPTIONS];
    case "sauce": return [...SAUCE_OPTIONS];
    case "pizza_extras": return [...PIZZA_EXTRA_OPTIONS];
    default: return [];
  }
}

/** The number written directly before `unit` in a name: "3 lb Wings" → 3 for "lb". */
function numberBefore(tokens: string[], unit: string): number | null {
  const at = tokens.indexOf(unit);
  return at > 0 && /^\d+$/.test(tokens[at - 1]) ? Number(tokens[at - 1]) : null;
}

function classify(product: VoiceCatalogProduct, nameTokens: string[]): MenuFamily {
  const config = product.configuration;
  const sections = product.sections;
  if (product.productType === "pizza" && config.fixedRecipe) return "specialty";
  if (product.productType === "pizza" && nameTokens.includes("pizza") && !nameTokens.includes("sub")) return "pizza";
  if (product.productType === "bundle") return "bundle";
  if (sections.some((section) => section.source === "toppings" && /slice/i.test(`${section.group ?? ""} ${section.id}`))) return "slice";
  if (sections.some((section) => section.source === "wing_flavours")) return "wings";
  if (product.categoryId === "drinks" || (sections.length && sections.every((section) => section.source === "drinks"))) return "drink";
  return "item";
}

/** The pizzas inside a bundle: one per option group that has a crust, cheese or toppings choice. */
function pizzaGroups(sections: ModifierSection[]): Map<string, ModifierSection[]> {
  const groups = new Map<string, ModifierSection[]>();
  for (const section of sections) {
    if (!section.group || /slice/i.test(section.group)) continue;
    if (section.source !== "crust" && section.source !== "cheese" && section.source !== "toppings" && section.source !== "sauce") continue;
    groups.set(section.group, [...(groups.get(section.group) ?? []), section]);
  }
  return groups;
}

function optionPhrases(sections: ModifierSection[]): OptionPhrase[] {
  const phrases: OptionPhrase[] = [];
  for (const section of sections) {
    if (section.source === "toppings") continue;
    for (const value of sectionValues(section)) {
      phrases.push({ tokens: normalizeWords(value), value, source: section.source ?? `options:${section.id}`, sectionId: section.id });
      for (const [alias, target] of OPTION_ALIASES) {
        if (target === value) phrases.push({ tokens: normalizeWords(alias), value, source: section.source ?? `options:${section.id}`, sectionId: section.id });
      }
    }
  }
  return phrases.filter((phrase) => phrase.tokens.length);
}

/** Same item, listed twice — e.g. "1 lb Wings" in Wings and again in Pickup Specials. */
function identityKey(product: VoiceCatalogProduct): string {
  return JSON.stringify({
    name: normalizeWords(product.name),
    type: product.productType,
    price: product.basePriceCents,
    sections: product.sections,
    variations: product.variations.map((variation) => [normalizeWords(variation.name), variation.basePriceCents, variation.extraToppingPriceCents, variation.includedToppingUnitsBps]),
    recipe: product.configuration.recipeToppingIds ?? null,
    freeDelivery: product.configuration.freeDelivery ?? null,
    availability: product.configuration.availability ?? null,
  });
}

export function buildMenuIndex(catalog: VoiceCatalog, options: { now?: number } = {}): MenuIndex {
  const now = options.now ?? Date.now();
  const products: IndexedProduct[] = [];
  for (const product of catalog.products) {
    const availability = product.configuration.availability as WeeklyAvailability | undefined;
    if (hasExpired(availability, now)) continue;
    const nameTokens = normalizeWords(product.name);
    const family = classify(product, nameTokens);
    const sections = product.sections;
    const categoryTokens = [...normalizeWords(product.categoryName), ...normalizeWords(product.categoryId)];
    const vocabulary = new Set([...nameTokens, ...categoryTokens]);
    // "Slab Pizza · 24 Slices" describes a slab; it is not a slice product.
    if (family === "pizza" || family === "specialty") vocabulary.delete("slice");

    const sizes = new Set<Size>(nameTokens.filter((token): token is Size => SIZE_SET.has(token)));
    const variationBySize = new Map<Size, VoiceCatalogVariation>();
    for (const variation of product.variations) {
      for (const token of normalizeWords(variation.name)) {
        if (SIZE_SET.has(token)) {
          sizes.add(token as Size);
          variationBySize.set(token as Size, variation);
        }
      }
    }

    const groups = pizzaGroups(sections);
    const isPizzaProduct = family === "pizza" || family === "specialty";
    const pizzaCount = isPizzaProduct ? 1 : family === "bundle" ? groups.size : 0;
    const toppingSections = [...groups.values()].flat().filter((section) => section.source === "toppings");
    const shared = toppingSections.find((section) => section.sharedGroup && section.sharedIncluded);
    const firstVariation = product.variations[0];
    const includedToppings = family === "pizza" && firstVariation
      ? firstVariation.includedToppingUnitsBps / 10_000
      : family === "bundle" && toppingSections.length && !shared
        ? Math.max(...toppingSections.map((section) => section.included ?? 0))
        : null;
    const wingLb = numberBefore(nameTokens, "lb");
    const wingCount = wingLb === null && sections.some((section) => section.source === "wing_flavours") ? numberBefore(nameTokens, "wing") : null;
    const popCount = sections.filter((section) => section.source === "drinks" || section.source === "two_litre_drinks").length;
    const sliceCount = family === "slice" ? sections.filter((section) => section.source === "toppings").length : 0;

    const nouns = new Set<Noun>();
    if (pizzaCount) nouns.add("pizza");
    if (sections.some((section) => section.source === "wing_flavours")) nouns.add("wing");
    if (popCount) nouns.add("pop");
    if (family === "slice") nouns.add("slice");
    if (nameTokens.includes("water")) nouns.add("water");

    const nameMarkers = new Set(nameTokens.filter((token) => MARKERS.has(token)));
    const markers = new Set([...vocabulary].filter((token) => MARKERS.has(token)));
    const genericNouns = new Set<string>(family === "item" ? [] : ["pizza", "wing", "pop", "slice", "water", "dip"]);
    const COUNTED = new Set<string>([...SIZE_WORDS, "pizza", "wing", "pop", "slice", "water", ...UNIT_WORDS]);
    const distinctive = [...new Set(nameTokens.filter((token, at) =>
      !SIZE_SET.has(token) && !(/^\d+$/.test(token) && COUNTED.has(nameTokens[at + 1] ?? "")) && !UNIT_WORDS.has(token) &&
      !MARKERS.has(token) && !CONNECTORS.has(token) && !genericNouns.has(token) && !(token in NUMBER_WORDS),
    ))];

    const unit: IndexedProduct["unit"] =
      isPizzaProduct ? "pizza"
        : family === "drink" && popCount === 1 ? "pop"
          : family === "slice" && sliceCount === 1 && !nameMarkers.size ? "slice"
            : family === "wings" && wingLb === 1 ? "lb"
              : family === "wings" && product.configuration.quantitySelectable ? "wing"
                : family === "item" ? "item"
                  : null;

    const state: IndexedProduct["state"] = product.setupRequired
      ? "setup_required"
      : product.soldOut
        ? "sold_out"
        : !isWithinWeeklyAvailability(availability, new Date(now))
          ? "outside_offer_hours"
          : "available";

    products.push({
      product,
      family,
      vocabulary,
      distinctive,
      nouns,
      sizes: SIZE_WORDS.filter((size) => sizes.has(size)),
      variationBySize,
      pizzaCount,
      includedToppings,
      sharedToppings: shared?.sharedIncluded ?? null,
      toppingsUpTo: family === "pizza" && normalizeWords(firstVariation?.name ?? "").includes("up"),
      wingCount,
      wingLb,
      popCount,
      sliceCount,
      nameMarkers,
      markers,
      unit,
      acceptsToppings: product.productType === "pizza" || sections.some((section) => section.source === "toppings"),
      recipeToppingIds: Array.isArray(product.configuration.recipeToppingIds) ? (product.configuration.recipeToppingIds as unknown[]).map(String) : [],
      options: optionPhrases(sections),
      fulfilments: [
        ...(product.pickupEligible ? (["pickup"] as const) : []),
        ...(product.deliveryEligible ? (["delivery"] as const) : []),
      ],
      state,
      availabilityLabel: availability?.label ?? null,
      duplicateOf: null,
    });
  }

  // Collapse true duplicates onto the listing that can be ordered more widely.
  const byIdentity = new Map<string, IndexedProduct[]>();
  for (const entry of products) {
    const key = identityKey(entry.product);
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), entry]);
  }
  for (const group of byIdentity.values()) {
    if (group.length < 2) continue;
    const keep = [...group].sort((a, b) => b.fulfilments.length - a.fulfilments.length || a.product.id.localeCompare(b.product.id))[0];
    for (const entry of group) if (entry !== keep) entry.duplicateOf = keep.product.id;
  }

  const toppings = catalog.toppings.map((topping) => ({ ...topping, tokens: normalizeWords(topping.name) }));
  const toppingWords = new Map<string, string[]>();
  const GENERIC_TOPPING_WORDS = new Set(["real", "hot", "green", "black", "bit", "cheese", "dried", "sun", "italian", "ground"]);
  for (const topping of toppings) {
    for (const token of topping.tokens) {
      if (GENERIC_TOPPING_WORDS.has(token)) continue;
      toppingWords.set(token, [...(toppingWords.get(token) ?? []), topping.id]);
    }
  }
  const distinctiveFrequency = new Map<string, number>();
  for (const entry of products) {
    if (entry.duplicateOf) continue;
    for (const word of entry.distinctive) distinctiveFrequency.set(word, (distinctiveFrequency.get(word) ?? 0) + 1);
  }
  return { products, toppings, toppingWords, distinctiveFrequency, builtAt: now };
}

// --- reading a query -----------------------------------------------------------

type ParsedQuery = {
  tokens: string[];
  fulfilment: Fulfilment | null;
  sizes: Array<{ size: Size; index: number; mayBeFlavour: boolean }>;
  unofferedSize: string | null;
  nouns: Array<{ noun: Noun; index: number }>;
  counts: { pizza?: number; wing?: number; lb?: number; pop?: number; slice?: number; topping?: number; item?: number };
  countIndexes: Set<number>;
  plural: { pizza: boolean };
  markers: Set<string>;
  explainedByParse: Set<number>;
};

const isNumber = (token: string | undefined) => token !== undefined && /^\d+$/.test(token);

function parseQuery(tokens: string[], rawTokens: string[]): ParsedQuery {
  const parsed: ParsedQuery = {
    tokens,
    fulfilment: null,
    sizes: [],
    unofferedSize: null,
    nouns: [],
    counts: {},
    countIndexes: new Set(),
    plural: { pizza: rawTokens.some((token) => token === "pizzas" || token === "pies") },
    markers: new Set(),
    explainedByParse: new Set(),
  };
  tokens.forEach((token, index) => {
    if (STOPWORDS.has(token)) parsed.explainedByParse.add(index);
    if (token in FULFILMENT_WORDS) {
      parsed.fulfilment = FULFILMENT_WORDS[token];
      parsed.explainedByParse.add(index);
      if (token === "pick" && tokens[index + 1] === "up") parsed.explainedByParse.add(index + 1);
    }
    if (MODIFIER_WORDS.has(token)) parsed.explainedByParse.add(index);
    if (SIZE_SET.has(token)) {
      // "medium wings" is a sauce, not a size.
      parsed.sizes.push({ size: token as Size, index, mayBeFlavour: token === "medium" && (tokens[index + 1] === "wing" || tokens[index + 1] === "hot") });
    }
    if (UNOFFERED_SIZES.has(token)) parsed.unofferedSize = token;
    if (token in NOUN_SYNONYMS) parsed.nouns.push({ noun: NOUN_SYNONYMS[token], index });
    if (MARKERS.has(token)) parsed.markers.add(token);
  });
  // A number counts whatever it is attached to: "24 wings", "3 lb", "2 large pizzas", "2 slice combo".
  const UNIT_OF: Record<string, keyof ParsedQuery["counts"]> = {
    pizza: "pizza", pie: "pizza", za: "pizza", wing: "wing", lb: "lb", pop: "pop", soda: "pop", slice: "slice", topping: "topping", item: "topping",
  };
  tokens.forEach((token, index) => {
    if (!isNumber(token)) return;
    if (tokens[index + 1] === "dollar") return; // a price, not a count
    for (let ahead = index + 1; ahead <= index + 4 && ahead < tokens.length; ahead += 1) {
      const word = tokens[ahead];
      if (isNumber(word) || word === "and" || word === "with") break;
      if (word in UNIT_OF) {
        parsed.counts[UNIT_OF[word]] = Number(token);
        parsed.countIndexes.add(index);
        if (word === "lb" || word === "topping" || word === "item") parsed.explainedByParse.add(ahead);
        return;
      }
    }
    const next = tokens[index + 1];
    if (Number(token) <= 20 && next && SIZE_SET.has(next)) {
      parsed.counts.pizza ??= Number(token);
      parsed.countIndexes.add(index);
      return;
    }
    if (Number(token) <= 20 && next && !STOPWORDS.has(next)) {
      parsed.counts.item ??= Number(token);
      parsed.countIndexes.add(index);
    }
  });
  if (tokens.includes("lb") && parsed.counts.lb === undefined) {
    parsed.counts.lb = 1;
    parsed.explainedByParse.add(tokens.indexOf("lb"));
  }
  return parsed;
}

/** Longest-first phrase matches of `entries` over the query, never overlapping. */
function findPhrases<T>(tokens: string[], entries: Array<{ tokens: string[]; value: T }>): Array<{ start: number; end: number; value: T }> {
  const found: Array<{ start: number; end: number; value: T }> = [];
  const taken = new Set<number>();
  const sorted = [...entries].sort((a, b) => b.tokens.length - a.tokens.length);
  for (const entry of sorted) {
    if (!entry.tokens.length) continue;
    for (let start = 0; start + entry.tokens.length <= tokens.length; start += 1) {
      let fits = true;
      for (let offset = 0; offset < entry.tokens.length; offset += 1) {
        if (tokens[start + offset] !== entry.tokens[offset] || taken.has(start + offset)) {
          fits = false;
          break;
        }
      }
      if (!fits) continue;
      found.push({ start, end: start + entry.tokens.length, value: entry.value });
      for (let offset = 0; offset < entry.tokens.length; offset += 1) taken.add(start + offset);
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

// --- resolving -----------------------------------------------------------------

export type DetectedTopping = { toppingId: string; name: string; placement: ToppingPlacement };

export type MenuCandidate = {
  productId: string;
  name: string;
  category: string;
  kind: MenuFamily;
  /** Set when the query named a size this product sells as a variation, or it has only one. */
  variationId: string | null;
  variationName: string | null;
  /** The product's sizes, when it is sold in several. */
  sizes: Array<{ variationId: string; name: string; priceCents: number }>;
  /** The live menu price before options: the resolved size, the only variation, or the product. */
  priceCents: number;
  fulfilments: Fulfilment[];
  available: boolean;
  unavailableReason: "sold_out" | "outside_offer_hours" | "setup_required" | "not_for_fulfilment" | "size_not_offered" | null;
  availabilityLabel: string | null;
  /** When the caller said a count that means "this many of these". */
  suggestedQuantity: number | null;
  /** What the caller said about the item, as hints for building it. Never applied by itself. */
  detected: {
    toppings: DetectedTopping[];
    omitToppings: Array<{ toppingId: string; name: string }>;
    extraCheese: boolean;
    options: Array<{ sectionId: string; value: string }>;
  };
};

export type MenuResolution = {
  status: "match" | "ambiguous" | "no_match" | "unavailable";
  query: string;
  candidates: MenuCandidate[];
  /** What to ask the caller, server-written. */
  clarify: string | null;
  /** Words nothing on the menu explained. Their presence alone prevents a confident match. */
  unrecognized: string[];
  /** Topping words that name more than one topping ("olives": green or black?). */
  ambiguousToppings: Array<{ word: string; options: string[] }>;
};

/** Words that mean "an offer" interchangeably. "combo" and "2 for 1" are specific and are not in it. */
const GENERIC_DEAL_WORDS = new Set(["deal", "offer", "special"]);
/** Words a caller uses for "the build-your-own kind". */
const BUILD_YOUR_OWN_WORDS = new Set(["build", "own", "custom", "byo", "create", "plain", "regular"]);
const NEGATIONS = new Set(["no", "without", "hold", "minus"]);

function markerExplains(marker: string, entry: IndexedProduct): boolean {
  if (entry.markers.has(marker)) return true;
  return GENERIC_DEAL_WORDS.has(marker) && [...entry.markers].some((own) => GENERIC_DEAL_WORDS.has(own));
}

type Evaluation = {
  entry: IndexedProduct;
  strength: "strong" | "weak";
  unexplained: number[];
  /** Some word the caller said is this product's own word — not merely a size or a topping. */
  named: boolean;
  /** "3 lb wings" read as three 1 lb orders: a business decision, so never a confident match. */
  quantityInterpretation: boolean;
  literalCount: boolean;
  toppingExact: boolean;
  unrequestedNameMarkers: number;
  unrequestedPizzas: boolean;
  distinctiveMatched: number;
  sizeResolved: Size | null;
  quantity: number | null;
  detected: MenuCandidate["detected"];
};

/** Refused only for size. `named`: the caller said its whole name, so "not in that size" is the answer. */
type Rejection = { entry: IndexedProduct; reason: "size"; named: boolean };

function toppingUnits(toppings: DetectedTopping[]): number {
  return toppings.reduce((sum, topping) => sum + (topping.placement === "whole" ? 1 : 0.5), 0);
}

function evaluate(
  entry: IndexedProduct,
  parsed: ParsedQuery,
  index: MenuIndex,
  toppingSpans: Array<{ start: number; end: number; value: { ids: string[] } }>,
): Evaluation | Rejection | null {
  const { tokens } = parsed;
  const explained = new Set(parsed.explainedByParse);
  let named = false;
  const isPizza = entry.nouns.has("pizza");
  const said = (noun: Noun) => parsed.nouns.some((entryNoun) => entryNoun.noun === noun);

  // Option values this product offers ("honey garlic", "coke", "greek", "breaded"). A
  // size word used as a size ("medium pizza") is not the wing sauce "Medium".
  const sizeAt = new Set(parsed.sizes.filter((size) => !size.mayBeFlavour).map((size) => size.index));
  const optionTokens = tokens.map((token, at) => (sizeAt.has(at) ? "\u0000" : token));
  const optionMatches = findPhrases(optionTokens, entry.options.map((option) => ({ tokens: option.tokens, value: option })));
  const optionIndexes = new Set<number>();
  for (const match of optionMatches) for (let at = match.start; at < match.end; at += 1) optionIndexes.add(at);
  if (optionMatches.length) named = true;
  for (const at of optionIndexes) explained.add(at);

  // Toppings, when this product takes them.
  const detectedToppings: DetectedTopping[] = [];
  const omitted: Array<{ toppingId: string; name: string }> = [];
  if (entry.acceptsToppings) {
    for (const span of toppingSpans) {
      let overlapsOption = false;
      for (let at = span.start; at < span.end; at += 1) if (optionIndexes.has(at)) overlapsOption = true;
      if (overlapsOption) continue;
      for (let at = span.start; at < span.end; at += 1) explained.add(at);
      if (span.value.ids.length !== 1) continue;
      const toppingId = span.value.ids[0];
      const name = index.toppings.find((topping) => topping.id === toppingId)?.name ?? toppingId;
      const before = tokens.slice(Math.max(0, span.start - 2), span.start);
      const after = tokens.slice(span.end, span.end + 3);
      if (before.some((word) => NEGATIONS.has(word))) {
        omitted.push({ toppingId, name });
        continue;
      }
      const halves = tokens.slice(0, span.start).filter((word) => word === "half").length;
      const side = [...before, ...after].find((word) => word === "left" || word === "right") as "left" | "right" | undefined;
      const placement: ToppingPlacement = side ?? (halves === 1 ? "left" : halves >= 2 ? "right" : "whole");
      // A recipe topping is already on a specialty; only additions are hints.
      if (!entry.recipeToppingIds.includes(toppingId) || placement !== "whole") detectedToppings.push({ toppingId, name, placement });
    }
  }
  const extraCheese = isPizza && tokens.some((word, at) => word === "extra" && tokens[at + 1] === "cheese");
  // "cheese pizza" is the plain pizza; "extra cheese" is an option on one.
  if (isPizza) tokens.forEach((word, at) => word === "cheese" && explained.add(at));
  if (entry.family === "pizza") tokens.forEach((word, at) => BUILD_YOUR_OWN_WORDS.has(word) && explained.add(at));

  // Nouns the caller used must be part of this product.
  for (const { noun, index: at } of parsed.nouns) {
    if (entry.nouns.has(noun) || entry.vocabulary.has(tokens[at])) {
      explained.add(at);
      named = true;
    } else return null;
  }

  // Sizes.
  let sizeResolved: Size | null = null;
  for (const { size, index: at, mayBeFlavour } of parsed.sizes) {
    if (optionIndexes.has(at)) continue; // "medium" the wing sauce
    if (!entry.sizes.length) continue; // unexplained: this product has no sizes
    if (!entry.sizes.includes(size)) {
      if (mayBeFlavour) continue;
      return { entry, reason: "size", named: entry.distinctive.length > 0 && entry.distinctive.every((word) => tokens.includes(word)) };
    }
    // Two different sizes ("a medium hawaiian and a large pepperoni") are two
    // items; the second is left unexplained so neither is matched confidently.
    if (sizeResolved && sizeResolved !== size) continue;
    sizeResolved = size;
    explained.add(at);
  }
  if (parsed.unofferedSize && isPizza) return { entry, reason: "size", named: false };

  // Name and category words.
  let distinctiveMatched = 0;
  let categoryHit = false;
  const categoryOnly = new Set([...normalizeWords(entry.product.categoryName), ...normalizeWords(entry.product.categoryId)]);
  tokens.forEach((word, at) => {
    if (entry.vocabulary.has(word) && !MARKERS.has(word)) {
      explained.add(at);
      if (!SIZE_SET.has(word) && !STOPWORDS.has(word)) named = true;
      if (categoryOnly.has(word) && !entry.distinctive.includes(word) && word !== "pizza") categoryHit = true;
    }
  });
  for (const word of entry.distinctive) if (tokens.includes(word)) distinctiveMatched += 1;

  // Markers: "combo", "deal", "2 for 1".
  let markerHit = false;
  tokens.forEach((word, at) => {
    if (MARKERS.has(word) && markerExplains(word, entry)) {
      explained.add(at);
      markerHit = true;
      named = true;
    }
  });

  // What it is has to be said or plainly implied.
  const pizzaImplied =
    said("pizza") || parsed.sizes.some((size) => !size.mayBeFlavour) || detectedToppings.length > 0 ||
    omitted.length > 0 || tokens.includes("cheese") || markerHit || distinctiveMatched > 0;
  if ((entry.family === "pizza" || entry.family === "specialty" || entry.family === "bundle") && !pizzaImplied) return null;
  if (entry.family === "bundle" && entry.nouns.has("wing") && !said("wing") && !markerHit && distinctiveMatched === 0) return null;
  if (entry.family === "wings" && !said("wing")) return null;
  if (entry.family === "slice" && !said("slice")) return null;
  if (entry.family === "drink") {
    const asked = said("pop") || said("water") || optionMatches.length > 0 || (entry.vocabulary.has("drink") && tokens.includes("drink"));
    if (!asked) return null;
  }

  // Distinctive name words.
  let strength: Evaluation["strength"] = "strong";
  if (entry.distinctive.length && distinctiveMatched === 0) {
    if (entry.family === "specialty") return null;
    if (entry.family === "item") {
      // Asked for by its menu section ("a dessert"): worth offering, never a match.
      if (!categoryHit) return null;
      strength = "weak";
    }
    if (entry.family === "bundle" && !markerHit) return null;
    if (entry.family === "wings" && !tokens.includes("dollar")) return null;
  } else if (entry.distinctive.length && distinctiveMatched < entry.distinctive.length) {
    if (entry.family === "specialty") strength = "weak";
    if (entry.family === "item") {
      // "breadsticks" names the one breadstick product; "poutine" alone does not name Samosa Poutine.
      const head = entry.distinctive[entry.distinctive.length - 1];
      const headUnique = tokens.includes(head) && (index.distinctiveFrequency.get(head) ?? 0) === 1;
      if (!headUnique) strength = "weak";
    }
  }
  if (entry.family === "wings" && tokens.includes("dollar") && !entry.vocabulary.has("dollar")) return null;

  // Counts.
  const { counts } = parsed;
  let quantity: number | null = null;
  let literalCount = false;
  let quantityInterpretation = false;
  const take = (word: string) => tokens.forEach((token, at) => token === word && explained.add(at));
  const countIndex = (value: number | undefined) => tokens.findIndex((token, at) => parsed.countIndexes.has(at) && Number(token) === value);
  if (counts.pizza !== undefined) {
    if (entry.pizzaCount === counts.pizza && (entry.family === "bundle" || counts.pizza === 1)) literalCount = true;
    else if (entry.unit === "pizza") quantity = counts.pizza;
    else return null;
    explained.add(countIndex(counts.pizza));
  } else if (entry.pizzaCount > 1 && !parsed.markers.has("2for1") && said("pizza") && !parsed.plural.pizza) {
    return null;
  }
  if (counts.wing !== undefined) {
    if (entry.wingCount === counts.wing) literalCount = true;
    else if (entry.unit === "wing") quantity = counts.wing;
    else return null;
    explained.add(countIndex(counts.wing));
  }
  if (counts.lb !== undefined && (entry.nouns.has("wing") || said("wing"))) {
    if (entry.wingLb === counts.lb) literalCount = true;
    else if (entry.unit === "lb") {
      quantity = counts.lb;
      quantityInterpretation = counts.lb !== 1;
    } else return null;
    const at = countIndex(counts.lb);
    if (at >= 0) explained.add(at);
    take("lb");
  }
  if (counts.pop !== undefined) {
    if (entry.popCount === counts.pop && entry.popCount > 0) literalCount = true;
    else if (entry.unit === "pop") quantity = counts.pop;
    else return null;
    explained.add(countIndex(counts.pop));
  }
  if (counts.slice !== undefined) {
    if (entry.sliceCount === counts.slice && entry.sliceCount > 0) literalCount = true;
    else if (entry.unit === "slice") quantity = counts.slice;
    else return null;
    explained.add(countIndex(counts.slice));
  }
  let toppingExact = false;
  const toppingCount = counts.topping ?? (detectedToppings.length ? toppingUnits(detectedToppings) : undefined);
  if (toppingCount !== undefined) {
    if (entry.family === "pizza" && entry.includedToppings !== null) {
      toppingExact = entry.toppingsUpTo ? toppingCount <= entry.includedToppings : toppingCount === entry.includedToppings;
    } else if (entry.family === "bundle") {
      toppingExact = entry.includedToppings === toppingCount || entry.sharedToppings === toppingCount;
    }
    if (counts.topping !== undefined && entry.acceptsToppings) {
      explained.add(countIndex(counts.topping));
      take("topping");
      take("item");
    }
  }
  if (counts.item !== undefined && quantity === null && !literalCount && entry.unit && entry.unit !== "lb") {
    const at = countIndex(counts.item);
    if (at >= 0 && !explained.has(at)) {
      quantity = counts.item;
      explained.add(at);
    }
  }
  if (entry.family === "wings" && tokens.includes("dollar")) take("dollar");

  const unrequestedNameMarkers = [...entry.nameMarkers].filter((marker) => !parsed.markers.has(marker)).length;
  const unrequestedPizzas = entry.pizzaCount > 1 && counts.pizza === undefined && !parsed.markers.has("2for1") && !parsed.plural.pizza;

  const unexplained = tokens.map((_, at) => at).filter((at) => !explained.has(at));
  return {
    entry,
    strength,
    unexplained,
    named,
    quantityInterpretation,
    literalCount,
    toppingExact,
    unrequestedNameMarkers,
    unrequestedPizzas,
    distinctiveMatched,
    sizeResolved,
    quantity,
    detected: { toppings: detectedToppings, omitToppings: omitted, extraCheese, options: optionMatches.map((match) => ({ sectionId: match.value.sectionId, value: match.value.value })) },
  };
}

function toCandidate(evaluation: Evaluation | Rejection, reason?: MenuCandidate["unavailableReason"]): MenuCandidate {
  const { entry } = evaluation;
  const resolved = "sizeResolved" in evaluation ? evaluation.sizeResolved : null;
  const variation = resolved && entry.variationBySize.has(resolved)
    ? entry.variationBySize.get(resolved) ?? null
    : entry.product.variations.length === 1
      ? entry.product.variations[0]
      : null;
  const stateReason = entry.state === "available" ? null : entry.state;
  const unavailableReason = reason ?? stateReason;
  return {
    productId: entry.product.id,
    name: entry.product.name,
    category: entry.product.categoryName,
    kind: entry.family,
    variationId: variation?.id ?? null,
    variationName: variation?.name ?? null,
    sizes: entry.product.variations.length > 1
      ? entry.product.variations.map((option) => ({ variationId: option.id, name: option.name, priceCents: option.basePriceCents }))
      : [],
    priceCents: variation?.basePriceCents ?? entry.product.basePriceCents,
    fulfilments: entry.fulfilments,
    available: unavailableReason === null,
    unavailableReason,
    availabilityLabel: entry.availabilityLabel,
    suggestedQuantity: "quantity" in evaluation ? evaluation.quantity : null,
    detected: "detected" in evaluation ? evaluation.detected : { toppings: [], omitToppings: [], extraCheese: false, options: [] },
  };
}

const SIZE_NAMES: Record<Size, string> = { medium: "Medium", large: "Large", xl: "X-Large", jumbo: "Jumbo", slab: "Slab" };

function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** The question that tells the candidates apart, in the caller's terms. */
function clarifyFor(entries: IndexedProduct[]): string {
  const pizzas = entries.every((entry) => entry.family === "pizza");
  const sizes = new Set(entries.flatMap((entry) => entry.sizes));
  const fulfilments = new Set(entries.map((entry) => entry.fulfilments.join(",")));
  if (pizzas && sizes.size > 1) {
    return `What size: ${listPhrase(SIZE_WORDS.filter((size) => sizes.has(size)).map((size) => SIZE_NAMES[size]))}?`;
  }
  if (pizzas && fulfilments.size > 1) return "Is that for pickup or delivery?";
  return `Did you mean ${listPhrase([...new Set(entries.map((entry) => entry.product.name))])}?`;
}

/**
 * Resolves one spoken item against the menu.
 *
 * `fulfilment` filters to what can be ordered that way; when it is unknown, a
 * product that exists separately for pickup and delivery stays ambiguous.
 * `category` (an id) narrows the search to one menu section.
 */
export function resolveMenuQuery(
  index: MenuIndex,
  query: string,
  options: { fulfilment?: Fulfilment | null; category?: string | null } = {},
): MenuResolution {
  const rawTokens = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const tokens = normalizeWords(query);
  const base = { query, candidates: [], clarify: null, unrecognized: [], ambiguousToppings: [] };
  if (!tokens.length || tokens.every((token) => STOPWORDS.has(token) || token in FULFILMENT_WORDS)) {
    return { ...base, status: "no_match", clarify: "What would you like to order?" };
  }
  const parsed = parseQuery(tokens, rawTokens);
  const fulfilment = options.fulfilment ?? parsed.fulfilment ?? null;

  const toppingSpans = findPhrases(tokens, [
    ...index.toppings.map((topping) => ({ tokens: topping.tokens, value: { ids: [topping.id] } })),
    ...[...index.toppingWords].map(([word, ids]) => ({ tokens: [word], value: { ids } })),
  ]);
  const ambiguousToppings = toppingSpans
    .filter((span) => span.value.ids.length > 1)
    .map((span) => ({
      word: tokens.slice(span.start, span.end).join(" "),
      options: span.value.ids.map((id) => index.toppings.find((topping) => topping.id === id)?.name ?? id),
    }));

  const evaluations: Evaluation[] = [];
  const sizeRejections: Rejection[] = [];
  for (const entry of index.products) {
    if (options.category && entry.product.categoryId !== options.category) continue;
    const result = evaluate(entry, parsed, index, toppingSpans);
    if (!result) continue;
    if ("reason" in result) sizeRejections.push(result);
    else evaluations.push(result);
  }

  // One listing per real item.
  const canonical = <T extends { entry: IndexedProduct }>(list: T[]) =>
    list.filter((item) => !item.entry.duplicateOf || !list.some((other) => other.entry.product.id === item.entry.duplicateOf));
  const fits = (evaluation: Evaluation) => !fulfilment || evaluation.entry.fulfilments.includes(fulfilment);
  const clean = (evaluation: Evaluation) => evaluation.unexplained.length === 0;
  const eligible = canonical(evaluations.filter(fits));
  let strong = eligible.filter((evaluation) => clean(evaluation) && evaluation.strength === "strong" && !evaluation.quantityInterpretation);

  const ambiguous = (list: Evaluation[], unrecognized: string[] = []): MenuResolution => ({
    ...base,
    status: "ambiguous",
    candidates: list.slice(0, 8).map((evaluation) => toCandidate(evaluation)),
    clarify: clarifyFor(list.map((evaluation) => evaluation.entry)),
    unrecognized,
    ambiguousToppings,
  });

  if (!strong.length) {
    // Exactly what was asked for exists, just not for this fulfilment: say so.
    const otherWay = canonical(evaluations.filter((evaluation) => !fits(evaluation) && clean(evaluation) && evaluation.strength === "strong"));
    if (otherWay.length) {
      return {
        ...base,
        status: "unavailable",
        candidates: otherWay.map((evaluation) => toCandidate(evaluation, "not_for_fulfilment")),
        clarify: `That is only available for ${fulfilment === "delivery" ? "pickup" : "delivery"}.`,
        ambiguousToppings,
      };
    }
    if (parsed.unofferedSize) {
      return {
        ...base,
        status: "no_match",
        clarify: `We don't have a ${parsed.unofferedSize} size. Pizzas come in ${listPhrase(SIZE_WORDS.map((size) => SIZE_NAMES[size]))}.`,
        unrecognized: [parsed.unofferedSize],
        ambiguousToppings,
      };
    }
    // A product named outright, in a size it does not come in.
    const sized = canonical(sizeRejections.filter((rejection) => rejection.named));
    if (sized.length) {
      const offeredSizes = [...new Set(sized.flatMap((rejection) => rejection.entry.sizes))].map((size) => SIZE_NAMES[size]);
      return {
        ...base,
        status: "unavailable",
        candidates: sized.slice(0, 8).map((rejection) => toCandidate(rejection, "size_not_offered")),
        clarify: offeredSizes.length ? `That size isn't available. Sizes: ${listPhrase(offeredSizes)}.` : "That size isn't available.",
        ambiguousToppings,
      };
    }
    // Something the caller named, but not all of what they said: offer it, never
    // pick it. A product matched only in part *and* surrounded by unexplained
    // words ("chicken burger" against Chicken BBQ Pizza) is not offered at all.
    const offered = eligible
      .filter((evaluation) => evaluation.named && (evaluation.strength === "strong" || clean(evaluation)))
      .sort((a, b) => a.unexplained.length - b.unexplained.length || b.distinctiveMatched - a.distinctiveMatched);
    if (offered.length) {
      const fewest = offered[0].unexplained.length;
      const shortlist = offered.filter((evaluation) => evaluation.unexplained.length === fewest);
      return ambiguous(shortlist, [...new Set(shortlist.flatMap((evaluation) => evaluation.unexplained.map((at) => tokens[at])))]);
    }
    const unrecognized = tokens.filter((token) => !STOPWORDS.has(token) && !(token in FULFILMENT_WORDS));
    return { ...base, status: "no_match", unrecognized, ambiguousToppings };
  }

  // "shawarma" names a pizza, a poutine and a sub. Unless the caller said
  // pizza (or a size), the sides sharing the word are just as likely.
  const saidPizza = parsed.nouns.some((noun) => noun.noun === "pizza") || parsed.sizes.some((size) => !size.mayBeFlavour);
  const specialties = strong.filter((evaluation) => evaluation.entry.family === "specialty");
  if (!saidPizza && specialties.length) {
    const words = new Set(specialties.flatMap((evaluation) => evaluation.entry.distinctive.filter((word) => tokens.includes(word))));
    const rivals = eligible.filter((evaluation) =>
      evaluation.entry.family === "item" && clean(evaluation) && evaluation.entry.distinctive.some((word) => words.has(word)),
    );
    if (rivals.length) return ambiguous([...specialties, ...rivals]);
  }

  // "large chicken pizza": a pizza with chicken on it, or one of the chicken
  // specialties. The caller has not said which.
  const toppingWordsSaid = new Set(toppingSpans.flatMap((span) => tokens.slice(span.start, span.end)));
  if (strong.every((evaluation) => evaluation.entry.family === "pizza")) {
    const rivals = eligible.filter((evaluation) =>
      evaluation.entry.family === "specialty" && evaluation.strength === "weak" && clean(evaluation) &&
      evaluation.entry.distinctive.some((word) => toppingWordsSaid.has(word)),
    );
    if (rivals.length) return ambiguous([...strong, ...rivals]);
  }
  // "large pizza with meatballs": the Meatball Pizza, or a pizza with meatballs
  // on it. A specialty whose name is only topping words, said after "pizza",
  // reads as a topping list as much as a name.
  const pizzaAt = tokens.findIndex((token) => NOUN_SYNONYMS[token] === "pizza");
  const listedAsTopping = (evaluation: Evaluation) =>
    evaluation.entry.family === "specialty" && pizzaAt >= 0 &&
    evaluation.entry.distinctive.every((word) => toppingWordsSaid.has(word) && tokens.indexOf(word) > pizzaAt);
  if (strong.some(listedAsTopping) && strong.some((evaluation) => evaluation.entry.family === "pizza")) {
    return ambiguous(strong.filter((evaluation) => evaluation.entry.family === "pizza" || listedAsTopping(evaluation)));
  }

  // Narrowings: each one drops a reading the caller gave no sign of, and only
  // ever narrows — if it would remove everything, it is not applied.
  const narrow = (keep: (evaluation: Evaluation) => boolean) => {
    const kept = strong.filter(keep);
    if (kept.length) strong = kept;
  };
  const fullyNamed = (evaluation: Evaluation) =>
    evaluation.entry.distinctive.length > 0 && evaluation.distinctiveMatched === evaluation.entry.distinctive.length;
  // A product named outright beats building one from toppings and sauces.
  if (strong.some(fullyNamed)) narrow(fullyNamed);
  // A combo the caller did not ask for, by name ("Slice Combo" for "a slice").
  narrow((evaluation) => evaluation.unrequestedNameMarkers === 0);
  // Two pizzas when the caller said one.
  narrow((evaluation) => !evaluation.unrequestedPizzas);
  // No count said: the single, not the multiple ("a pop", "slice combo").
  if (parsed.counts.pop === undefined) narrow((evaluation) => evaluation.entry.family !== "drink" || evaluation.entry.popCount <= 1);
  if (parsed.counts.slice === undefined) narrow((evaluation) => evaluation.entry.family !== "slice" || evaluation.entry.sliceCount <= 1);
  // "4 pops" is the 4-pack, not four single pops. A deal is never chosen this
  // way: "2 large pizzas" may be two pizzas or the 2-for-1, and that is asked.
  const literalSingle = (evaluation: Evaluation) => evaluation.literalCount && evaluation.entry.family !== "bundle";
  if (strong.some(literalSingle)) narrow((evaluation) => literalSingle(evaluation) || evaluation.quantity === null && evaluation.entry.family !== "bundle");
  // The pizza or bundle whose included toppings are what was asked for.
  if (parsed.counts.topping !== undefined || strong.every((evaluation) => evaluation.entry.family === "pizza")) {
    narrow((evaluation) => evaluation.toppingExact);
  }

  if (strong.length === 1) {
    const only = strong[0];
    const candidate = toCandidate(only);
    return {
      ...base,
      status: candidate.available ? "match" : "unavailable",
      candidates: [candidate],
      clarify: candidate.available
        ? null
        : only.entry.state === "outside_offer_hours"
          ? `${only.entry.product.name} is only available ${only.entry.availabilityLabel ?? "at certain times"}.`
          : `${only.entry.product.name} is not available right now.`,
      ambiguousToppings,
    };
  }
  return ambiguous(strong);
}

/** Builds the index from the live menu and resolves one query. */
export async function searchMenu(
  query: string,
  options: { fulfilment?: Fulfilment | null; category?: string | null; now?: number } = {},
): Promise<MenuResolution> {
  return resolveMenuQuery(buildMenuIndex(await loadVoiceCatalog(), { now: options.now }), query, options);
}

// --- pickup and delivery equivalents ---------------------------------------------

/**
 * The same build-your-own pizza for the other fulfilment, when exactly one
 * exists.
 *
 * Pizza by Size is delivery only and the pickup pizzas are separate products
 * (`Large Pizza · 1 Item`, `· 3 Items`), so "actually make it pickup" is a
 * product change, not a flag. The equivalent must be the same size and, going
 * to pickup, include exactly the topping units the pizza already has; anything
 * else is the caller's choice to make, so it is returned as `null`.
 */
export function equivalentPizzaFor(
  index: MenuIndex,
  productId: string,
  target: Fulfilment,
  toppingUnits: number,
): string | null {
  const source = index.products.find((entry) => entry.product.id === productId);
  if (!source || source.family !== "pizza" || source.sizes.length !== 1) return null;
  const size = source.sizes[0];
  const options = index.products.filter((entry) =>
    entry.family === "pizza" && !entry.duplicateOf && entry.fulfilments.includes(target) &&
    entry.sizes.length === 1 && entry.sizes[0] === size && entry.product.id !== productId && entry.state === "available",
  );
  const fitting = options.filter((entry) =>
    entry.includedToppings !== null && (entry.toppingsUpTo ? toppingUnits <= entry.includedToppings : toppingUnits === entry.includedToppings),
  );
  return fitting.length === 1 ? fitting[0].product.id : null;
}

/** The product a listed duplicate collapses onto, or itself. */
export function canonicalProductId(index: MenuIndex, productId: string): string {
  return index.products.find((entry) => entry.product.id === productId)?.duplicateOf ?? productId;
}
