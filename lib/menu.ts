import { PIZZA_SIZES } from "@/lib/launch-config";

export type ModifierSectionSeed = {
  id: string;
  label: string;
  source?: "toppings" | "wing_flavours" | "drinks" | "pizza_base";
  options?: string[];
  min: number;
  max: number;
  included?: number;
  extraPriceCents?: number;
  sharedGroup?: string;
  sharedIncluded?: number;
};

export type MenuProductSeed = {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  productType: "pizza" | "simple" | "bundle" | "configurable";
  basePriceCents: number;
  pickupEligible?: boolean;
  deliveryEligible?: boolean;
  halalCapable?: boolean;
  configuration?: Record<string, unknown>;
  variations?: Array<{
    id: string;
    name: string;
    basePriceCents: number;
    extraToppingPriceCents: number;
    includedToppingUnitsBps?: number;
  }>;
};

export const MENU_SEED_VERSION = "2026-07-20-official-menu-r3";

export const MENU_CATEGORIES = [
  ["build-your-own", "Pizza by Size", "pizza-by-size", 10],
  ["specialty-pizzas", "Specialty Pizzas", "specialty-pizzas", 20],
  ["deals", "Deals", "deals", 30],
  ["combos", "Combos", "combos", 40],
  ["two-for-one", "2 for 1 Pizzas", "two-for-one-pizzas", 50],
  ["wings", "Wings", "wings", 60],
  ["sides", "Side Orders", "side-orders", 70],
  ["drinks", "Drinks", "drinks", 80],
  ["desserts", "Sweet Treats", "sweet-treats", 90],
  ["pickup-specials", "Pickup Specials", "pickup-specials", 100],
  ["hamilton-heroes", "Hamilton Heroes", "hamilton-heroes", 110],
] as const;

export const TOPPING_SEEDS = [
  ["pepperoni", "Pepperoni", true, true],
  ["italian-sausage", "Italian Sausage", true, true],
  ["hot-sausage", "Hot Sausage", true, true],
  ["ham", "Ham", true, false],
  ["mushrooms", "Mushrooms", false, false],
  ["tomatoes", "Tomatoes", false, false],
  ["green-peppers", "Green Peppers", false, false],
  ["hot-peppers", "Hot Peppers", false, false],
  ["jalapenos", "Jalapeños", false, false],
  ["onions", "Onions", false, false],
  ["green-olives", "Green Olives", false, false],
  ["anchovies", "Anchovies", false, false],
  ["pineapple", "Pineapple", false, false],
  ["garlic", "Garlic", false, false],
  ["real-bacon", "Real Bacon", true, false],
  ["bacon-bits", "Bacon Bits", true, false],
  ["black-olives", "Black Olives", false, false],
  ["real-chicken", "Real Chicken", true, true],
  ["feta-cheese", "Feta Cheese", false, false],
  ["sun-dried-tomatoes", "Sun-Dried Tomatoes", false, false],
  ["ground-beef", "Ground Beef", true, true],
  ["meatballs", "Meatballs", true, true],
  ["corn", "Corn", false, false],
] as const;

export const PIZZA_BASE_OPTIONS = [
  "Thin Crust",
  "Thick Crust",
  "Lightly Done",
  "Well Done",
  "Easy on the Sauce",
  "Extra Sauce",
] as const;

export const WING_FLAVOURS = [
  "Mild",
  "Medium",
  "Hot",
  "Suicide",
  "Honey Garlic",
  "BBQ",
  "Cajun",
  "Lemon Pepper",
  "None",
] as const;

export const DRINK_OPTIONS = [
  "Pepsi",
  "Diet Pepsi",
  "Coke",
  "Diet Coke",
  "Coke Zero",
  "Gingerale",
  "Crush Orange",
  "Brisk Ice Tea",
  "Sprite",
  "Dr. Peppers",
  "Fanta Grape",
] as const;

const slug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const pizzaBase = (id: string): ModifierSectionSeed => ({
  id,
  label: "Crust, bake & sauce",
  source: "pizza_base",
  min: 0,
  max: 2,
});

