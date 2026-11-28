/**
 * The till changes of 2026-11-28, from the owner's list:
 *
 * 1. **Double toppings.** "Make it double pepperoni and one mushroom" on a
 *    three-topping pizza is three toppings, not two plus a paid extra. A
 *    double counts twice against the allowance, survives every trip through
 *    `normalizeToppings`, and prints as "Pepperoni x2".
 * 2. **Extra cheese is a topping.** It left the cheese choice for the
 *    toppings list, and it counts toward a special's required toppings and a
 *    deal pizza's included ones — "pepperoni, mushroom, and extra cheese for
 *    the third" is a complete three-topping pizza.
 * 3. **A returning customer by phone.** A partial number finds them in any
 *    format it was saved in, from orders or the old POS list; picking one
 *    returns their recent orders with items and their delivery addresses.
 * 4. **Address suggestions.** Azure Maps' answer reduced to what the till's
 *    fields need, and the store's own past delivery addresses.
 *
 * The database tests need a reachable Postgres and are skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const {
  normalizeToppings,
  pricePizza,
  priceModifierSelections,
  toppingUnitsBps,
  CHEESE_CHOICES,
  EXTRA_CHEESE_TOPPING_ID,
} = await import("@/lib/domain");
const { toppingDetails, modifierDetails, snapshotDetails } = await import("@/lib/order-presentation");
const { toAddressSuggestions } = await import("@/lib/delivery-area");
const { getPool, closePool } = await import("@/db/pg-driver");
const { quoteOrder } = await import("@/lib/order-service");
const { savedAddresses, suggestCustomers, loadCustomerHistory, previousDeliveryAddresses } = await import("@/lib/customer-lookup");
const { createPasswordHash } = await import("@/lib/auth");
const { POST: loginRoute } = await import("@/app/api/auth/login/route");
const { GET: lookupRoute } = await import("@/app/api/admin/customer-lookup/route");
const { MENU_PRODUCTS } = await import("@/lib/menu");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

// --- Double toppings: pricing --------------------------------------------------

test("a double counts as two toppings against the allowance", () => {
  const price = pricePizza({
    basePriceCents: 1499,
    extraToppingPriceCents: 230,
    includedToppingUnitsBps: 30_000,
    halfToppingUnitsBps: 5_000,
    toppings: [
      { toppingId: "pepperoni", placement: "whole", double: true },
      { toppingId: "mushrooms", placement: "whole" },
    ],
    extraCheese: false,
  });
  assert.equal(price.toppingUnitsBps, 30_000, "double pepperoni + mushroom is three toppings");
  assert.equal(price.extraToppingTotalCents, 0, "and all three are included on a three-topping pizza");
  assert.equal(price.totalCents, 1499);
});

test("a fourth topping on top of a double is charged as an extra", () => {
  const price = pricePizza({
    basePriceCents: 1499,
    extraToppingPriceCents: 230,
    includedToppingUnitsBps: 30_000,
    halfToppingUnitsBps: 5_000,
    toppings: [
      { toppingId: "pepperoni", placement: "whole", double: true },
      { toppingId: "mushrooms", placement: "whole", double: true },
    ],
    extraCheese: false,
  });
  assert.equal(price.paidUnitsBps, 10_000);
  assert.equal(price.extraToppingTotalCents, 230);
});

test("a double on half the pizza is a whole topping's worth", () => {
  assert.equal(toppingUnitsBps([{ toppingId: "pepperoni", placement: "left", double: true }]), 10_000);
  // Chicken already counts as two; doubled it is four.
  assert.equal(toppingUnitsBps([{ toppingId: "real-chicken", placement: "whole", double: true }]), 40_000);
});

test("normalizing keeps a double, and a duplicate can never shrink one", () => {
  assert.deepEqual(
    normalizeToppings([
      { toppingId: "pepperoni", placement: "whole" },
      { toppingId: "pepperoni", placement: "whole", double: true },
    ]),
    [{ toppingId: "pepperoni", placement: "whole", double: true }],
  );
  // A single portion has no `double` key at all, so older snapshots compare equal.
  assert.deepEqual(normalizeToppings([{ toppingId: "ham", placement: "whole" }]), [{ toppingId: "ham", placement: "whole" }]);
});

test("halves merge into a whole only when they are the same portion", () => {
  assert.deepEqual(
    normalizeToppings([
      { toppingId: "pepperoni", placement: "left", double: true },
      { toppingId: "pepperoni", placement: "right", double: true },
    ]),
    [{ toppingId: "pepperoni", placement: "whole", double: true }],
  );
  assert.deepEqual(
    normalizeToppings([
      { toppingId: "pepperoni", placement: "left", double: true },
      { toppingId: "pepperoni", placement: "right" },
    ]),
    [
      { toppingId: "pepperoni", placement: "left", double: true },
      { toppingId: "pepperoni", placement: "right" },
    ],
    "double on one side and single on the other is a real request and is kept as asked",
  );
});

test("only a literal true makes a double", () => {
  const sneaky = [{ toppingId: "pepperoni", placement: "whole", double: "yes" }] as unknown as Parameters<typeof normalizeToppings>[0];
  assert.deepEqual(normalizeToppings(sneaky), [{ toppingId: "pepperoni", placement: "whole" }]);
});

// --- Extra cheese in a deal's toppings ----------------------------------------

const dealSections = () => {
  const deal = MENU_PRODUCTS.find((product) => product.id === "deal-two-large-wings");
  assert.ok(deal);
  return (deal.configuration?.sections ?? []) as Parameters<typeof priceModifierSelections>[0];
};

test("in a deal, extra cheese and a double both count toward the pizza's three toppings", () => {
  const sections = dealSections();
  const priced = priceModifierSelections(sections, [
    { id: "pizza-1-cheese", values: ["Regular Cheese"] },
    { id: "pizza-1-toppings", values: [{ value: "pepperoni", placement: "whole", double: true }, { value: EXTRA_CHEESE_TOPPING_ID, placement: "whole" }] },
  ]);
  const toppings = priced.sections.find((section) => section.id === "pizza-1-toppings");
  assert.equal(toppings?.unitsBps, 30_000);
  assert.equal(toppings?.extraCents, 0, "double pepperoni and extra cheese is a full three-topping pizza");
  assert.equal(priced.extraCents, 0);
});

test("the cheese choice no longer offers extra cheese", () => {
  assert.deepEqual([...CHEESE_CHOICES], ["No Cheese", "Light Cheese", "Regular Cheese"]);
});

// --- Printing ---------------------------------------------------------------

test("a double prints as x2 on the ticket, on a pizza and inside a deal", () => {
  const names = new Map([["pepperoni", "Pepperoni"], ["mushrooms", "Mushrooms"]]);
  assert.deepEqual(
    toppingDetails([{ toppingId: "pepperoni", placement: "whole", double: true }, { toppingId: "mushrooms", placement: "whole" }], names),
    [{ label: "Toppings", value: "Pepperoni x2, Mushrooms" }],
  );
  assert.deepEqual(
    modifierDetails([{ id: "pizza-1-toppings", label: "Toppings", group: "Pizza 1", values: [
      { value: "pepperoni", label: "Pepperoni", placement: "left", double: true },
      { value: EXTRA_CHEESE_TOPPING_ID, label: "Extra Cheese", placement: "whole" },
    ] }]),
    [{ label: "Pizza 1 · Toppings", value: "Pepperoni x2 (left half), Extra Cheese" }],
  );
  // An old snapshot with no `double` anywhere reads exactly as before.
  assert.deepEqual(
    snapshotDetails({ toppings: [{ toppingId: "pepperoni", placement: "whole" }] }, names),
    [{ label: "Toppings", value: "Pepperoni" }],
  );
});

// --- Address suggestions (pure) ----------------------------------------------

test("Azure Maps suggestions become street, postal code and area", () => {
  const suggestions = toAddressSuggestions([
    { type: "Point Address", address: { streetNumber: "31", streetName: "King Street East", municipality: "Hamilton", countrySubdivisionCode: "ON", postalCode: "L8N", extendedPostalCode: "L8N 1A1" } },
    { type: "Point Address", address: { streetNumber: "31", streetName: "King Street East", municipality: "Hamilton", countrySubdivisionCode: "ON", postalCode: "L8N 1A1" } },
    { type: "Street", address: { streetName: "King William Street", municipality: "Hamilton", countrySubdivisionCode: "ON", postalCode: "L8R" } },
    { type: "Point Address", address: { streetNumber: "31", streetName: "King Street", municipality: "Niagara Falls", countrySubdivisionCode: "NY", postalCode: "14301" } },
    { type: "Geography", address: { municipality: "Hamilton", countrySubdivisionCode: "ON" } },
  ]);
  assert.deepEqual(suggestions, [
    { line1: "31 King Street East", postalCode: "L8N 1A1", postalPrefix: "L8N", area: "Hamilton" },
    { line1: "King William Street", postalCode: "", postalPrefix: "L8R", area: "Hamilton" },
  ], "duplicates collapse, a partial code is only a hint, and other provinces and bare towns are dropped");
});

test("a street-only match keeps the typed house number and offers no full postal code", () => {
  const street = [{ type: "Street", address: { streetName: "Upper James Street", municipality: "Hamilton", countrySubdivisionCode: "ON", extendedPostalCode: "L9C 2X7" } }];
  assert.deepEqual(toAddressSuggestions(street, "12 upper james"), [
    { line1: "12 Upper James Street", postalCode: "", postalPrefix: "L9C", area: "Hamilton" },
  ]);
  assert.equal(toAddressSuggestions(street, "upper james")[0].line1, "Upper James Street");
});

test("saved addresses are distinct and most recent first", () => {
  const row = (line1: string, unit: string, at: number, instructions: string | null = null) => ({
    address_json: JSON.stringify({ line1, unit, city: "Hamilton", province: "ON", postalCode: "L8H 1A1" }),
    instructions,
    created_at: at,
  });
  const addresses = savedAddresses([row("12 Main St E", "", 3, "Side door"), row("12 Main St E", "", 2), row("12 Main St E", "4", 1), { address_json: null, instructions: null, created_at: 0 }]);
  assert.deepEqual(addresses.map((entry) => [entry.line1, entry.unit, entry.instructions]), [["12 Main St E", "", "Side door"], ["12 Main St E", "4", ""]]);
});

// --- Server: doubles and extra cheese on real products ----------------------

async function variationOf(productId: string): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    "SELECT id FROM product_variations WHERE product_id = $1 AND active = 1 ORDER BY display_order LIMIT 1",
    [productId],
  );
  return result.rows[0].id;
}

withDb("a three-item special accepts two toppings and extra cheese, and a double and one more", async () => {
  const variationId = await variationOf("pickup-large-three");
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [
      { productId: "pickup-large-three", variationId, quantity: 1, toppings: [{ toppingId: "pepperoni", placement: "whole" }, { toppingId: "mushrooms", placement: "whole" }], extraCheese: true },
      { productId: "pickup-large-three", variationId, quantity: 1, toppings: [{ toppingId: "pepperoni", placement: "whole", double: true }, { toppingId: "mushrooms", placement: "whole" }] },
    ],
    paymentMethod: "pay_at_store",
  });
  assert.deepEqual(quote.issues.filter((issue) => issue.index !== null), [], "both are complete three-topping pizzas");
  const [cheese, double] = quote.lines;
  assert.equal(cheese.unitPriceCents, double.unitPriceCents, "and neither costs more than the special's price");
});

withDb("a three-item special with only two toppings is still refused", async () => {
  const variationId = await variationOf("pickup-large-three");
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [{ productId: "pickup-large-three", variationId, quantity: 1, toppings: [{ toppingId: "pepperoni", placement: "whole" }, { toppingId: "mushrooms", placement: "whole" }] }],
    paymentMethod: "pay_at_store",
  });
  assert.equal(quote.issues.find((issue) => issue.index === 0)?.code, "TOPPINGS_INCOMPLETE");
});

withDb("a deal accepts extra cheese as one of a pizza's toppings and keeps the double", async () => {
  const productId = "deal-two-large-wings";
  const row = await getPool().query<{ configuration_json: string }>("SELECT configuration_json FROM products WHERE id = $1", [productId]);
  const sections = (JSON.parse(row.rows[0].configuration_json).sections ?? []) as Array<{ id: string; source?: string; options?: string[]; min: number }>;
  const { DRINK_OPTIONS, WING_FLAVOURS, CRUST_OPTIONS } = await import("@/lib/domain");
  // The least a valid deal needs: every required section, with its first option.
  const modifiers = sections.filter((section) => section.min > 0 && section.source !== "halal").map((section) => {
    if (section.id === "pizza-1-toppings") return { id: section.id, values: [{ value: "pepperoni", placement: "whole", double: true }, { value: EXTRA_CHEESE_TOPPING_ID, placement: "whole" }] };
    if (section.source === "toppings") return { id: section.id, values: [{ value: "ham", placement: "whole" }] };
    if (section.source === "cheese") return { id: section.id, values: ["Regular Cheese"] };
    if (section.source === "crust") return { id: section.id, values: [CRUST_OPTIONS[0]] };
    if (section.source === "drinks") return { id: section.id, values: [DRINK_OPTIONS[0]] };
    if (section.source === "wing_flavours") return { id: section.id, values: [section.options?.[0] ?? WING_FLAVOURS[0]] };
    return { id: section.id, values: [section.options?.[0] ?? ""] };
  });
  const quote = await quoteOrder({ fulfilment: "pickup", items: [{ productId, quantity: 1, modifiers }], paymentMethod: "pay_at_store" });
  assert.deepEqual(quote.issues.filter((issue) => issue.index !== null), []);
  const base = await getPool().query<{ base_price_cents: number }>("SELECT base_price_cents FROM products WHERE id = $1", [productId]);
  assert.equal(quote.lines[0].unitPriceCents, base.rows[0].base_price_cents, "double pepperoni and extra cheese fit inside the three included toppings");
});

// --- Returning customers ------------------------------------------------------

const RUN = crypto.randomUUID().slice(0, 8);
let counter = 0;
/** A fresh 10-digit number per test, so reruns against the shared test database never collide. */
const freshPhone = () => `289${crypto.randomUUID().replace(/\D/g, "").padEnd(12, "7").slice(0, 7)}`;

