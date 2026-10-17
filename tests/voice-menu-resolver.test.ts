/**
 * The deterministic voice menu resolver against the real menu (Phase 2A).
 *
 * The golden phrases below are what callers say at Pizza 62, each with the
 * outcome written out by hand from the menu itself — product and variation ids
 * are spelled out, never read back from the resolver. The acceptance rule is
 * the project's:
 *
 *   WRONG ID = FAILURE      CLARIFICATION = SUCCESS
 *
 * so every phrase must either resolve to exactly its expected product or come
 * back `ambiguous` / `no_match` / `unavailable` as specified. A `refuse`
 * expectation accepts any of those three — used for phrases where the only
 * wrong answer is a confident match. A summary of the outcome counts is
 * printed at the end, and the number of confidently wrong answers must be 0.
 *
 * The catalogue is the live one from the test database (seeded from
 * lib/menu.ts), through the same `loadPublicCatalog` the website uses. The
 * clock is fixed: a Wednesday evening unless a case says otherwise, so
 * time-limited items behave the same on every run.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { MENU_PRODUCTS } = await import("@/lib/menu");
const { DRINK_OPTIONS } = await import("@/lib/domain");
const { buildMenuIndex, loadVoiceCatalog, normalizeWords, PHRASE_ALIASES, resolveMenuQuery, equivalentPizzaFor } = await import(
  "@/lib/voice/menu-index"
);

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);
after(async () => {
  await closePool();
});

type Fulfilment = "pickup" | "delivery";
type When = "wed_evening" | "wed_afternoon" | "mon_evening";
const INSTANTS: Record<When, number> = {
  wed_evening: Date.parse("2026-10-14T18:00:00-04:00"),
  wed_afternoon: Date.parse("2026-10-14T14:00:00-04:00"),
  mon_evening: Date.parse("2026-10-12T18:00:00-04:00"),
};

type Expectation =
  | { status: "match"; productId: string; variationId?: string | null; quantity?: number; toppings?: Array<[string, string]>; omit?: string[]; option?: string; extraCheese?: boolean; cheese?: "none" | "light" | "extra" | null }
  | { status: "ambiguous"; includes?: string[] }
  | { status: "no_match" }
  | { status: "unavailable"; productId: string; reason: string }
  | { status: "refuse" };

type Golden = { query: string; fulfilment?: Fulfilment; when?: When; group: string; expect: Expectation };

const g = (group: string) => ({
  m: (query: string, productId: string, extra: Omit<Extract<Expectation, { status: "match" }>, "status" | "productId"> & { fulfilment?: Fulfilment; when?: When } = {}): Golden => {
    const { fulfilment, when, ...rest } = extra;
    return { group, query, fulfilment, when, expect: { status: "match", productId, ...rest } };
  },
  a: (query: string, extra: { includes?: string[]; fulfilment?: Fulfilment; when?: When } = {}): Golden =>
    ({ group, query, fulfilment: extra.fulfilment, when: extra.when, expect: { status: "ambiguous", includes: extra.includes } }),
  n: (query: string, extra: { fulfilment?: Fulfilment; when?: When } = {}): Golden => ({ group, query, ...extra, expect: { status: "no_match" } }),
  u: (query: string, productId: string, reason: string, extra: { fulfilment?: Fulfilment; when?: When } = {}): Golden =>
    ({ group, query, ...extra, expect: { status: "unavailable", productId, reason } }),
  r: (query: string, extra: { fulfilment?: Fulfilment; when?: When } = {}): Golden => ({ group, query, ...extra, expect: { status: "refuse" } }),
});

const specialty = g("specialty pizzas");
const byo = g("build-your-own pizzas");
const deals = g("deals, combos and 2 for 1");
const wings = g("wings");
const slices = g("slices");
const drinks = g("drinks");
const sides = g("sides, extras and desserts");
const offMenu = g("not on the public menu");
const forms = g("spoken forms, case, punctuation");

const GOLDEN: Golden[] = [
  // --- specialty pizzas: every recipe, sizes, omissions -----------------------------
  specialty.m("large hawaiian", "specialty-hawaiian", { variationId: "specialty-hawaiian-large", fulfilment: "pickup" }),
  specialty.m("hawaiian pizza", "specialty-hawaiian", { variationId: null, fulfilment: "delivery" }),
  specialty.m("a medium hawaiian", "specialty-hawaiian", { variationId: "specialty-hawaiian-medium" }),
  specialty.m("xl hawaiian", "specialty-hawaiian", { variationId: "specialty-hawaiian-x-large" }),
  specialty.m("extra large hawaiian pizza", "specialty-hawaiian", { variationId: "specialty-hawaiian-x-large" }),
  specialty.m("x-large canadian", "specialty-canadian", { variationId: "specialty-canadian-x-large" }),
  specialty.m("Canadian", "specialty-canadian"),
  specialty.m("large deluxe", "specialty-deluxe", { variationId: "specialty-deluxe-large" }),
  specialty.m("all meat pizza", "specialty-all-meat"),
  specialty.m("large all meat", "specialty-all-meat", { variationId: "specialty-all-meat-large" }),
  specialty.m("mexicana", "specialty-mexicana"),
  specialty.m("mexican pizza", "specialty-mexicana"),
  specialty.m("veggie pizza", "specialty-vegetarian"),
  specialty.m("vegetarian", "specialty-vegetarian"),
  specialty.m("large veggie", "specialty-vegetarian", { variationId: "specialty-vegetarian-large" }),
  specialty.m("pizza 62 special", "specialty-pizza-62-special"),
  specialty.m("the 62 special", "specialty-pizza-62-special"),
  specialty.m("medium 62 special", "specialty-pizza-62-special", { variationId: "specialty-pizza-62-special-medium" }),
  specialty.m("greek pizza", "specialty-greek"),
  specialty.m("large greek", "specialty-greek", { variationId: "specialty-greek-large" }),
  specialty.m("greek", "specialty-greek"),
  specialty.m("chicken bbq pizza", "specialty-chicken-bbq"),
  specialty.m("bbq chicken pizza", "specialty-chicken-bbq"),
  specialty.m("BBQ chicken", "specialty-chicken-bbq"),
  specialty.m("large barbecue chicken pizza", "specialty-chicken-bbq", { variationId: "specialty-chicken-bbq-large" }),
  specialty.m("mediterranean", "specialty-mediterranean"),
  specialty.m("x large mediterranean pizza", "specialty-mediterranean", { variationId: "specialty-mediterranean-x-large" }),
  specialty.m("butter chicken pizza", "specialty-butter-chicken"),
  specialty.m("large butter chicken", "specialty-butter-chicken", { variationId: "specialty-butter-chicken-large" }),
  specialty.m("meatball pizza", "specialty-meatball"),
  specialty.m("shawarma pizza", "specialty-shawarma"),
  specialty.m("medium shawarma pizza", "specialty-shawarma", { variationId: "specialty-shawarma-medium" }),
  specialty.m("hawaiian no ham", "specialty-hawaiian", { omit: ["ham"] }),
  specialty.m("large deluxe without onions", "specialty-deluxe", { variationId: "specialty-deluxe-large", omit: ["onions"] }),
  specialty.m("canadian hold the mushrooms", "specialty-canadian", { omit: ["mushrooms"] }),
  specialty.m("large hawaiian with extra pepperoni", "specialty-hawaiian", { variationId: "specialty-hawaiian-large", toppings: [["pepperoni", "whole"]] }),
  specialty.u("jumbo hawaiian", "specialty-hawaiian", "size_not_offered"),
  specialty.u("slab canadian", "specialty-canadian", "size_not_offered"),
  specialty.a("chicken pizza"),
  specialty.a("bbq pizza"),
  specialty.a("shawarma", { includes: ["specialty-shawarma", "shawarma-poutine", "shawarma-sub"] }),
  specialty.a("meatball", { includes: ["specialty-meatball", "meatball-sub"] }),
  specialty.m("2 large hawaiians", "specialty-hawaiian", { variationId: "specialty-hawaiian-large", quantity: 2 }),
  specialty.r("medium hawaiian and large pepperoni"),
  specialty.r("large hawaiian and fries"),
  specialty.r("meat lovers pizza"),
  specialty.r("supreme pizza"),

  // --- build-your-own: pickup and delivery are different products ------------------
  byo.m("large pepperoni", "pickup-large-one", { fulfilment: "pickup", variationId: "pickup-large-one-size", toppings: [["pepperoni", "whole"]] }),
  byo.m("large pepperoni", "large-pizza", { fulfilment: "delivery", variationId: "large-pizza-four-toppings" }),
  byo.a("large pepperoni", { includes: ["large-pizza", "pickup-large-one"] }),
  byo.m("lg pep", "pickup-large-one", { fulfilment: "pickup" }),
  byo.m("large roni", "large-pizza", { fulfilment: "delivery" }),
  byo.m("large pepperoni pizza", "large-pizza", { fulfilment: "delivery" }),
  byo.m("medium pepperoni", "pickup-medium-one", { fulfilment: "pickup" }),
  byo.m("medium cheese pizza", "medium-pizza", { fulfilment: "delivery" }),
  byo.m("xl pepperoni", "pickup-xl-one", { fulfilment: "pickup" }),
  byo.m("extra large pepperoni pizza", "x-large-pizza", { fulfilment: "delivery" }),
  byo.m("x-large pizza", "x-large-pizza", { fulfilment: "delivery" }),
  byo.m("jumbo pizza", "jumbo-pizza", { fulfilment: "delivery" }),
  byo.m("jumbo pepperoni", "pickup-jumbo-one", { fulfilment: "pickup" }),
  byo.m("slab pizza", "slab-pizza", { fulfilment: "delivery" }),
  byo.m("slab pepperoni", "pickup-slab-one", { fulfilment: "pickup" }),
  byo.m("large pizza with pepperoni mushrooms and green peppers", "pickup-large-three", {
    fulfilment: "pickup",
    toppings: [["pepperoni", "whole"], ["mushrooms", "whole"], ["green-peppers", "whole"]],
  }),
  byo.m("large pepperoni mushroom and onion", "pickup-large-three", { fulfilment: "pickup" }),
  byo.m("large three topping pizza", "pickup-large-three", { fulfilment: "pickup" }),
  byo.m("large 3 topping", "pickup-large-three", { fulfilment: "pickup" }),
  byo.m("large one topping pizza", "pickup-large-one", { fulfilment: "pickup" }),
  byo.m("medium 3 item", "pickup-medium-three", { fulfilment: "pickup" }),
  byo.a("large pizza", { fulfilment: "pickup", includes: ["pickup-large-one", "pickup-large-three"] }),
  byo.m("large pizza", "large-pizza", { fulfilment: "delivery" }),
  byo.a("large pepperoni and mushroom", { fulfilment: "pickup", includes: ["pickup-large-one", "pickup-large-three"] }),
  byo.m("large pepperoni and mushroom", "large-pizza", { fulfilment: "delivery" }),
  byo.m("medium five topping", "pickup-medium-five", { fulfilment: "pickup" }),
  byo.m("medium 5 toppings", "pickup-medium-five", { fulfilment: "pickup" }),
  byo.m("medium pizza 5 toppings", "medium-pizza", { fulfilment: "delivery" }),
  byo.a("pepperoni pizza", { fulfilment: "pickup" }),
  byo.a("cheese pizza", { fulfilment: "delivery" }),
  byo.a("a pizza"),
  byo.m("large half pepperoni half mushroom", "large-pizza", {
    fulfilment: "delivery",
    toppings: [["pepperoni", "left"], ["mushrooms", "right"]],
  }),
  byo.m("large pizza half pepperoni", "large-pizza", { fulfilment: "delivery", toppings: [["pepperoni", "left"]] }),
  byo.m("large pizza pepperoni on the right", "large-pizza", { fulfilment: "delivery", toppings: [["pepperoni", "right"]] }),
  byo.m("large pizza extra cheese", "large-pizza", { fulfilment: "delivery", extraCheese: true }),
  byo.a("large chicken pizza", { fulfilment: "delivery" }),
  byo.m("large pizza with jalapenos", "large-pizza", { fulfilment: "delivery", toppings: [["jalapenos", "whole"]] }),
  byo.m("large pizza with ham and pineapple", "large-pizza", { fulfilment: "delivery" }),
  byo.a("large pizza with meatballs", { fulfilment: "delivery", includes: ["large-pizza", "specialty-meatball"] }),
  byo.m("large pizza thin crust", "large-pizza", { fulfilment: "delivery", option: "Thin Crust" }),
  byo.m("large pepperoni well done", "large-pizza", { fulfilment: "delivery", option: "Well Done" }),
  // The cheese step and the bake & sauce choices as callers say them (website parity).
  byo.m("large pizza no cheese", "large-pizza", { fulfilment: "delivery", cheese: "none", extraCheese: false }),
  byo.m("large pepperoni light cheese", "large-pizza", { fulfilment: "delivery", cheese: "light", toppings: [["pepperoni", "whole"]] }),
  byo.m("large pizza easy on the cheese", "large-pizza", { fulfilment: "delivery", cheese: "light" }),
  byo.m("large pizza double cheese", "large-pizza", { fulfilment: "delivery", cheese: "extra", extraCheese: true }),
  byo.m("large pizza hold the cheese", "large-pizza", { fulfilment: "delivery", cheese: "none" }),
  byo.m("large pizza with feta cheese", "large-pizza", { fulfilment: "delivery", cheese: null, toppings: [["feta-cheese", "whole"]] }),
  byo.m("large pepperoni light sauce", "large-pizza", { fulfilment: "delivery", option: "Easy on the Sauce" }),
  byo.m("large pepperoni light on the sauce", "large-pizza", { fulfilment: "delivery", option: "Easy on the Sauce" }),
  byo.m("large pepperoni extra sauce", "large-pizza", { fulfilment: "delivery", option: "Extra Sauce" }),
  byo.m("large pepperoni thick", "large-pizza", { fulfilment: "delivery", option: "Thick Crust" }),
  byo.m("large pizza mushrooms only on the right half", "large-pizza", { fulfilment: "delivery", toppings: [["mushrooms", "right"]] }),
  specialty.m("large hawaiian no cheese", "specialty-hawaiian", { variationId: "specialty-hawaiian-large", fulfilment: "pickup", cheese: "none" }),
  specialty.m("large hawaiian lightly baked", "specialty-hawaiian", { variationId: "specialty-hawaiian-large", fulfilment: "pickup", option: "Lightly Done" }),
  byo.m("large build your own pizza", "large-pizza", { fulfilment: "delivery" }),
  byo.n("small pizza"),
  byo.n("personal pizza", { fulfilment: "pickup" }),
  byo.a("2 large pepperoni pizzas", { fulfilment: "delivery", includes: ["large-pizza", "two-for-one-large"] }),
  byo.a("two large pizzas", { fulfilment: "pickup" }),
  byo.m("1 medium pizza", "medium-pizza", { fulfilment: "delivery" }),

  // --- deals, combos, 2 for 1 -----------------------------------------------------
  deals.m("2 large pizzas and 3 pounds of wings", "deal-two-large-wings"),
  deals.m("two large pizzas and wings", "deal-two-large-wings"),
  deals.m("2 medium pizzas and 2 lb wings", "deal-two-medium-wings"),
  deals.m("two x-large pizzas and three pounds of wings", "deal-two-xl-wings"),
  deals.m("2 xl pizzas and wings deal", "deal-two-xl-wings"),
  // Two different deals are two large pizzas: the one with wings, and the pickup six-topping special.
  deals.a("2 large pizza deal", { includes: ["deal-two-large-wings", "pickup-two-large-six"] }),
  deals.m("large pizza and 3 pounds of wings", "combo-large"),
  deals.a("large pizza and wings", { includes: ["combo-large", "pickup-large-wings"] }),
  deals.m("jumbo pizza and wings", "combo-jumbo"),
  deals.m("slab pizza and wings", "combo-slab"),
  deals.m("medium pizza and 12 wings", "combo-medium"),
  deals.m("medium pizza and wings", "combo-medium"),
  deals.m("xl pizza and 3 lb wings", "combo-xl"),
  deals.m("jumbo combo", "combo-jumbo"),
  deals.m("large combo", "combo-large"),
  deals.m("slab combo", "combo-slab"),
  deals.a("combo", { includes: ["combo-jumbo", "combo-large", "combo-medium", "combo-slab", "combo-xl"] }),
  deals.m("2 for 1 large", "two-for-one-large"),
  deals.m("two for one jumbo pizzas", "two-for-one-jumbo"),
  deals.m("2 for 1 medium", "two-for-one-medium"),
  deals.m("buy one get one slab", "two-for-one-slab"),
  deals.m("2 for 1 xl", "two-for-one-xl"),
  deals.a("2 for 1", { includes: ["two-for-one-large", "two-for-one-medium"] }),
  deals.m("large pizza wings and pop", "pickup-large-wings"),
  deals.m("large pizza 1 pound wings and 3 pops", "pickup-large-wings"),
  deals.m("two large pizzas six toppings", "pickup-two-large-six", { fulfilment: "pickup" }),
  deals.m("2 large 6 toppings shared", "pickup-two-large-six", { fulfilment: "pickup" }),
  deals.u("2 large pizzas 6 toppings shared", "pickup-two-large-six", "not_for_fulfilment", { fulfilment: "delivery" }),
  deals.m("hamilton heroes", "hamilton-hero-deal"),
  deals.m("heroes deal", "hamilton-hero-deal"),
  deals.m("hamilton hero offer", "hamilton-hero-deal"),
  deals.u("hamilton heroes", "hamilton-hero-deal", "outside_offer_hours", { when: "wed_afternoon" }),
  deals.r("game day special"),
  deals.r("family deal"),
  deals.a("deal"),
  deals.a("large pizza deal"),
  deals.a("pickup special"),

  // --- wings ------------------------------------------------------------------------
  wings.m("24 wings", "24-wings"),
  wings.m("twenty four wings", "24-wings"),
  wings.m("two dozen wings", "24-wings"),
  wings.m("30 wings", "30-wings"),
  wings.m("thirty chicken wings", "30-wings"),
  wings.m("40 wings", "40-wings"),
  wings.m("fifty wings", "50-wings"),
  wings.m("60 wings", "60-wings"),
  wings.m("a pound of wings", "1-lb-wings", { fulfilment: "pickup" }),
  wings.m("1 lb wings", "1-lb-wings", { fulfilment: "delivery" }),
  wings.m("one pound wings", "1-lb-wings"),
  wings.m("pound of honey garlic wings", "1-lb-wings", { option: "Honey Garlic" }),
  wings.m("24 medium wings", "24-wings", { option: "Medium" }),
  wings.m("24 hot wings", "24-wings", { option: "Hot" }),
  wings.m("30 breaded wings", "30-wings", { option: "Breaded" }),
  wings.m("1 lb lemon pepper wings", "1-lb-wings", { option: "Lemon Pepper" }),
  wings.a("wings"),
  wings.a("chicken wings"),
  wings.a("3 pounds of wings", { includes: ["1-lb-wings"] }),
  wings.a("2 lb wings", { includes: ["1-lb-wings"] }),
  wings.n("12 wings"),
  wings.n("a dozen wings"),
  wings.u("dollar wings", "monday-dollar-wings", "outside_offer_hours"),
  wings.m("$1 wings", "monday-dollar-wings", { when: "mon_evening", fulfilment: "pickup" }),
  wings.m("monday wings", "monday-dollar-wings", { when: "mon_evening", fulfilment: "pickup" }),
  wings.u("dollar wings", "monday-dollar-wings", "not_for_fulfilment", { when: "mon_evening", fulfilment: "delivery" }),
  wings.r("labor day wings"),
  wings.m("24 wings hot and mild", "24-wings", { option: "Hot" }),
  wings.r("30 wings and a large pizza"),
  wings.r("pop and wings"),

  // --- slices -------------------------------------------------------------------------
  slices.m("a slice", "pickup-one-slice", { fulfilment: "pickup" }),
  slices.m("slice of pepperoni", "pickup-one-slice", { fulfilment: "pickup", toppings: [["pepperoni", "whole"]] }),
  slices.m("pepperoni slice", "pickup-one-slice", { fulfilment: "pickup" }),
  slices.m("slice combo", "slice-combo", { fulfilment: "pickup" }),
  slices.m("2 slice combo", "two-slice-combo", { fulfilment: "pickup" }),
  slices.m("two slice combo", "two-slice-combo", { fulfilment: "pickup" }),
  slices.m("two slices", "pickup-one-slice", { fulfilment: "pickup", quantity: 2 }),
  slices.u("slice", "pickup-one-slice", "not_for_fulfilment", { fulfilment: "delivery" }),

  // --- drinks ---------------------------------------------------------------------------
  drinks.m("a pop", "one-pop"),
  drinks.m("can of pop", "one-pop"),
  drinks.m("soda", "one-pop"),
  drinks.m("a coke", "one-pop", { option: "Coke" }),
  drinks.m("diet pepsi", "one-pop", { option: "Diet Pepsi" }),
  drinks.m("2 pops", "one-pop", { quantity: 2 }),
  drinks.m("4 pops", "four-pops"),
  drinks.m("four cans of pop", "four-pops"),
  drinks.m("water", "water-bottle"),
  drinks.m("bottle of water", "water-bottle"),
  drinks.m("dr pepper", "one-pop", { option: "Dr Pepper" }),
  drinks.m("root beer", "one-pop", { option: "Root Beer" }),
  drinks.m("a ginger ale", "one-pop", { option: "Canada Dry" }),
  drinks.r("2 litre coke"),
  drinks.a("drinks", { includes: ["one-pop", "water-bottle"] }),

  // --- sides, extras, desserts ------------------------------------------------------------
  sides.m("fries", "fries"),
  sides.m("masala fries", "masala-fries"),
  sides.m("poutine", "poutine"),
  sides.m("samosa poutine", "samosa-poutine"),
  sides.m("shawarma poutine", "shawarma-poutine"),
  sides.m("garlic bread", "garlic-bread"),
  sides.m("garlic bread with cheese", "garlic-bread-cheese"),
  sides.m("cheesy garlic bread", "garlic-bread-cheese"),
  sides.m("mozzarella sticks", "mozzarella-sticks"),
  sides.m("mozza sticks", "mozzarella-sticks"),
  sides.m("onion rings", "onion-rings"),
  sides.m("rings", "onion-rings"),
  sides.m("wedges", "wedges"),
  sides.m("potato wedges", "wedges"),
  sides.m("jalapeno poppers", "stuffed-jalapenos"),
  sides.m("jalapenos", "stuffed-jalapenos"),
  sides.m("cheesy breadsticks", "cheesy-breadsticks"),
  sides.m("bread sticks", "cheesy-breadsticks"),
  sides.m("meatball sub", "meatball-sub"),
  sides.m("shawarma sub", "shawarma-sub"),
  sides.m("pizza sub", "pizza-three-item-sub"),
  sides.a("sub", { includes: ["meatball-sub", "shawarma-sub", "pizza-three-item-sub"] }),
  sides.m("panzerotti", "panzerotti-three-items"),
  sides.m("panzo", "panzerotti-three-items"),
  sides.m("pepperoni panzerotti", "panzerotti-three-items", { toppings: [["pepperoni", "whole"]] }),
  sides.m("dipping sauce", "standard-dip"),
  sides.m("a dip", "standard-dip"),
  sides.m("salad", "salad"),
  sides.m("greek salad", "salad", { option: "Greek" }),
  sides.m("caesar salad", "salad", { option: "Caesar" }),
  sides.m("brownie", "chocolate-brownie"),
  sides.m("chocolate brownie", "chocolate-brownie"),
  sides.m("2 poutines", "poutine", { quantity: 2 }),
  sides.a("dessert", { includes: ["chocolate-brownie"] }),
  sides.a("bread"),
  sides.a("ranch dip", { includes: ["standard-dip"] }),
  sides.r("large fries"),

  // --- not on the public menu: counter-only, retired, never sold ---------------------
  offMenu.n("chicken burger"),
  offMenu.n("nachos"),
  offMenu.r("buffalo chicken wrap"),
  offMenu.n("chicken fingers"),
  offMenu.r("free garlic bread"),
  offMenu.r("1 dollar medium pizza"),
  offMenu.r("monday special"),
  offMenu.r("tuesday special"),
  offMenu.r("game night deal"),
  offMenu.n("lasagna"),
  offMenu.n("spaghetti"),
  offMenu.n("burger"),
  offMenu.n(""),
  offMenu.n("uh can I get um"),
  offMenu.r("shawarma wrap"),
  offMenu.r("dumplings"),

  // --- spoken forms -------------------------------------------------------------------
  forms.m("HAWAIIAN", "specialty-hawaiian"),
  forms.m("Hawaiian!!!", "specialty-hawaiian"),
  forms.m("large   hawaiian", "specialty-hawaiian", { variationId: "specialty-hawaiian-large" }),
  forms.m("Large Hawaiian, please.", "specialty-hawaiian", { variationId: "specialty-hawaiian-large" }),
  forms.m("can I get a large hawaiian for pickup please", "specialty-hawaiian", { variationId: "specialty-hawaiian-large" }),
  forms.m("uh yeah lemme get a large pep for pick up", "pickup-large-one"),
  forms.m("Pizzas: 2 for 1 — LARGE", "two-for-one-large"),
  forms.m("hawaian", "specialty-hawaiian"),
  forms.m("x large pizza", "x-large-pizza", { fulfilment: "delivery" }),
  forms.m("xlarge hawaiian", "specialty-hawaiian", { variationId: "specialty-hawaiian-x-large" }),
  forms.m("Med. pepperoni", "pickup-medium-one", { fulfilment: "pickup" }),
  forms.m("panzarotti", "panzerotti-three-items"),
  forms.m("Jalapeños", "stuffed-jalapenos"),
  forms.m("garlic-bread", "garlic-bread"),
  forms.m("onion ring", "onion-rings"),
  forms.m("1lb wings", "1-lb-wings"),
  forms.m("24 WINGS!", "24-wings"),
];

// --- running ------------------------------------------------------------------------

const catalog = reachable ? await loadVoiceCatalog() : { products: [], toppings: [] };
const indexes = new Map<When, ReturnType<typeof buildMenuIndex>>();
const indexAt = (when: When) => {
  if (!indexes.has(when)) indexes.set(when, buildMenuIndex(catalog, { now: INSTANTS[when] }));
  return indexes.get(when)!;
};

const STAFF_ONLY = new Set(MENU_PRODUCTS.filter((product) => product.configuration?.staffOnly).map((product) => product.id));

type Outcome = "exact" | "ambiguous" | "no_match" | "unavailable" | "wrong";
const tally: Record<Outcome, number> = { exact: 0, ambiguous: 0, no_match: 0, unavailable: 0, wrong: 0 };
const failures: string[] = [];

function check(golden: Golden): { outcome: Outcome; problems: string[] } {
  const result = resolveMenuQuery(indexAt(golden.when ?? "wed_evening"), golden.query, { fulfilment: golden.fulfilment });
  const problems: string[] = [];
  const ids = result.candidates.map((candidate) => candidate.productId);
  for (const id of ids) if (STAFF_ONLY.has(id)) problems.push(`exposed counter-only product ${id}`);
  const expect = golden.expect;
  const describe = `${result.status}${ids.length ? ` [${ids.join(", ")}]` : ""}`;
  let outcome: Outcome = result.status === "match" ? "exact" : (result.status as Outcome);
  if (expect.status === "match") {
    if (result.status !== "match") problems.push(`expected match ${expect.productId}, got ${describe}`);
    else {
      const [candidate] = result.candidates;
      if (candidate.productId !== expect.productId) {
        problems.push(`WRONG PRODUCT: expected ${expect.productId}, got ${candidate.productId}`);
        outcome = "wrong";
      }
      if (expect.variationId !== undefined && candidate.variationId !== expect.variationId) {
        problems.push(`WRONG VARIATION: expected ${expect.variationId}, got ${candidate.variationId}`);
        outcome = "wrong";
      }
      if (expect.quantity !== undefined && candidate.suggestedQuantity !== expect.quantity) {
        problems.push(`quantity: expected ${expect.quantity}, got ${candidate.suggestedQuantity}`);
      }
      if (expect.toppings) {
        const got = candidate.detected.toppings.map((topping) => [topping.toppingId, topping.placement]);
        if (JSON.stringify(got) !== JSON.stringify(expect.toppings)) problems.push(`toppings: expected ${JSON.stringify(expect.toppings)}, got ${JSON.stringify(got)}`);
      }
      if (expect.omit) {
        const got = candidate.detected.omitToppings.map((topping) => topping.toppingId);
        if (JSON.stringify(got) !== JSON.stringify(expect.omit)) problems.push(`omissions: expected ${JSON.stringify(expect.omit)}, got ${JSON.stringify(got)}`);
      }
      if (expect.option && !candidate.detected.options.some((option) => option.value === expect.option)) {
        problems.push(`option: expected ${expect.option}, got ${JSON.stringify(candidate.detected.options.map((option) => option.value))}`);
      }
      if (expect.extraCheese !== undefined && candidate.detected.extraCheese !== expect.extraCheese) problems.push("extra cheese not detected");
      if (expect.cheese !== undefined && candidate.detected.cheese !== expect.cheese) problems.push(`cheese: expected ${expect.cheese}, got ${candidate.detected.cheese}`);
    }
  } else if (result.status === "match") {
    // A confident answer where the expectation was a question is the failure the
    // whole design exists to prevent, whichever product it picked.
    problems.push(`WRONG: expected ${expect.status}, got a confident match on ${ids[0]}`);
    outcome = "wrong";
  } else if (expect.status === "refuse") {
    // any non-match is correct
  } else if (expect.status !== result.status) {
    problems.push(`expected ${expect.status}, got ${describe}`);
  } else if (expect.status === "ambiguous" && expect.includes) {
    for (const id of expect.includes) if (!ids.includes(id)) problems.push(`ambiguity should offer ${id}, got [${ids.join(", ")}]`);
  } else if (expect.status === "unavailable") {
    if (!ids.includes(expect.productId)) problems.push(`unavailable should name ${expect.productId}, got [${ids.join(", ")}]`);
    if (!result.candidates.some((candidate) => candidate.unavailableReason === expect.reason)) problems.push(`reason should be ${expect.reason}`);
  }
  return { outcome, problems };
}

const label = (golden: Golden) =>
  `[${golden.group}] "${golden.query}"${golden.fulfilment ? ` (${golden.fulfilment})` : ""}${golden.when && golden.when !== "wed_evening" ? ` @${golden.when}` : ""}`;

test(`there are at least 150 golden phrases (${GOLDEN.length})`, () => {
  assert.ok(GOLDEN.length >= 150);
  // Every family on the public menu is covered by at least one phrase.
  const groups = new Set(GOLDEN.map((golden) => golden.group));
  for (const group of ["specialty pizzas", "build-your-own pizzas", "deals, combos and 2 for 1", "wings", "slices", "drinks", "sides, extras and desserts", "not on the public menu"]) {
    assert.ok(groups.has(group), group);
  }
});

for (const golden of GOLDEN) {
  test(label(golden), { skip: reachable ? false : "Postgres is not reachable" }, () => {
    const { outcome, problems } = check(golden);
    tally[outcome] += 1;
    if (problems.length) failures.push(`${label(golden)}: ${problems.join("; ")}`);
    assert.deepEqual(problems, []);
  });
}

test("golden summary: zero confidently wrong products", { skip: reachable ? false : "Postgres is not reachable" }, () => {
  const total = Object.values(tally).reduce((sum, count) => sum + count, 0);
  console.log(
    `\nVoice menu resolver — golden phrases: ${total}\n` +
      `  exact match   ${tally.exact}\n` +
      `  ambiguous     ${tally.ambiguous}\n` +
      `  no match      ${tally.no_match}\n` +
      `  unavailable   ${tally.unavailable}\n` +
      `  WRONG         ${tally.wrong}\n` +
      (failures.length ? `  failures:\n    ${failures.join("\n    ")}\n` : ""),
  );
  assert.equal(tally.wrong, 0);
  assert.equal(total, GOLDEN.length);
});

// --- properties beyond the phrase list ----------------------------------------------

test("the index never contains a counter-only product", { skip: reachable ? false : "Postgres is not reachable" }, () => {
  const index = indexAt("wed_evening");
  assert.ok(index.products.length > 40);
  for (const entry of index.products) assert.ok(!STAFF_ONLY.has(entry.product.id), entry.product.id);
  assert.ok(STAFF_ONLY.size >= 10, "the seed still has counter-only products to exclude");
});

test("offers whose dates have passed are not on the menu at all", { skip: reachable ? false : "Postgres is not reachable" }, () => {
  const ids = indexAt("wed_evening").products.map((entry) => entry.product.id);
  assert.ok(!ids.includes("game-day-special"));
  assert.ok(!ids.includes("labor-day-dollar-wings"));
  assert.ok(ids.includes("monday-dollar-wings"), "a weekly offer stays, flagged by the hour");
});

test("every spoken alias points at a word the live menu actually uses", { skip: reachable ? false : "Postgres is not reachable" }, () => {
  const words = new Set<string>();
  for (const product of catalog.products) {
    for (const token of [...normalizeWords(product.name), ...normalizeWords(product.categoryName), ...normalizeWords(product.categoryId)]) words.add(token);
    for (const section of product.sections) for (const option of section.options ?? []) for (const token of normalizeWords(option)) words.add(token);
  }
  for (const topping of catalog.toppings) for (const token of normalizeWords(topping.name)) words.add(token);
  for (const option of DRINK_OPTIONS) for (const token of normalizeWords(option)) words.add(token);
  for (const [from, to] of PHRASE_ALIASES) {
    for (const token of to) assert.ok(words.has(token), `alias ${from.join(" ")} → ${to.join(" ")} targets "${token}", which nothing on the menu uses`);
  }
});

test("a sold-out, inactive or unconfigured item is never offered as orderable", { skip: reachable ? false : "Postgres is not reachable" }, () => {
  const tweak = (id: string, change: Record<string, unknown>) => ({
    ...catalog,
    products: catalog.products.map((product) => (product.id === id ? { ...product, ...change } : product)),
  });
  const soldOut = resolveMenuQuery(buildMenuIndex(tweak("poutine", { soldOut: true }), { now: INSTANTS.wed_evening }), "poutine");
  assert.equal(soldOut.status, "unavailable");
  assert.equal(soldOut.candidates[0].productId, "poutine");
  assert.equal(soldOut.candidates[0].unavailableReason, "sold_out");

  const hawaiian = resolveMenuQuery(buildMenuIndex(tweak("specialty-hawaiian", { soldOut: true }), { now: INSTANTS.wed_evening }), "large hawaiian");
  assert.equal(hawaiian.status, "unavailable");
  assert.equal(hawaiian.candidates[0].unavailableReason, "sold_out");

  const setup = resolveMenuQuery(buildMenuIndex(tweak("24-wings", { setupRequired: true }), { now: INSTANTS.wed_evening }), "24 wings");
  assert.equal(setup.status, "unavailable");
  assert.equal(setup.candidates[0].unavailableReason, "setup_required");

  // Inactive products are not in the public catalogue at all.
  const withoutMasala = { ...catalog, products: catalog.products.filter((product) => product.id !== "masala-fries") };
  const masala = resolveMenuQuery(buildMenuIndex(withoutMasala, { now: INSTANTS.wed_evening }), "masala fries");
  assert.notEqual(masala.status, "match");
  assert.ok(!masala.candidates.some((candidate) => candidate.productId === "masala-fries"));
});

test("a counter-only product put into the catalogue by mistake is still a different product from what the caller asked", { skip: reachable ? false : "Postgres is not reachable" }, () => {
  // Belt and braces: the public catalogue excludes staffOnly, and the order
  // policy refuses it, so a resolver result can never become a counter item.
  const result = resolveMenuQuery(indexAt("wed_evening"), "12 wings");
  assert.ok(!result.candidates.some((candidate) => candidate.productId === "12-wings"));
});

test("pickup and delivery build-your-own pizzas map only when exactly equivalent", { skip: reachable ? false : "Postgres is not reachable" }, () => {
  const index = indexAt("wed_evening");
  // Delivery → pickup: only an exact included-topping match is the same pizza.
  assert.equal(equivalentPizzaFor(index, "large-pizza", "pickup", 1), "pickup-large-one");
  assert.equal(equivalentPizzaFor(index, "large-pizza", "pickup", 3), "pickup-large-three");
  assert.equal(equivalentPizzaFor(index, "large-pizza", "pickup", 2), null, "two toppings: 1-item plus one, or 3-item short one — the caller's choice");
  assert.equal(equivalentPizzaFor(index, "large-pizza", "pickup", 4), null);
  assert.equal(equivalentPizzaFor(index, "medium-pizza", "pickup", 5), "pickup-medium-five");
  // Pickup → delivery: one Pizza by Size product per size, up to four included.
  assert.equal(equivalentPizzaFor(index, "pickup-large-one", "delivery", 1), "large-pizza");
  assert.equal(equivalentPizzaFor(index, "pickup-large-three", "delivery", 3), "large-pizza");
  assert.equal(equivalentPizzaFor(index, "pickup-medium-five", "delivery", 5), null, "five is more than Pizza by Size includes");
  assert.equal(equivalentPizzaFor(index, "pickup-slab-one", "delivery", 1), "slab-pizza");
  // Not a build-your-own pizza: nothing to remap.
  assert.equal(equivalentPizzaFor(index, "specialty-hawaiian", "pickup", 3), null);
  assert.equal(equivalentPizzaFor(index, "pickup-one-slice", "delivery", 1), null);
});