const toppings = (
  id: string,
  label: string,
  included: number,
  extraPriceCents: number,
  sharedGroup?: string,
  sharedIncluded?: number,
): ModifierSectionSeed => ({
  id,
  label,
  source: "toppings",
  min: 0,
  max: 12,
  included,
  extraPriceCents,
  sharedGroup,
  sharedIncluded,
});

const wingFlavours = (max: number): ModifierSectionSeed => ({
  id: "wing-flavours",
  label: "Sauces & dry rubs",
  source: "wing_flavours",
  min: 1,
  max,
});

const drinks = (count: number): ModifierSectionSeed[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `drink-${index + 1}`,
    label: `Pop ${index + 1}`,
    source: "drinks" as const,
    min: 1,
    max: 1,
  }));

const bundle = (
  id: string,
  categoryId: string,
  name: string,
  priceCents: number,
  description: string,
  sections: ModifierSectionSeed[],
  pickupOnly = false,
): MenuProductSeed => ({
  id,
  categoryId,
  name,
  description,
  productType: "bundle",
  basePriceCents: priceCents,
  pickupEligible: true,
  deliveryEligible: !pickupOnly,
  halalCapable: true,
  configuration: { sections, specialInstructionsEnabled: true },
});

const standalonePizzas: MenuProductSeed[] = PIZZA_SIZES.map((size) => ({
  id: `${size.id}-pizza`,
  categoryId: "build-your-own",
  name: `${size.name} Pizza`,
  description: `Pizza 62 ${size.name.toLowerCase()} pizza with your choice of crust, cheese and toppings.`,
  productType: "pizza",
  basePriceCents: size.basePriceCents,
  halalCapable: true,
  configuration: { pizzaBaseOptions: PIZZA_BASE_OPTIONS, specialInstructionsEnabled: true },
  variations: [{
    id: `${size.id}-pizza-${size.id}`,
    name: size.name,
    basePriceCents: size.basePriceCents,
    extraToppingPriceCents: size.extraToppingPriceCents,
  }],
}));

const specialtyRecipes = [
  ["all-meat", "All Meat", "Pepperoni, Italian sausage, bacon, ham and ground beef."],
  ["canadian", "Canadian", "Double pepperoni, mushrooms, bacon and extra cheese."],
  ["deluxe", "Deluxe", "Pepperoni, mushrooms, green peppers, onions, bacon and tomatoes."],
  ["hawaiian", "Hawaiian", "Double ham, pineapple, bacon and extra cheese."],
  ["mexicana", "Mexicana", "Tomatoes, ground beef, hot peppers, onions and mushrooms."],
  ["vegetarian", "Vegetarian", "Mushrooms, green peppers, tomatoes, green olives and onions."],
  ["pizza-62-special", "Pizza 62 Special", "Chicken, onions, tomatoes, mushrooms and extra cheese."],
  ["greek", "Greek Pizza", "Mushrooms, onions, tomatoes, feta cheese and black olives."],
  ["chicken-bbq", "Chicken BBQ Pizza", "BBQ sauce, chicken, extra cheese and onions."],
  ["mediterranean", "Mediterranean Pizza", "Sun-dried tomatoes, black olives, onions and feta cheese."],
  ["butter-chicken", "Butter Chicken Pizza", "Butter chicken sauce, butter chicken, tomatoes and onions."],
  ["meatball", "Meatball Pizza", "Meatballs, green peppers, bacon and onions."],
  ["shawarma", "Shawarma Pizza", "Shawarma sauce, chicken, onions and tomatoes."],
] as const;

const specialtyPrices = [
  ["Medium", 1699, 210],
  ["Large", 1999, 230],
  ["X-Large", 2399, 260],
  ["2 Medium", 3099, 210],
  ["2 Large", 3399, 230],
  ["2 X-Large", 3899, 260],
] as const;

