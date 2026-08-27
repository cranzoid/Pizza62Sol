export const LAUNCH_SETTINGS = {
  business: {
    name: "Pizza 62",
    phone: "(905) 547-5777",
    locale: "en-CA",
    currency: "CAD",
    timeZone: "America/Toronto",
    address: "55 Parkdale Ave N, Hamilton, ON L8H 5W7",
    latitude: 43.23779,
    longitude: -79.79189,
    googleReviewUrl: "https://g.page/r/CYm26zxH0aO8EAE/review",
    // Where the new-order alert and the low-rating alert are sent. This is a
    // *recipient*, not the address mail is sent from — `EMAIL_FROM` is the
    // sender and must be on a domain with SPF/DKIM, which a gmail.com address
    // can never be. Leaving this unset meant restaurant alerts fell back to
    // voice and SMS alone.
    email: "info.pizza62@gmail.com",
  },
  ordering: {
    enabled: true,
    pickupEnabled: true,
    deliveryEnabled: true,
    payAtStorePickupEnabled: true,
    cashOnDeliveryEnabled: false,
    pickupEstimateMinutes: 15,
    deliveryEstimateMinutes: 30,
    reorderEnabled: false,
    capacityLimitsEnabled: false,
    // H-08: how long before closing the kitchen stops accepting new orders. A
    // store that closes at 22:00 cannot start a pizza at 21:59, so "open" and
    // "still taking orders" are different questions and the customer is shown a
    // live countdown to this one, not to the door closing.
    lastOrderCutoffMinutes: 20,
    paused: false,
    pauseMessage: "Online ordering is temporarily paused. Please call us.",
  },
  delivery: {
    radiusKm: 10,
    feeCents: 350,
    // Owner decision, 2026-08-21. Checked against the pre-tax menu subtotal, so
    // a customer cannot reach it with tip or with the delivery fee itself.
    minimumCents: 2000,
    // HST applies to a delivery charge when the goods being delivered are
    // taxable, which for restaurant food they are — so the fee is inside the tax
    // basis, not beside it. This was `false`, which understated HST owed on
    // every delivery order. Both this and `taxAndTips.taxRateBps` stay editable
    // in Admin → Settings, so a change in the rules is a settings change.
    feeTaxable: true,
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
    // How long after an order is completed the feedback request goes out. Long
    // enough that the customer has eaten, short enough that the meal is still
    // the thing they were just doing.
    feedbackDelayMinutes: 40,
    lowRatingThreshold: 2,
    halfToppingUnitsBps: 10_000,
    halalSurchargeType: "none",
    halalSurchargeAmount: 0,
    halalNotice:
      "Halal meat options are available for selected toppings. Pizza 62 uses a shared kitchen, so please tell our team about allergies or preparation concerns before ordering.",
  },
  /**
   * The thank-you that goes out after someone fills in the feedback form.
   *
   * **Everyone who answers gets it, whatever they scored us.** That is not
   * politeness, it is the difference between thanking customers for their time
   * and paying for good reviews — and paying for good reviews is against
   * Google's policy and worth nothing anyway, because the ratings it buys are
   * not information. A one-star answer is the most useful mail we will get all
   * week; it earns the same garlic bread as a five.
   *
   * The value of the offer is *not* recorded here. `feedbackRewardCode` names a
   * promotion, and the promotion row is what decides what the code is worth,
   * what it needs to be spent on, and when it stops working. Copying the amount
   * into a settings blob is how an email comes to promise C$3.99 off while the
   * code at the till gives C$5 — so the mail reads the promotion and quotes it.
   * No promotion, no mail: the queue parks the row rather than sending a code
   * that does nothing at checkout.
   */
  rewards: {
    feedbackRewardEnabled: true,
    feedbackRewardCode: "THANKS62",
    feedbackRewardOffer: "a free garlic bread or four pops",
  },
  /**
   * Who hears about it when the software itself is in trouble.
   *
   * Deliberately separate from `business.email`: the restaurant wants to know an
   * order arrived, and the developer wants to know a notification could not be
   * delivered at all. Sending both to one inbox means the operational signal is
   * buried in the technical one, and the technical one is ignored.
   *
   * The same addresses back the Azure Monitor action group in `infra/`, so a
   * failure that never reaches the application still reaches a person.
   */
  alerts: {
    developerEmails: ["deskofvisheshvaibhav@gmail.com", "visheshvaibhav10@gmail.com"],
    // A notification that exhausted its retries is silence the customer can see
    // and nobody else can, which is the failure this whole release exists to end.
    notifyOnFailedNotification: true,
    notifyOnLowRating: true,
  },
  featureFlags: {
    savedCards: false,
    extraWingSauce: false,
    blueCheeseAddon: false,
    bottledPopUpgrades: false,
    // H-21: keep unconfirmed public claims off until the owner confirms them.
    halalPreparationClaim: false,
    wingBreadedLabel: false,
    dryRubLabel: false,
  },
  content: {
    heroEyebrow: "Hamilton-made since the first slice",
    heroHeadline: "Big flavour.",
    heroAccent: "Zero fuss.",
    heroDescription: "Hot pizza, honest prices, and the kind of local service that remembers your order.",
    dealEyebrow: "Pick it up & save",
    dealHeadline: "Two large. Six toppings.",
    dealDescription: "Split all six included toppings across both pizzas any way you want.",
    footerTagline: "Hamilton pizza made for real life.",
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

// Pizza by Size is the *delivery* pizza list, confirmed by the owner on
// 2026-08-28. One price per size, any one to four toppings for that price, a
// fifth and beyond charged at the size's extra-topping rate.
//
// It is deliberately not offered on pickup. Pickup single pizzas are the
// Pickup Specials, which start at $8.99 for a medium — below every price here —
// so listing both on a pickup order would undercut the special and show the
// same pizza twice. See PIZZA_BY_SIZE_INCLUDED_TOPPINGS for the allowance.
export const PIZZA_SIZES = [
  { id: "medium", name: "Medium", basePriceCents: 1699, extraToppingPriceCents: 210 },
  { id: "large", name: "Large", basePriceCents: 1799, extraToppingPriceCents: 230 },
  { id: "x-large", name: "X-Large", basePriceCents: 1899, extraToppingPriceCents: 260 },
  { id: "jumbo", name: "Jumbo", basePriceCents: 2399, extraToppingPriceCents: 290 },
  { id: "slab", name: "Slab", basePriceCents: 2799, extraToppingPriceCents: 290 },
] as const;

/**
 * Toppings included in a Pizza by Size price.
 *
 * The customer chooses anywhere from one to four and pays the same; the
 * customizer requires one because a pizza with nothing on it is not what the
 * price describes. Beyond four, `pricePizza` charges the size's extra rate.
 */
export const PIZZA_BY_SIZE_INCLUDED_TOPPINGS = 4;

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