async function seedOrder(overrides: { phone: string; name?: string; status?: string; fulfilment?: "pickup" | "delivery"; address?: Record<string, string>; createdAt?: number; instructions?: string }) {
  const id = crypto.randomUUID();
  const at = overrides.createdAt ?? Date.now();
  await getPool().query(
    `INSERT INTO orders (id,order_number,tracking_token_hash,feedback_token_hash,customer_name,customer_phone,
       customer_email,fulfilment,channel,status,payment_status,payment_method,schedule_type,estimated_for,pricing_json,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,address_json,instructions,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'',$7,'phone',$8,'pending_at_store','pay_at_store','asap',$9,'{}',1499,0,195,0,0,1694,$10,$11,$9,$9)`,
    [id, `P62-L${RUN}-${(counter += 1)}`, `h${id}`, `f${id}`, overrides.name ?? "Grace Hopper", overrides.phone,
      overrides.fulfilment ?? "pickup", overrides.status ?? "completed", at,
      overrides.address ? JSON.stringify({ city: "Hamilton", province: "ON", unit: "", ...overrides.address }) : null,
      overrides.instructions ?? null],
  );
  await getPool().query(
    `INSERT INTO order_items (id,order_id,product_id,product_name,variation_name,quantity,unit_price_cents,line_total_cents,taxable,snapshot_json,instructions,created_at)
     VALUES ($1,$2,'large-pizza','Large Pizza','Large',1,1499,1499,1,$3,NULL,$4)`,
    [crypto.randomUUID(), id, JSON.stringify({ productType: "pizza", toppings: [{ toppingId: "pepperoni", placement: "whole", double: true }], extraCheese: true }), at],
  );
  return id;
}