const specialtyPizzas: MenuProductSeed[] = specialtyRecipes.map(([id, name, description]) => ({
  id: `specialty-${id}`,
  categoryId: "specialty-pizzas",
  name,
  description,
  productType: "pizza",
  basePriceCents: 1699,
  halalCapable: true,
  configuration: { fixedRecipe: true, pizzaBaseOptions: PIZZA_BASE_OPTIONS, specialInstructionsEnabled: true },
  variations: specialtyPrices.map(([variationName, price, extra]) => ({
    id: `specialty-${id}-${slug(variationName)}`,
    name: variationName,
    basePriceCents: price,
    extraToppingPriceCents: extra,
  })),
}));

const deals: MenuProductSeed[] = [
  bundle("deal-two-large-wings", "deals", "2 Large Pizzas & 3 lb Wings", 5399, "Two large pizzas, 3 lb wings, 4 pops, veggie sticks, blue cheese and one dipping sauce.", [
    toppings("pizza-1-toppings", "Pizza 1 toppings", 3, 230),
    toppings("pizza-2-toppings", "Pizza 2 toppings", 3, 230), pizzaBase("pizza-1-base"), pizzaBase("pizza-2-base"), wingFlavours(2), ...drinks(4),
  ]),
  bundle("deal-two-medium-wings", "deals", "2 Medium Pizzas & 2 lb Wings", 4399, "Two medium pizzas, 2 lb wings, 4 pops, veggie sticks, blue cheese and one dipping sauce.", [
    toppings("pizza-1-toppings", "Pizza 1 toppings", 3, 210),
    toppings("pizza-2-toppings", "Pizza 2 toppings", 3, 210), pizzaBase("pizza-1-base"), pizzaBase("pizza-2-base"), wingFlavours(2), ...drinks(4),
  ]),
  bundle("deal-two-xl-wings", "deals", "2 X-Large Pizzas & 3 lb Wings", 5699, "Two X-large pizzas, 3 lb wings, 4 pops, veggie sticks, blue cheese and one dipping sauce.", [
    toppings("pizza-1-toppings", "Pizza 1 toppings", 3, 260),
    toppings("pizza-2-toppings", "Pizza 2 toppings", 3, 260), pizzaBase("pizza-1-base"), pizzaBase("pizza-2-base"), wingFlavours(2), ...drinks(4),
  ]),
];

const combos: MenuProductSeed[] = [
  ["jumbo", "1 Jumbo Pizza & 3 lb Wings", 4499, 290, "One jumbo pizza with 3 toppings, 3 lb wings, veggie sticks, blue cheese and a dipping sauce."],
  ["large", "1 Large Pizza & 3 lb Wings", 3899, 230, "One large pizza with 3 toppings, 3 lb wings, veggie sticks, blue cheese and a dipping sauce."],
  ["medium", "1 Medium Pizza & 12 Wings", 2799, 210, "One medium pizza with 3 toppings, 12 wings, veggie sticks, blue cheese and a dipping sauce."],
  ["slab", "1 Slab Pizza & 3 lb Wings", 5099, 290, "One slab pizza with 3 toppings, 3 lb wings, veggie sticks, blue cheese and a dipping sauce."],
  ["xl", "1 X-Large Pizza & 3 lb Wings", 4099, 260, "One X-large pizza with 3 toppings, 3 lb wings, veggie sticks, blue cheese and a dipping sauce."],
].map(([id, name, price, extra, description]) => bundle(`combo-${id}`, "combos", String(name), Number(price), String(description), [
  toppings("pizza-toppings", "Pizza toppings", 3, Number(extra)), pizzaBase("pizza-base"), wingFlavours(id === "medium" ? 1 : 2),
]));

const twoForOne: MenuProductSeed[] = [
  ["jumbo", "2 Jumbo Pizzas · 3 Toppings Each", 4099, 290],
  ["large", "2 Large Pizzas · 3 Toppings Each", 2999, 230],
  ["medium", "2 Medium Pizzas · 3 Toppings Each", 2699, 210],
  ["slab", "2 Slab Pizzas · 3 Toppings Each", 4999, 290],
  ["xl", "2 X-Large Pizzas · 3 Toppings Each", 3299, 260],
].map(([id, name, price, extra]) => bundle(`two-for-one-${id}`, "two-for-one", String(name), Number(price), "Two pizzas with up to three included toppings on each pizza.", [
  toppings("pizza-1-toppings", "Pizza 1 toppings", 3, Number(extra)),
  toppings("pizza-2-toppings", "Pizza 2 toppings", 3, Number(extra)), pizzaBase("pizza-1-base"), pizzaBase("pizza-2-base"),
]));

