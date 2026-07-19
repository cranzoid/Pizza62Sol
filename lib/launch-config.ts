export const LAUNCH_SETTINGS = {
  business: {
    name: "Pizza 62",
    phone: "(905) 547-5777",
    locale: "en-CA",
    currency: "CAD",
    timeZone: "America/Toronto",
    address: null,
    latitude: null,
    longitude: null,
    googleReviewUrl: null,
  },
  ordering: {
    enabled: true,
    pickupEnabled: true,
    deliveryEnabled: true,
    payAtStorePickupEnabled: true,
    cashOnDeliveryEnabled: false,
    pickupEstimateMinutes: 15,
    deliveryEstimateMinutes: null,
    reorderEnabled: false,
    capacityLimitsEnabled: false,
    paused: false,
    pauseMessage: "Online ordering is temporarily paused. Please call us.",
  },
  delivery: {
    radiusKm: 10,
    feeCents: 350,
    minimumCents: 0,
    feeTaxable: false,
    outsideAreaMessage:
      "This address is outside our standard delivery area. Please call Pizza 62 to ask about an exception.",
  },
  taxAndTips: {
    taxRateBps: 1300,
    tippingEnabled: true,
    tipPresetBps: [1000, 1500, 1800],
    customTipEnabled: true,
    customTipMaxCents: 50_000,
    customTipMaxBasisBps: 20_000,
    tipBasis: "discounted_menu_subtotal",
  },
  operations: {
    cancellationRequestWindowMinutes: 5,
    payrollPeriod: "biweekly",
    locationVerificationEnabled: false,
    feedbackDelayMinutes: 75,
    lowRatingThreshold: 2,
    halfToppingUnitsBps: 10_000,
    halalSurchargeType: "none",
    halalSurchargeAmount: 0,
  },
  featureFlags: {
    savedCards: false,
    extraWingSauce: false,
    blueCheeseAddon: false,
    bottledPopUpgrades: false,
    halalPreparationClaim: false,
    wingBreadedLabel: false,
    dryRubLabel: false,
  },
} as const;

export const REGULAR_HOURS = [
  { weekday: 1, label: "Monday", openMinute: 660, closeMinute: 1320 },
  { weekday: 2, label: "Tuesday", openMinute: 660, closeMinute: 1320 },
  { weekday: 3, label: "Wednesday", openMinute: 660, closeMinute: 1320 },
  { weekday: 4, label: "Thursday", openMinute: 660, closeMinute: 1380 },
  { weekday: 5, label: "Friday", openMinute: 660, closeMinute: 1440 },
  { weekday: 6, label: "Saturday", openMinute: 660, closeMinute: 1440 },
  { weekday: 0, label: "Sunday", openMinute: 720, closeMinute: 1320 },
] as const;

export const PIZZA_SIZES = [
  { id: "medium", name: "Medium", basePriceCents: 840, extraToppingPriceCents: 210 },
  { id: "large", name: "Large", basePriceCents: 1149, extraToppingPriceCents: 230 },
  { id: "x-large", name: "X-Large", basePriceCents: 1249, extraToppingPriceCents: 260 },
  { id: "jumbo", name: "Jumbo", basePriceCents: 1999, extraToppingPriceCents: 290 },
  { id: "slab", name: "Slab", basePriceCents: 2149, extraToppingPriceCents: 290 },
] as const;

export const INITIAL_WING_FLAVOURS = [
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

export const CONFIRMED_OFFERS = [
  {
    id: "pickup-large-wings",
    name: "Large Pizza + Wings",
    priceCents: 2599,
    fulfilments: ["pickup"],
    description: "Large pizza with 3 toppings, 1 lb wings and 3 canned pops.",
  },
  {
    id: "pickup-two-large",
    name: "Two Large Pizza Special",
    priceCents: 2799,
    fulfilments: ["pickup"],
    description: "Two large pizzas with 6 toppings shared any way you like.",
  },
  {
    id: "pickup-medium-five",
    name: "Medium 5-Topping",
    priceCents: 1299,
    fulfilments: ["pickup"],
    description: "One medium pizza with up to 5 toppings.",
  },
  {
    id: "pickup-xl-three",
    name: "X-Large 3-Topping",
    priceCents: 1599,
    fulfilments: ["pickup"],
    description: "One X-Large pizza with up to 3 toppings.",
  },
  {
    id: "combo-two-medium",
    name: "Two Medium Feast",
    priceCents: 4399,
    fulfilments: ["pickup", "delivery"],
    description: "2 medium pizzas, 2 lb wings, 4 pops, veggie sticks, blue cheese and dip.",
  },
  {
    id: "combo-two-large",
    name: "Two Large Feast",
    priceCents: 5399,
    fulfilments: ["pickup", "delivery"],
    description: "2 large pizzas, 3 lb wings, 4 pops, veggie sticks, blue cheese and dip.",
  },
  {
    id: "combo-two-xl",
    name: "Two X-Large Feast",
    priceCents: 5699,
    fulfilments: ["pickup", "delivery"],
    description: "2 X-Large pizzas, 3 lb wings, 4 pops, veggie sticks, blue cheese and dip.",
  },
] as const;

export const CANNED_DRINKS = [
  "Pepsi",
  "Diet Pepsi",
  "Coke",
  "Diet Coke",
  "Coke Zero",
  "Ginger Ale",
  "Crush Orange",
  "Brisk Iced Tea",
  "Sprite",
  "Dr Pepper",
  "Fanta Grape",
] as const;