withDb("a partial number finds the customer whichever way their number was written", async () => {
  const phone = freshPhone();
  await seedOrder({ phone: `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`, createdAt: Date.now() - 2000 });
  await seedOrder({ phone: `+1 ${phone}`, name: "Counter", fulfilment: "delivery", address: { line1: "77 Ottawa St N", postalCode: "L8H 3Y9" } });
  const suggestions = await suggestCustomers(phone.slice(0, 7));
  const match = suggestions.find((entry) => entry.phone === phone);
  assert.ok(match, "the customer is suggested from the first seven digits");
  assert.equal(match.orderCount, 2, "both spellings of the number are one customer");
  assert.equal(match.name, "Grace Hopper", "a till order named Counter does not hide their real name");
  assert.equal(match.lastAddress, "77 Ottawa St N");
  assert.deepEqual(await suggestCustomers("28"), [], "two digits is too few to suggest anyone");
});

withDb("an abandoned checkout is not history, and the old POS list fills the gaps", async () => {
  const abandoned = freshPhone();
  await seedOrder({ phone: abandoned, status: "awaiting_payment" });
  assert.equal((await suggestCustomers(abandoned)).length, 0);
  assert.equal(await loadCustomerHistory(abandoned), null);

  const regular = freshPhone();
  const now = Date.now();
  await getPool().query(
    `INSERT INTO customer_contacts (id, phone, name, source, created_at, updated_at) VALUES ($1, $2, 'Old Regular', 'import', $3, $3)`,
    [crypto.randomUUID(), regular, now],
  );
  const [contact] = await suggestCustomers(regular);
  assert.equal(contact.name, "Old Regular");
  assert.equal(contact.contactOnly, true);
  assert.equal((await loadCustomerHistory(regular))?.orderCount, 0);
});