const wings: MenuProductSeed[] = [
  ["12-wings", "12 Wings", 1499, 1],
  ["1-lb-wings", "1 lb Wings", 1049, 1],
  ["24-wings", "24 Wings", 3099, 2],
  ["30-wings", "30 Wings", 3799, 2],
  ["40-wings", "40 Wings", 4899, 2],
  ["50-wings", "50 Wings", 5499, 2],
  ["60-wings", "60 Wings", 6599, 2],
].map(([id, name, price, maximum]) => ({
  id: String(id), categoryId: "wings", name: String(name),
  description: "Chicken wings with your choice from all sauces and dry rubs.",
  productType: "configurable" as const, basePriceCents: Number(price),
  configuration: { sections: [wingFlavours(Number(maximum))], specialInstructionsEnabled: true },
}));

const sides: MenuProductSeed[] = [
  ["standard-dip", "Standard Dipping Sauce", 120],
  ["buffalo-chicken-wrap", "Buffalo Chicken Wrap", 999],
  ["chicken-burger", "Chicken Burger", 649],
  ["chicken-fingers-fries", "Chicken Fingers with Fries", 899],
  ["fried-chicken-dumplings", "Fried Chicken Dumplings", 999],
  ["fries", "Fries", 799],
  ["garlic-bread", "Garlic Bread", 350],
  ["garlic-bread-cheese", "Garlic Bread with Cheese", 450],
  ["masala-fries", "Masala Fries", 999],
  ["meatball-sub", "Meatball Sub", 899],
  ["mozzarella-sticks", "Mozzarella Sticks · 6 pc", 799],
  ["onion-rings", "Onion Rings", 799],
  ["poutine", "Poutine", 899],
  ["samosa-poutine", "Samosa Poutine", 1199],
  ["shawarma-poutine", "Shawarma Poutine", 1299],
  ["shawarma-wrap", "Shawarma Style Wrap", 1099],
  ["shawarma-sub", "Shawarma Sub", 999],
  ["stuffed-jalapenos", "Stuffed Jalapeños · 6 pc", 799],
  ["wedges", "Wedges", 799],
].map(([id, name, price]) => ({
  id: String(id), categoryId: "sides", name: String(name), description: "A Pizza 62 menu favourite.", productType: "simple" as const, basePriceCents: Number(price),
}));

const configurableSides: MenuProductSeed[] = [
  {
    id: "panzerotti-three-items", categoryId: "sides", name: "Panzerotti · 3 Items",
    description: "Panzerotti with three included toppings.", productType: "pizza", basePriceCents: 1199,
    halalCapable: true, configuration: { pizzaBaseOptions: PIZZA_BASE_OPTIONS, specialInstructionsEnabled: true },
    variations: [{ id: "panzerotti", name: "Panzerotti", basePriceCents: 1199, extraToppingPriceCents: 210, includedToppingUnitsBps: 30_000 }],
  },
  {
    id: "salad", categoryId: "sides", name: "Salad", description: "Choose Greek or Caesar.",
    productType: "configurable", basePriceCents: 949,
    configuration: { sections: [{ id: "salad-choice", label: "Salad", options: ["Greek", "Caesar"], min: 1, max: 1 }] },
  },
];

const pickupPizza = (id: string, name: string, price: number, size: string, extra: number, included: number): MenuProductSeed => ({
  id, categoryId: "pickup-specials", name, description: `${included} topping${included === 1 ? "" : "s"} included.`,
  productType: "pizza", basePriceCents: price, pickupEligible: true, deliveryEligible: false, halalCapable: true,
  configuration: { pizzaBaseOptions: PIZZA_BASE_OPTIONS, specialInstructionsEnabled: true },
  variations: [{ id: `${id}-size`, name: size, basePriceCents: price, extraToppingPriceCents: extra, includedToppingUnitsBps: included * 10_000 }],
});