withDb("a customer's history has their orders with items and their delivery addresses", async () => {
  const phone = freshPhone();
  await seedOrder({ phone, fulfilment: "delivery", address: { line1: "10 Kenilworth Ave N", postalCode: "L8H 4R6" }, instructions: "Buzz 12", createdAt: Date.now() - 5000 });
  await seedOrder({ phone, fulfilment: "pickup" });
  const history = await loadCustomerHistory(phone);
  assert.ok(history);
  assert.equal(history.orderCount, 2);
  assert.equal(history.orders.length, 2);
  assert.equal(history.orders[0].fulfilment, "pickup", "newest first");
  const snapshot = history.orders[1].items[0].snapshot as { toppings: Array<{ double?: boolean }>; extraCheese: boolean };
  assert.equal(snapshot.toppings[0].double, true, "the stored build comes back intact, ready to order again");
  assert.deepEqual(history.addresses.map((entry) => [entry.line1, entry.postalCode, entry.instructions]), [["10 Kenilworth Ave N", "L8H 4R6", "Buzz 12"]]);

  const previous = await previousDeliveryAddresses("10 kenilworth");
  assert.ok(previous.some((entry) => entry.line1 === "10 Kenilworth Ave N" && entry.postalCode === "L8H 4R6"));
});

// --- Who may look customers up -------------------------------------------------

const PASSWORD = "Correct Horse Battery Staple 62";
async function signedInAs(permissions: string[]): Promise<string> {
  const id = crypto.randomUUID();
  const email = `lookup-${id}@example.test`;
  const hash = await createPasswordHash(PASSWORD);
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_users (id,email,name,role,password_hash,password_salt,password_iterations,permissions_json,active,created_at,updated_at)
     VALUES ($1,$2,'Lookup Tester','employee',$3,$4,$5,$6,1,$7,$7)`,
    [id, email, hash.hash, hash.salt, hash.iterations, JSON.stringify(permissions), now],
  );
  const response = await loginRoute(new Request("https://order.pizza62.test/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-azure-clientip": `198.51.100.${(counter += 1) % 250}-${RUN}` },
    body: JSON.stringify({ email, password: PASSWORD }),
  }));
  assert.equal(response.status, 200);
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

withDb("looking a customer up needs the customer-contact permission", async () => {
  const phone = freshPhone();
  await seedOrder({ phone });
  const ask = (cookie: string) => lookupRoute(new Request(`https://order.pizza62.test/api/admin/customer-lookup?phone=${phone}`, { headers: { cookie } }));
  assert.equal((await ask(await signedInAs(["view_orders"]))).status, 403);
  const allowed = await ask(await signedInAs(["view_orders", "view_customer_contact"]));
  assert.equal(allowed.status, 200);
  const body = (await allowed.json()) as { suggestions: Array<{ phone: string }> };
  assert.ok(body.suggestions.some((entry) => entry.phone === phone));
});