const pickupSpecials: MenuProductSeed[] = [
  bundle("pickup-large-wings", "pickup-specials", "Large Pizza, 1 lb Wings & 3 Pops", 2599, "Large pizza with 3 toppings, 1 lb wings and 3 canned pops.", [
    toppings("pizza-toppings", "Pizza toppings", 3, 230), pizzaBase("pizza-base"), wingFlavours(1), ...drinks(3),
  ], true),
  { ...wings.find((item) => item.id === "1-lb-wings")!, id: "pickup-one-lb-wings", categoryId: "pickup-specials", deliveryEligible: false },
  pickupPizza("pickup-medium-five", "Medium Pizza · 5 Toppings", 1299, "Medium", 210, 5),
  pickupPizza("pickup-jumbo-one", "Jumbo Pizza · 1 Topping", 2049, "Jumbo", 290, 1),
  pickupPizza("pickup-jumbo-three", "Jumbo Pizza · 3 Toppings", 2399, "Jumbo", 290, 3),
  pickupPizza("pickup-large-one", "Large Pizza · 1 Topping", 1199, "Large", 230, 1),
  pickupPizza("pickup-large-three", "Large Pizza · 3 Toppings", 1499, "Large", 230, 3),
  pickupPizza("pickup-medium-one", "Medium Pizza · 1 Topping", 899, "Medium", 210, 1),
  pickupPizza("pickup-medium-three", "Medium Pizza · 3 Toppings", 1249, "Medium", 210, 3),
  pickupPizza("pickup-slab-one", "Slab Pizza · 1 Topping", 2199, "Slab", 290, 1),
  pickupPizza("pickup-slab-three", "Slab Pizza · 3 Toppings", 2599, "Slab", 290, 3),
  pickupPizza("pickup-xl-one", "X-Large Pizza · 1 Topping", 1299, "X-Large", 260, 1),
  pickupPizza("pickup-xl-three", "X-Large Pizza · 3 Toppings", 1599, "X-Large", 260, 3),
  bundle("pickup-two-large-six", "pickup-specials", "2 Large Pizzas · 6 Toppings Shared", 2799, "Share six included toppings across both large pizzas any way you like.", [
    toppings("pizza-1-toppings", "Pizza 1 toppings", 0, 230, "six-shared", 6),
    toppings("pizza-2-toppings", "Pizza 2 toppings", 0, 230, "six-shared", 6), pizzaBase("pizza-1-base"), pizzaBase("pizza-2-base"),
  ], true),
];

const heroes: MenuProductSeed[] = [
  {
    ...pickupPizza("hamilton-hero-deal", "Hamilton Hero Deal", 1699, "Large", 230, 3),
    categoryId: "hamilton-heroes", deliveryEligible: true,
    description: "Large pizza with 3 toppings and free standard delivery.",
    configuration: { pizzaBaseOptions: PIZZA_BASE_OPTIONS, specialInstructionsEnabled: true, freeDelivery: true },
  },
  bundle("fifa-game-day", "hamilton-heroes", "Game Day: Large Pizza, Wings & 3 Pops", 2499, "Large pizza with 3 toppings, 1 lb wings and 3 pops.", [
    toppings("pizza-toppings", "Pizza toppings", 3, 230), pizzaBase("pizza-base"), wingFlavours(1), ...drinks(3),
  ]),
];

export const MENU_PRODUCTS: MenuProductSeed[] = [
  ...standalonePizzas,
  ...specialtyPizzas,
  ...deals,
  ...combos,
  ...twoForOne,
  ...wings,
  ...sides,
  ...configurableSides,
  { id: "water-bottle", categoryId: "drinks", name: "Water Bottle", description: "Chilled bottled water.", productType: "simple", basePriceCents: 160 },
  { id: "chocolate-brownie", categoryId: "desserts", name: "Chocolate Brownie", description: "A rich chocolate brownie for a sweet finish.", productType: "simple", basePriceCents: 299 },
  ...pickupSpecials,
  ...heroes,
];
