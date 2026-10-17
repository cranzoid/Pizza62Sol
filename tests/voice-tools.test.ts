/**
 * The voice tool service and its HTTP API, end to end (Phase 2C).
 *
 * Every scenario drives the real tools against the real engine: a synthetic,
 * server-minted voice session calls `runVoiceTool` (or the HTTP route), the
 * tools call `quoteOrder` / `createOrder`, and the assertions read the
 * database. Nothing here talks to ElevenLabs or Twilio.
 *
 * Grouped as the test plan is: simple orders, pizzas, wings, deals, the
 * conversation state, delivery, failures, and the security properties the API
 * exists to guarantee — that a caller (or the model) cannot set a price, a fee,
 * free delivery, a discount or the channel; cannot order a counter-only item;
 * cannot place without a confirmation of the current version; and cannot
 * place twice.
 *
 * The clock is frozen on a past Wednesday evening, when the store is open and
 * the Hamilton Heroes offer is running, so nothing depends on when the suite
 * runs. Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test, { after, afterEach, before, mock } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { createVoiceSession, loadVoiceSession } = await import("@/lib/voice/session");
const { runVoiceTool, VOICE_TOOL_NAMES } = await import("@/lib/voice/tools");
const { POST: toolRoute } = await import("@/app/api/voice/tools/[tool]/route");
const { POST: publicOrderRoute } = await import("@/app/api/orders/route");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

before(async () => {
  if (!reachable) return;
  // Inline dispatch fires after each order; with no provider configured it
  // claims nothing, which is what these tests want.
  for (const key of ["EMAIL_API_KEY", "TWILIO_ACCOUNT_SID", "RESTAURANT_ALERT_PHONE"]) delete process.env[key];
});
after(async () => {
  await closePool();
});
afterEach(() => {
  mock.timers.reset();
  for (const key of ["VOICE_AI_MODE", "VOICE_TOOL_SECRET", "VOICE_PILOT_FULFILMENTS", "VOICE_MAX_ORDER_CENTS"]) delete process.env[key];
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const WEDNESDAY = (minuteOfDay: number) => Date.parse("2026-10-14T00:00:00-04:00") + minuteOfDay * 60_000;
const NOW = WEDNESDAY(18 * 60);

/** Runs `body` with the clock frozen at `instant`, which is when every tool and the engine think it is. */
async function at<T>(instant: number, body: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["Date"], now: instant });
  try {
    return await body();
  } finally {
    mock.timers.reset();
  }
}
const frozen = (name: string, body: () => Promise<void>, instant = NOW) => withDb(name, () => at(instant, body));

/** The parts of tool responses these tests read. */
type Detail = { label: string; value: string };
type Line = { lineId: string; name: string; quantity: number; lineTotalCents: number; flags: string[]; details: Detail[] };
type Candidate = {
  productId: string;
  variationId: string | null;
  detected: { toppings: Array<{ toppingId: string; placement: string }>; omitToppings: Array<{ toppingId: string }> };
};
type Data = {
  status: string;
  candidates: Candidate[];
  lines: Line[];
  lineId: string;
  cartVersion: number;
  readback: string;
  totals: { subtotalCents: number; deliveryFeeCents: number; amountDueCents: number };
  sections: Array<{ id: string; required: boolean; included: number | null; extraPriceCents: number | null; options: Array<{ value: string }> }>;
  deals: Array<{ productId: string; priceCents: number }>;
  orderNumber: string;
  duplicate: boolean;
  phoneSource: string;
  customerPhoneToConfirm: string;
  remapped: unknown[];
  fulfilment: string;
  stored: boolean;
  payment: string;
  addressDeliverable: boolean;
  eligible: boolean;
  reason: string;
  minimumCents: number;
  shortfallCents: number;
  feeCents: number;
  deliveryAvailableByPhone: boolean;
  acceptingOrdersNow: boolean;
  delivery: { availableByPhone: boolean };
  pizza: { recipe: Array<{ toppingId: string }> };
};
type Body = Omit<Awaited<ReturnType<typeof runVoiceTool>>["body"], "data"> & { data?: Data };

async function call(secret: string, tool: string, args: unknown = {}): Promise<Body> {
  return (await runVoiceTool(tool, secret, args)).body as Body;
}

async function newSession(extra: Partial<Parameters<typeof createVoiceSession>[0]> = {}) {
  const { session, sessionSecret } = await createVoiceSession({ provider: "test", mode: "test", ...extra });
  return { id: session.id, secret: sessionSecret };
}

const CALLER = { name: "Jordan Caller", phone: "905-555-0177" };
const STORE_ADDRESS = { line1: "55 Parkdale Ave N", unit: "2", postalCode: "L8H 5W7" };
const DUNDAS = { line1: "10 King St W", postalCode: "L9H 1A1" };
const WINGS_24 = (flavours = ["Honey Garlic"], style = "Breaded") => ({
  productId: "24-wings",
  modifiers: [{ id: "wing-style", values: [style] }, { id: "wing-flavours", values: flavours }],
});

async function startPickup(secret: string) {
  const started = await call(secret, "start_order", { fulfilment: "pickup" });
  assert.ok(started.ok, JSON.stringify(started));
  return started;
}

async function add(secret: string, item: Record<string, unknown>) {
  const added = await call(secret, "add_item", item);
  assert.ok(added.ok, JSON.stringify(added.issues));
  return added;
}

async function reviewAndConfirm(secret: string) {
  const review = await call(secret, "review_order");
  assert.ok(review.ok, JSON.stringify(review.issues));
  const confirmed = await call(secret, "confirm_order", { cartVersion: review.data!.cartVersion, utterance: "yes that's everything" });
  assert.ok(confirmed.ok, JSON.stringify(confirmed.issues));
  return review;
}

async function placeFull(secret: string) {
  const review = await reviewAndConfirm(secret);
  const placed = await call(secret, "place_order", { cartVersion: review.data!.cartVersion });
  assert.ok(placed.ok, JSON.stringify(placed.issues));
  return { review, placed };
}

const orderByNumber = async (orderNumber: string) =>
  (await getPool().query<Record<string, string | number | null>>("SELECT * FROM orders WHERE order_number = $1", [orderNumber])).rows[0];

// --- simple ------------------------------------------------------------------------------

frozen("one pizza for pickup, paid at the store, end to end", async () => {
  const { id, secret } = await newSession();
  await startPickup(secret);
  const search = await call(secret, "search_menu", { query: "large pepperoni" });
  assert.equal(search.data!.status, "match");
  const [candidate] = search.data!.candidates;
  assert.equal(candidate.productId, "pickup-large-one");
  await add(secret, { productId: candidate.productId, variationId: candidate.variationId, toppings: candidate.detected.toppings.map((topping) => ({ toppingId: topping.toppingId, placement: topping.placement })) });
  assert.ok((await call(secret, "set_customer", CALLER)).ok);
  const { review, placed } = await placeFull(secret);
  assert.match(review.data!.readback, /Here is your pickup order\. 1\. one Large Pizza · 1 Item — Toppings: Pepperoni, \$11\.99\./);
  assert.match(review.data!.readback, /Payment is at the store when you pick up\./);
  const order = await orderByNumber(placed.data!.orderNumber);
  assert.equal(order.channel, "ai_phone");
  assert.equal(order.payment_method, "pay_at_store");
  assert.equal(order.payment_status, "pending_at_store");
  assert.equal(order.fulfilment, "pickup");
  assert.equal(order.customer_name, "Jordan Caller");
  assert.equal(order.customer_phone, "9055550177");
  assert.equal(Number(order.total_cents), review.data!.totals.amountDueCents);
  assert.equal((await loadVoiceSession(id))!.orderId, order.id);
  assert.equal(placed.data!.duplicate, false);
  assert.match(placed.say!, /Your order number is/);
});

frozen("pizza and wings, with multiple quantities", async () => {
  const { secret } = await newSession();
  await startPickup(secret);
  await add(secret, { productId: "pickup-large-one", toppings: [{ toppingId: "pepperoni", placement: "whole" }], quantity: 2 });
  await add(secret, WINGS_24());
  const poutine = await add(secret, { productId: "poutine", quantity: 3 });
  const lines = poutine.data!.lines;
  assert.equal(lines.length, 3);
  assert.equal(lines[0].quantity, 2);
  assert.equal(lines[0].lineTotalCents, 2 * 1199);
  assert.equal(lines[2].lineTotalCents, 3 * 899);
  assert.ok(lines[1].details.some((detail) => detail.value.includes("Honey Garlic")));
  await call(secret, "set_customer", CALLER);
  const review = await call(secret, "review_order");
  assert.ok(review.ok);
  assert.equal(review.data!.lines.length, 3);
  assert.equal(review.data!.totals.subtotalCents, 2 * 1199 + 3099 + 3 * 899);
});

frozen("a name and a callback number: spoken, or the presented caller ID read back", async () => {
  const presented = await newSession({ callerPhone: "+19055550144", callerIdStatus: "presented" });
  await startPickup(presented.secret);
  const viaCallerId = await call(presented.secret, "set_customer", { name: "Ada", useCallerId: true });
  assert.ok(viaCallerId.ok);
  assert.equal(viaCallerId.data!.phoneSource, "caller_id");
  assert.equal(viaCallerId.data!.customerPhoneToConfirm, "905-555-0144");
  assert.match(viaCallerId.say!, /is that the best number to reach you\?/);

  // A withheld or forwarded number is never used.
  for (const status of ["withheld", "forwarded_as_store", "unknown"] as const) {
    const other = await newSession({ callerPhone: "+19055550144", callerIdStatus: status });
    await startPickup(other.secret);
    const refused = await call(other.secret, "set_customer", { name: "Ada", useCallerId: true });
    assert.equal(refused.issues?.[0].code, "PHONE_REQUIRED", status);
  }
  const spoken = await call(presented.secret, "set_customer", { name: "Ada", phone: "(905) 555-0123" });
  assert.equal(spoken.data!.phoneSource, "spoken");
  assert.equal((await call(presented.secret, "set_customer", { name: "A" })).issues?.[0].field, "name");
  assert.equal((await call(presented.secret, "set_customer", { name: "Ada", phone: "555" })).issues?.[0].code, "INVALID_PHONE");
});

// --- pizzas ------------------------------------------------------------------------------

frozen("a specialty pizza needs a size, keeps its recipe, and reads back its omissions", async () => {
  const { secret } = await newSession();
  await startPickup(secret);
  const sizeless = await call(secret, "add_item", { productId: "specialty-hawaiian" });
  assert.equal(sizeless.issues?.[0].code, "SIZE_REQUIRED");
  assert.match(sizeless.say!, /Medium, Large, X-Large/);
  const plain = await add(secret, { productId: "specialty-hawaiian", variationId: "specialty-hawaiian-large" });
  const noHam = await add(secret, { productId: "specialty-hawaiian", variationId: "specialty-hawaiian-large", omitToppings: ["ham"] });
  const [first, second] = noHam.data!.lines;
  assert.equal(first.lineTotalCents, second.lineTotalCents, "leaving a topping off is not a discount");
  assert.equal(plain.data!.lines[0].lineTotalCents, 1999);
  assert.ok(second.flags.includes("No Ham"));
  assert.ok(!second.details.some((detail) => detail.label === "Toppings" && /\bHam\b/.test(detail.value)), "a left-off topping is not listed as a topping");
  // A topping that is not on the recipe cannot be "left off".
  const bogus = await call(secret, "add_item", { productId: "specialty-hawaiian", variationId: "specialty-hawaiian-large", omitToppings: ["anchovies"] });
  assert.equal(bogus.ok, false);
});

frozen("whole and half toppings, extra topping charges, crust, sauce and bake", async () => {
  const { secret } = await newSession();
  await startPickup(secret);
  const halves = await add(secret, {
    productId: "pickup-large-one",
    toppings: [{ toppingId: "pepperoni", placement: "left" }, { toppingId: "mushrooms", placement: "right" }],
  });
  const halfLine = halves.data!.lines[0];
  assert.deepEqual(halfLine.details.slice(0, 2), [{ label: "Left half", value: "Pepperoni" }, { label: "Right half", value: "Mushrooms" }]);
  // What a half counts as is the owner's setting (operations.halfToppingUnitsBps), so read it.
  const operations = (await getPool().query<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'operations'")).rows[0];
  const halfUnits = Number(JSON.parse(operations.value_json).halfToppingUnitsBps ?? 5000) / 10_000;
  assert.equal(halfLine.lineTotalCents, 1199 + Math.round(Math.max(0, 2 * halfUnits - 1) * 230), "two halves are priced by the half-topping rule");

  const extra = await add(secret, { productId: "pickup-large-one", toppings: [{ toppingId: "pepperoni", placement: "whole" }, { toppingId: "onions", placement: "whole" }] });
  assert.equal(extra.data!.lines[1].lineTotalCents, 1199 + 230, "the second topping is charged at the large rate");

  const options = await add(secret, {
    productId: "pickup-large-one",
    toppings: [{ toppingId: "ham", placement: "whole" }],
    modifiers: [
      { id: "pizza-crust", values: ["Thin Crust"] },
      { id: "pizza-sauce", values: ["BBQ"] },
      { id: "pizza-bake-sauce", values: ["Well Done"] },
    ],
  });
  const optioned = options.data!.lines[2];
  assert.equal(optioned.lineTotalCents, 1199 + 149, "a non-tomato sauce is $1.49");
  const text = optioned.details.map((detail) => `${detail.label}: ${detail.value}`).join(" | ");
  assert.match(text, /Thin Crust/);
  assert.match(text, /BBQ/);
  assert.match(text, /Well Done/);
});

frozen("changing the size midway keeps the toppings and re-prices them", async () => {
  const { secret } = await newSession();
  await startPickup(secret);
  const added = await add(secret, { productId: "pickup-large-one", toppings: [{ toppingId: "pepperoni", placement: "whole" }, { toppingId: "onions", placement: "whole" }] });
  const lineId = added.data!.lineId;
  const changed = await call(secret, "update_item", { lineId, productId: "pickup-xl-one" });
  assert.ok(changed.ok, JSON.stringify(changed.issues));
  const [line] = changed.data!.lines;
  assert.equal(line.name, "X-Large Pizza · 1 Item");
  assert.equal(line.lineTotalCents, 1299 + 260, "the extra topping is now at the X-Large rate");
  assert.ok(line.details[0].value.includes("Pepperoni") && line.details[0].value.includes("Onions"));
});

// --- wings -------------------------------------------------------------------------------

frozen("wings: a valid count with style and one or two flavours; an impossible split is refused", async () => {
  const { secret } = await newSession();
  await startPickup(secret);
  await add(secret, WINGS_24(["Honey Garlic"]));
  const two = await add(secret, WINGS_24(["Hot", "Mild"], "Classic (non-breaded)"));
  assert.ok(two.data!.lines[1].details.some((detail) => detail.value.includes("Hot") && detail.value.includes("Mild")));
  // 1 lb wings come in one flavour.
  const split = await call(secret, "add_item", { productId: "1-lb-wings", modifiers: [{ id: "wing-style", values: ["Breaded"] }, { id: "wing-flavours", values: ["Hot", "Mild"] }] });
  assert.equal(split.ok, false);
  assert.match(split.issues![0].message, /Sauces & dry rubs/);
  // A style is required.
  const styleless = await call(secret, "add_item", { productId: "24-wings", modifiers: [{ id: "wing-flavours", values: ["Hot"] }] });
  assert.match(styleless.issues![0].message, /Wing style/);
  assert.equal((await call(secret, "get_cart")).data!.lines.length, 2, "refused lines were never added");
});

// --- deals -------------------------------------------------------------------------------

frozen("a combo with its required choices, described section by section", async () => {
  const { secret } = await newSession();
  await startPickup(secret);
  const item = await call(secret, "get_menu_item", { productId: "combo-large" });
  assert.ok(item.ok);
  const required = item.data!.sections.filter((section) => section.required).map((section) => section.id).sort();
  assert.deepEqual(required, ["pizza-cheese", "pizza-toppings", "wing-flavours", "wing-style"]);
  const toppings = item.data!.sections.find((section) => section.id === "pizza-toppings")!;
  assert.equal(toppings.included, 3);
  assert.equal(toppings.extraPriceCents, 230);
  assert.ok(item.data!.sections.find((section) => section.id === "wing-style")!.options.some((option) => option.value === "Breaded"));

  const missing = await call(secret, "add_item", { productId: "combo-large", modifiers: [{ id: "pizza-cheese", values: ["Regular Cheese"] }] });
  assert.equal(missing.ok, false, "required sections are enforced");
  const combo = await add(secret, {
    productId: "combo-large",
    modifiers: [
      { id: "pizza-cheese", values: ["Regular Cheese"] },
      { id: "pizza-toppings", values: ["pepperoni", "mushrooms", "onions"] },
      { id: "wing-style", values: ["Breaded"] },
      { id: "wing-flavours", values: ["Hot", "Honey Garlic"] },
    ],
  });
  assert.equal(combo.data!.lines[0].lineTotalCents, 3800);
});

frozen("a shared topping pool is shared across the pizzas, and charged past its allowance", async () => {
  const { secret } = await newSession();
  await startPickup(secret);
  const pizza = (id: number, toppings: string[]) => [
    { id: `pizza-${id}-cheese`, values: ["Regular Cheese"] },
    { id: `pizza-${id}-toppings`, values: toppings },
  ];
  const within = await add(secret, { productId: "pickup-two-large-six", modifiers: [...pizza(1, ["pepperoni", "mushrooms", "onions", "ham"]), ...pizza(2, ["pineapple", "corn"])] });
  assert.equal(within.data!.lines[0].lineTotalCents, 2799, "six toppings, split four and two, are included");
  const over = await add(secret, { productId: "pickup-two-large-six", modifiers: [...pizza(1, ["pepperoni", "mushrooms", "onions", "ham"]), ...pizza(2, ["pineapple", "corn", "garlic"])] });
  assert.equal(over.data!.lines[1].lineTotalCents, 2799 + 230, "the seventh is charged at the large rate");
});

withDb("a time-limited deal is refused outside its hours, and get_deals lists only what is on now", async () => {
  await at(WEDNESDAY(14 * 60), async () => {
    const { secret } = await newSession();
    await startPickup(secret);
    const hero = await call(secret, "add_item", {
      productId: "hamilton-hero-deal",
      modifiers: [{ id: "pizza-cheese", values: ["Regular Cheese"] }, { id: "pizza-toppings", values: ["pepperoni"] }],
    });
    assert.equal(hero.issues?.[0].code, "PRODUCT_OUTSIDE_OFFER_HOURS");
    const deals = await call(secret, "get_deals");
    assert.ok(!deals.data!.deals.some((deal) => deal.productId === "hamilton-hero-deal"));
  });
  await at(NOW, async () => {
    const { secret } = await newSession();
    await startPickup(secret);
    const deals = await call(secret, "get_deals", { fulfilment: "pickup" });
    const ids = deals.data!.deals.map((deal) => deal.productId);
    assert.ok(ids.includes("hamilton-hero-deal"), "running on a weekday evening");
    assert.ok(ids.includes("combo-large"));
    assert.ok(!ids.includes("monday-dollar-wings"), "not on a Wednesday");
    assert.ok(!ids.includes("game-day-special"), "long over");
    assert.ok(!ids.some((id: string) => id.startsWith("monday-large") || id.startsWith("game-night")), "counter-only deals never appear");
    const live = (await getPool().query<{ base_price_cents: number }>("SELECT base_price_cents FROM products WHERE id = 'combo-large'")).rows[0];
    assert.equal(deals.data!.deals.find((deal) => deal.productId === "combo-large")!.priceCents, Number(live.base_price_cents), "the live price, not a copy");
    const monday = await call(secret, "add_item", { productId: "monday-dollar-wings", quantity: 10, modifiers: [{ id: "wing-style", values: ["Breaded"] }, { id: "wing-flavours", values: ["Hot"] }] });
    assert.equal(monday.issues?.[0].code, "PRODUCT_OUTSIDE_OFFER_HOURS");
  });
});

// --- conversation state -------------------------------------------------------------------

frozen("add, change, remove and change again: every change is a new version, and the review is the final state", async () => {
  const { secret } = await newSession();
  const started = await startPickup(secret);
  let version = started.cartVersion!;
  const step = async (tool: string, args: Record<string, unknown>) => {
    const result = await call(secret, tool, args);
    assert.ok(result.ok, `${tool}: ${JSON.stringify(result.issues)}`);
    assert.equal(result.cartVersion, version + 1, `${tool} moves the version by one`);
    version = result.cartVersion!;
    return result;
  };
  const first = await step("add_item", { productId: "poutine" });
  const fries = await step("add_item", { productId: "fries" });
  await step("update_item", { lineId: first.data!.lineId, quantity: 2 });
  await step("remove_item", { lineId: fries.data!.lineId });
  await step("add_item", { productId: "wedges" });
  await step("update_item", { lineId: first.data!.lineId, productId: "samosa-poutine", quantity: 1 });
  await step("set_customer", CALLER);
  const review = await call(secret, "review_order");
  assert.deepEqual(review.data!.lines.map((line) => [line.name, line.quantity]), [["Samosa Poutine", 1], ["Wedges", 1]]);
  assert.equal(review.data!.cartVersion, version);
});

frozen("a correction after the read-back needs a new read-back and a new yes", async () => {
  const { secret } = await newSession();
  await startPickup(secret);
  const line = await add(secret, { productId: "poutine" });
  await call(secret, "set_customer", CALLER);
  const first = await call(secret, "review_order");
  // "Actually, make it two."
  assert.ok((await call(secret, "update_item", { lineId: line.data!.lineId, quantity: 2 })).ok);
  const stale = await call(secret, "confirm_order", { cartVersion: first.data!.cartVersion });
  assert.equal(stale.issues?.[0].code, "NOT_REVIEWED");
  const second = await call(secret, "review_order");
  assert.notEqual(second.data!.cartVersion, first.data!.cartVersion);
  assert.match(second.data!.readback, /two Poutine/);
  assert.equal((await call(secret, "confirm_order", { cartVersion: first.data!.cartVersion })).issues?.[0].code, "CART_CHANGED");
  assert.ok((await call(secret, "confirm_order", { cartVersion: second.data!.cartVersion })).ok);
  const placed = await call(secret, "place_order", { cartVersion: second.data!.cartVersion });
  assert.ok(placed.ok);
  const order = await orderByNumber(placed.data!.orderNumber);
  const items = (await getPool().query("SELECT quantity FROM order_items WHERE order_id = $1", [order.id])).rows;
  assert.deepEqual(items.map((row) => Number(row.quantity)), [2]);
});

frozen("changing anything after the yes invalidates it", async () => {
  const { secret } = await newSession();
  await startPickup(secret);
  await add(secret, { productId: "poutine" });
  await call(secret, "set_customer", CALLER);
  const review = await reviewAndConfirm(secret);
  assert.ok((await call(secret, "add_item", { productId: "fries" })).ok);
  const placed = await call(secret, "place_order", { cartVersion: review.data!.cartVersion });
  assert.equal(placed.ok, false);
  assert.ok(["NOT_REVIEWED", "NOT_CONFIRMED", "CART_CHANGED"].includes(placed.issues![0].code));
  // Nor does a new customer name, after a fresh review and yes.
  const again = await reviewAndConfirm(secret);
  assert.ok((await call(secret, "set_customer", { ...CALLER, name: "Jordan C" })).ok);
  assert.equal((await call(secret, "place_order", { cartVersion: again.data!.cartVersion })).ok, false);
});

// --- delivery ------------------------------------------------------------------------------

frozen("delivery is not offered by phone until the owner enables it", async () => {
  const { secret } = await newSession();
  assert.equal((await call(secret, "start_order", { fulfilment: "delivery" })).issues?.[0].code, "VOICE_DELIVERY_UNAVAILABLE");
  await startPickup(secret);
  assert.equal((await call(secret, "set_fulfilment", { fulfilment: "delivery" })).issues?.[0].code, "VOICE_DELIVERY_UNAVAILABLE");
  const status = await call(secret, "get_store_status");
  assert.equal(status.data!.delivery.availableByPhone, false);
  // The address question is still answered honestly.
  const check = await call(secret, "check_delivery_address", STORE_ADDRESS);
  assert.equal(check.data!.addressDeliverable, true);
  assert.equal(check.data!.deliveryAvailableByPhone, false);
  assert.match(check.say!, /pickup orders only/);
});

frozen("with delivery enabled: deliverable and eligible, deliverable but short, outside the area, unreadable", async () => {
  process.env.VOICE_PILOT_FULFILMENTS = "pickup,delivery";
  const { secret } = await newSession();
  assert.ok((await call(secret, "start_order", { fulfilment: "delivery" })).ok);

  // Before the cart reaches the minimum: we deliver there, it is short.
  const short = await call(secret, "check_delivery_address", STORE_ADDRESS);
  assert.equal(short.data!.addressDeliverable, true);
  assert.equal(short.data!.eligible, false);
  assert.equal(short.data!.reason, "below_minimum");
  assert.equal(short.data!.minimumCents, 2000);
  assert.equal(short.data!.shortfallCents, 2000);
  assert.match(short.say!, /we deliver there/);
  await add(secret, { productId: "poutine", quantity: 3 });
  const met = await call(secret, "check_delivery_address", STORE_ADDRESS);
  assert.equal(met.data!.eligible, true);
  assert.equal(met.data!.feeCents, 350);

  const outside = await call(secret, "check_delivery_address", DUNDAS);
  assert.equal(outside.data!.addressDeliverable, false);
  assert.equal(outside.data!.reason, "outside_radius");
  const invalid = await call(secret, "check_delivery_address", { line1: "1", postalCode: "12345" });
  assert.equal(invalid.data!.addressDeliverable, false);
  assert.equal(invalid.data!.reason, "invalid_address");
  assert.match(invalid.say!, /repeat the street/);
});

frozen("a delivery order: address, fee and HST in the read-back, paid to the driver", async () => {
  process.env.VOICE_PILOT_FULFILMENTS = "pickup,delivery";
  const { secret } = await newSession();
  await call(secret, "start_order", { fulfilment: "delivery" });
  const pizza = await call(secret, "search_menu", { query: "large pepperoni" });
  assert.equal(pizza.data!.candidates[0].productId, "large-pizza", "the delivery Pizza by Size, not a pickup special");
  await add(secret, { productId: "large-pizza", toppings: [{ toppingId: "pepperoni", placement: "whole" }] });
  await add(secret, { productId: "poutine" });
  await call(secret, "set_customer", CALLER);
  const reviewBeforeAddress = await call(secret, "review_order");
  assert.equal(reviewBeforeAddress.issues?.[0].code, "ADDRESS_REQUIRED");
  const address = await call(secret, "check_delivery_address", { ...STORE_ADDRESS, instructions: "side door" });
  assert.equal(address.data!.stored, true);
  const { review, placed } = await placeFull(secret);
  assert.equal(review.data!.totals.deliveryFeeCents, 350);
  assert.match(review.data!.readback, /Delivering to Unit 2, 55 Parkdale Ave N, Hamilton, L8H 5W7\./);
  assert.match(review.data!.readback, /delivery \$3\.50/);
  assert.match(review.data!.payment, /driver/);
  const order = await orderByNumber(placed.data!.orderNumber);
  assert.equal(order.fulfilment, "delivery");
  assert.equal(order.channel, "ai_phone");
  assert.equal(order.payment_method, "pay_at_store");
  assert.equal(Number(order.delivery_fee_cents), 350);
  assert.equal(order.instructions, "side door");
  assert.equal(JSON.parse(String(order.address_json)).postalCode, "L8H 5W7");
});

frozen("switching pickup and delivery moves only exactly equivalent pizzas, and blocks the rest", async () => {
  process.env.VOICE_PILOT_FULFILMENTS = "pickup,delivery";
  const { secret } = await newSession();
  await startPickup(secret);
  await add(secret, { productId: "pickup-large-one", toppings: [{ toppingId: "pepperoni", placement: "whole" }] });
  const toDelivery = await call(secret, "set_fulfilment", { fulfilment: "delivery" });
  assert.ok(toDelivery.ok, JSON.stringify(toDelivery.issues));
  assert.deepEqual(toDelivery.data!.remapped, [{ lineId: "L1", from: "pickup-large-one", to: "large-pizza" }]);
  assert.equal(toDelivery.data!.lines[0].name, "Large Pizza");
  assert.equal(toDelivery.stage, "address");
  // Two toppings on a delivery pizza: the 1-item plus one, or the 3-item short one? The caller's choice.
  await call(secret, "update_item", { lineId: "L1", toppings: [{ toppingId: "pepperoni", placement: "whole" }, { toppingId: "onions", placement: "whole" }] });
  const toPickup = await call(secret, "set_fulfilment", { fulfilment: "pickup" });
  assert.equal(toPickup.ok, false);
  assert.equal(toPickup.issues![0].code, "NEEDS_CLARIFICATION");
  assert.equal((await call(secret, "get_cart")).data!.fulfilment, "delivery", "nothing was changed");
  // A pickup-only item has no delivery equivalent at all.
  const other = await newSession();
  await startPickup(other.secret);
  await add(other.secret, { productId: "pickup-one-slice", modifiers: [{ id: "slice-topping", values: ["pepperoni"] }] });
  assert.equal((await call(other.secret, "set_fulfilment", { fulfilment: "delivery" })).issues?.[0].code, "NEEDS_CLARIFICATION");
});

// --- failures ------------------------------------------------------------------------------

frozen("sold-out, inactive, unknown, invalid topping and invalid option are all refused before they reach the cart", async () => {
  const { secret } = await newSession();
  await startPickup(secret);
  await getPool().query("UPDATE products SET sold_out = 1 WHERE id = 'onion-rings'");
  try {
    assert.equal((await call(secret, "add_item", { productId: "onion-rings" })).ok, false);
    const search = await call(secret, "search_menu", { query: "onion rings" });
    assert.equal(search.data!.status, "unavailable");
  } finally {
    await getPool().query("UPDATE products SET sold_out = 0 WHERE id = 'onion-rings'");
  }
  assert.equal((await call(secret, "add_item", { productId: "test-free-delivery-item" })).issues?.[0].code, "PRODUCT_NOT_FOUND", "inactive");
  assert.equal((await call(secret, "add_item", { productId: "lasagna" })).issues?.[0].code, "PRODUCT_NOT_FOUND");
  assert.equal((await call(secret, "add_item", { productId: "DROP TABLE" })).issues?.[0].code, "INVALID_INPUT");
  assert.equal((await call(secret, "add_item", { productId: "pickup-large-one", toppings: [{ toppingId: "caviar", placement: "whole" }] })).ok, false);
  assert.equal((await call(secret, "add_item", { productId: "pickup-large-one", toppings: [{ toppingId: "pepperoni", placement: "middle" }] })).ok, false);
  const option = await call(secret, "add_item", { productId: "24-wings", modifiers: [{ id: "wing-style", values: ["Battered"] }, { id: "wing-flavours", values: ["Hot"] }] });
  assert.equal(option.ok, false);
  const unknownSection = await call(secret, "add_item", { productId: "poutine", modifiers: [{ id: "free-stuff", values: ["yes"] }] });
  assert.equal(unknownSection.ok, false);
  assert.equal((await call(secret, "get_cart")).data!.lines.length, 0);
});

withDb("a closed store and the last-order cutoff stop the review", async () => {
  for (const [instant, code] of [[WEDNESDAY(4 * 60), "SCHEDULE_INVALID"], [WEDNESDAY(22 * 60 - 10), "LAST_ORDERS_CLOSED"]] as const) {
    await at(instant, async () => {
      const { secret } = await newSession();
      await startPickup(secret);
      await add(secret, { productId: "poutine" });
      await call(secret, "set_customer", CALLER);
      const status = await call(secret, "get_store_status");
      assert.equal(status.data!.acceptingOrdersNow, false);
      const review = await call(secret, "review_order");
      assert.equal(review.ok, false);
      assert.ok(review.issues!.some((issue) => issue.code === code || (code === "SCHEDULE_INVALID" && issue.code === "ORDER_VALIDATION_FAILED")), JSON.stringify(review.issues));
    });
  }
});

frozen("something that stops the order between the yes and placement sends it back for review", async () => {
  const { id, secret } = await newSession();
  await startPickup(secret);
  await add(secret, { productId: "wedges" });
  await call(secret, "set_customer", CALLER);
  const review = await reviewAndConfirm(secret);
  await getPool().query("UPDATE products SET sold_out = 1 WHERE id = 'wedges'");
  try {
    const placed = await call(secret, "place_order", { cartVersion: review.data!.cartVersion });
    assert.equal(placed.ok, false);
    const session = (await loadVoiceSession(id))!;
    assert.equal(session.orderId, null);
    assert.equal(session.confirmedVersion, null, "the yes no longer stands");
    assert.equal(session.stage, "building");
  } finally {
    await getPool().query("UPDATE products SET sold_out = 0 WHERE id = 'wedges'");
  }
});

frozen("a total that changed after the yes is never placed", async () => {
  const { id, secret } = await newSession();
  await startPickup(secret);
  await add(secret, { productId: "masala-fries" });
  await call(secret, "set_customer", CALLER);
  const review = await reviewAndConfirm(secret);
  const original = (await getPool().query<{ base_price_cents: number }>("SELECT base_price_cents FROM products WHERE id = 'masala-fries'")).rows[0].base_price_cents;
  await getPool().query("UPDATE products SET base_price_cents = $1 WHERE id = 'masala-fries'", [Number(original) + 100]);
  try {
    const placed = await call(secret, "place_order", { cartVersion: review.data!.cartVersion });
    assert.equal(placed.issues?.[0].code, "TOTAL_CHANGED");
    assert.equal((await loadVoiceSession(id))!.stage, "building");
    // A cheaper total is still a different total: it needs a new yes too.
    await getPool().query("UPDATE products SET base_price_cents = $1 WHERE id = 'masala-fries'", [Number(original) - 100]);
    const again = await reviewAndConfirm(secret);
    await getPool().query("UPDATE products SET base_price_cents = $1 WHERE id = 'masala-fries'", [Number(original)]);
    assert.equal((await call(secret, "place_order", { cartVersion: again.data!.cartVersion })).issues?.[0].code, "TOTAL_CHANGED");
  } finally {
    await getPool().query("UPDATE products SET base_price_cents = $1 WHERE id = 'masala-fries'", [Number(original)]);
  }
});

withDb("a yes more than five minutes old must be given again", async () => {
  const { secret } = await at(NOW, async () => {
    const session = await newSession();
    await startPickup(session.secret);
    await add(session.secret, { productId: "poutine" });
    await call(session.secret, "set_customer", CALLER);
    return session;
  });
  const review = await at(NOW, () => reviewAndConfirm(secret));
  const late = await at(NOW + 6 * 60_000, () => call(secret, "place_order", { cartVersion: review.data!.cartVersion }));
  assert.equal(late.issues?.[0].code, "CONFIRMATION_EXPIRED");
  assert.equal(late.stage, "review", "the read-back stands; only the yes is needed again");
  const confirmed = await at(NOW + 6 * 60_000, () => call(secret, "confirm_order", { cartVersion: review.data!.cartVersion }));
  assert.ok(confirmed.ok);
  assert.ok((await at(NOW + 6 * 60_000, () => call(secret, "place_order", { cartVersion: review.data!.cartVersion }))).ok);
});

frozen("retried and racing placements make exactly one order", async () => {
  const { id, secret } = await newSession();
  await startPickup(secret);
  await add(secret, { productId: "poutine" });
  await call(secret, "set_customer", CALLER);
  const review = await reviewAndConfirm(secret);
  const attempts = await Promise.all([1, 2, 3].map(() => call(secret, "place_order", { cartVersion: review.data!.cartVersion })));
  const numbers = new Set(attempts.filter((attempt) => attempt.ok).map((attempt) => attempt.data!.orderNumber));
  assert.equal(numbers.size, 1, JSON.stringify(attempts.map((attempt) => attempt.issues ?? attempt.data!.orderNumber)));
  for (const attempt of attempts.filter((result) => !result.ok)) assert.equal(attempt.issues![0].code, "PLACEMENT_IN_PROGRESS");
  const retry = await call(secret, "place_order", { cartVersion: review.data!.cartVersion });
  assert.equal(retry.data!.duplicate, true);
  assert.equal(retry.data!.orderNumber, [...numbers][0]);
  const orders = await getPool().query("SELECT id FROM orders WHERE id = (SELECT order_id FROM voice_calls WHERE id = $1)", [id]);
  assert.equal(orders.rows.length, 1);
  const key = await getPool().query("SELECT COUNT(*)::int AS count FROM orders o JOIN order_events e ON e.order_id = o.id WHERE e.actor_id = $1", [id]);
  assert.equal(key.rows[0].count, 1, "one order traced to this session");
  // And nothing more can be ordered on this session.
  assert.equal((await call(secret, "add_item", { productId: "fries" })).issues?.[0].code, "ORDER_ALREADY_PLACED");
  assert.equal((await call(secret, "start_order", { fulfilment: "pickup" })).issues?.[0].code, "ORDER_ALREADY_PLACED");
});

// --- safety: what the caller and the model can never do ------------------------------------------

frozen("no tool accepts a price, subtotal, tax, fee, free delivery, discount, channel or key", async () => {
  const { secret } = await newSession();
  await startPickup(secret);
  const forged = {
    priceCents: 1, unitPriceCents: 1, subtotalCents: 1, menuSubtotalCents: 1, taxCents: 0, deliveryFeeCents: 0,
    freeDelivery: true, discountCents: 5000, couponCode: "FREE", giftCardCode: "X", channel: "walk_in",
    policy: { allowStaffOnlyItems: true }, staffEntry: true, idempotencyKey: "voice:other:1", expectedAmountDueCents: 1,
    totalCents: 1, tip: { type: "none" }, paymentMethod: "online",
  };
  for (const [field, value] of Object.entries(forged)) {
    for (const [tool, args] of [
      ["add_item", { productId: "poutine", [field]: value }],
      ["check_delivery_address", { ...STORE_ADDRESS, [field]: value }],
      ["place_order", { cartVersion: 1, [field]: value }],
      ["review_order", { [field]: value }],
    ] as const) {
      const result = await call(secret, tool, args);
      assert.equal(result.ok, false, `${tool} with ${field}`);
      assert.equal(result.issues![0].code, "FIELD_NOT_ACCEPTED", `${tool} with ${field}`);
      assert.equal(result.issues![0].field, field);
    }
  }
  assert.equal((await call(secret, "get_cart")).data!.lines.length, 0, "nothing was added");
  // Unknown fields are refused too, rather than silently dropped.
  assert.equal((await call(secret, "add_item", { productId: "poutine", sneaky: 1 })).issues?.[0].code, "UNKNOWN_FIELD");
});

frozen("a counter-only product cannot be ordered, even by its exact id", async () => {
  const { secret } = await newSession();
  await startPickup(secret);
  for (const productId of ["chicken-burger", "12-wings", "free-garlic-bread", "dollar-medium-pizza", "monday-large-special"]) {
    const result = await call(secret, "add_item", { productId });
    assert.equal(result.issues?.[0].code, "PRODUCT_NOT_FOUND", productId);
    assert.equal((await call(secret, "get_menu_item", { productId })).issues?.[0].code, "PRODUCT_NOT_FOUND", productId);
  }
});

frozen("nothing is placed without a review and a yes for the current version", async () => {
  const { secret } = await newSession();
  await startPickup(secret);
  await add(secret, { productId: "poutine" });
  await call(secret, "set_customer", CALLER);
  const version = (await call(secret, "get_cart")).cartVersion!;
  assert.equal((await call(secret, "place_order", { cartVersion: version })).issues?.[0].code, "NOT_REVIEWED");
  const review = await call(secret, "review_order");
  assert.equal((await call(secret, "place_order", { cartVersion: review.data!.cartVersion })).issues?.[0].code, "NOT_CONFIRMED");
  assert.equal((await call(secret, "confirm_order", { cartVersion: review.data!.cartVersion - 1 })).issues?.[0].code, "CART_CHANGED");
  assert.ok((await call(secret, "confirm_order", { cartVersion: review.data!.cartVersion })).ok);
  assert.equal((await call(secret, "place_order", { cartVersion: review.data!.cartVersion + 1 })).issues?.[0].code, "CART_CHANGED");
  assert.equal((await call(secret, "place_order", {})).issues?.[0].code, "INVALID_INPUT");
});

frozen("an order over the voice limit is handed to staff", async () => {
  process.env.VOICE_MAX_ORDER_CENTS = "2000";
  const { secret } = await newSession();
  await startPickup(secret);
  await add(secret, { productId: "60-wings", modifiers: [{ id: "wing-style", values: ["Breaded"] }, { id: "wing-flavours", values: ["Hot"] }] });
  await call(secret, "set_customer", CALLER);
  const review = await call(secret, "review_order");
  assert.equal(review.issues?.[0].code, "ORDER_TOO_LARGE");
  assert.equal(review.escalate, true);
});

frozen("three failures in a row tell the agent to hand over", async () => {
  const { secret } = await newSession();
  await startPickup(secret);
  const one = await call(secret, "add_item", { productId: "lasagna" });
  const two = await call(secret, "search_menu", { query: "lasagna" });
  assert.equal(one.escalate, false);
  assert.equal(two.escalate, false);
  const three = await call(secret, "add_item", { productId: "spaghetti" });
  assert.equal(three.escalate, true);
  assert.ok((await call(secret, "add_item", { productId: "poutine" })).ok);
  assert.equal((await call(secret, "add_item", { productId: "lasagna" })).escalate, false, "a success resets the count");
});

frozen("card numbers said aloud never reach the cart, the log or the stored confirmation", async () => {
  const { id, secret } = await newSession();
  await startPickup(secret);
  await add(secret, { productId: "poutine", notes: "extra gravy" });
  const card = await call(secret, "add_item", { productId: "fries", notes: "my card is 4111 1111 1111 1111 cvv 123" });
  assert.equal(card.issues?.[0].code, "PAYMENT_DETAILS_NOT_ACCEPTED");
  assert.doesNotMatch(JSON.stringify((await loadVoiceSession(id))!.cart), /4111/);
  await call(secret, "set_customer", CALLER);
  const review = await call(secret, "review_order");
  await call(secret, "confirm_order", { cartVersion: review.data!.cartVersion, utterance: "yes, charge 4111-1111-1111-1111 exp 12/29" });
  const events = await getPool().query<{ request_json: string; response_json: string }>("SELECT request_json, response_json FROM voice_call_events WHERE voice_call_id = $1", [id]);
  const logged = events.rows.map((row) => row.request_json + row.response_json).join("\n");
  assert.doesNotMatch(logged, /4111/);
  assert.doesNotMatch(logged, /cvv 123/);
  assert.doesNotMatch(logged, /555[- ]?0177/, "phone numbers are masked in the log");
  const stored = (await loadVoiceSession(id))!.confirmationUtterance ?? "";
  assert.doesNotMatch(stored, /4111/);
  assert.doesNotMatch(stored, /12\/29/);
});

// --- the HTTP API ------------------------------------------------------------------------------

const BEARER = "voice-tool-secret-for-tests-0123456789abcdef";

function post(tool: string, body: unknown, headers: Record<string, string> = {}) {
  return toolRoute(
    new Request(`https://order.pizza62.test/api/voice/tools/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ tool }) },
  );
}

frozen("the HTTP API is off by default, then needs the bearer and the call's own session", async () => {
  const a = await newSession();
  const b = await newSession();
  const good = { authorization: `Bearer ${BEARER}`, "x-voice-session": a.secret };

  // Off by default — even with every credential right.
  process.env.VOICE_TOOL_SECRET = BEARER;
  assert.equal((await post("get_store_status", {}, good)).status, 503);
  process.env.VOICE_AI_MODE = "internal";
  delete process.env.VOICE_TOOL_SECRET;
  assert.equal((await post("get_store_status", {}, good)).status, 503, "no configured bearer, nothing authenticates");
  process.env.VOICE_TOOL_SECRET = BEARER;

  assert.equal((await post("get_store_status", {}, { "x-voice-session": a.secret })).status, 401, "missing bearer");
  assert.equal((await post("get_store_status", {}, { authorization: `Bearer ${BEARER}x`, "x-voice-session": a.secret })).status, 401, "wrong bearer");
  assert.equal((await post("get_store_status", {}, { authorization: BEARER, "x-voice-session": a.secret })).status, 401, "not a bearer header");
  assert.equal((await post("get_store_status", {}, { authorization: `Bearer ${BEARER}` })).status, 401, "missing session");
  assert.equal((await post("get_store_status", {}, { authorization: `Bearer ${BEARER}`, "x-voice-session": `${a.secret}x` })).status, 401, "wrong session");
  assert.equal((await post("get_store_status", {}, { authorization: `Bearer ${BEARER}`, "x-voice-session": a.id })).status, 401, "a session id is not a secret");

  const ok = await post("start_order", { fulfilment: "pickup" }, good);
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as Body).ok, true);
  const added = await post("add_item", { productId: "poutine" }, good);
  assert.equal(((await added.json()) as Body).ok, true);

  // Session A's secret acts on A only: B is untouched, and nothing can name B.
  assert.equal((await loadVoiceSession(a.id))!.cart.length, 1);
  assert.equal((await loadVoiceSession(b.id))!.cart.length, 0);
  assert.equal((await loadVoiceSession(b.id))!.stage, "new");
  const crossed = await post("add_item", { productId: "poutine", sessionId: b.id }, good);
  assert.equal(((await crossed.json()) as Body).issues?.[0].code, "UNKNOWN_FIELD");

  assert.equal((await post("make_it_free", {}, good)).status, 404);
  assert.equal((await post("add_item", "{not json", good)).status, 400);
  assert.equal((await post("add_item", JSON.stringify({ notes: "x".repeat(20_000) }), good)).status, 413);
});

withDb("there is no route that mints a voice session", async () => {
  const root = path.join(process.cwd(), "app", "api");
  const routes: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === "route.ts") routes.push(full);
    }
  };
  await walk(root);
  for (const route of routes) {
    const source = await readFile(route, "utf8");
    assert.ok(!source.includes("createVoiceSession"), `${path.relative(process.cwd(), route)} must not mint voice sessions`);
  }
  assert.ok(routes.some((route) => route.includes(path.join("voice", "tools"))), "the tool route exists and was scanned");
  assert.deepEqual([...VOICE_TOOL_NAMES].sort(), [
    "add_item", "check_delivery_address", "confirm_order", "get_cart", "get_deals", "get_menu_item", "get_store_status",
    "place_order", "remove_item", "reset_order", "review_order", "search_menu", "set_customer", "set_fulfilment", "start_order", "update_item",
  ]);
});

frozen("the public order API still cannot make an ai_phone order", async () => {
  const response = await publicOrderRoute(
    new Request("https://order.pizza62.test/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": `198.18.9.${Math.floor(Math.random() * 200)}` },
      body: JSON.stringify({
        fulfilment: "pickup",
        items: [{ productId: "poutine", quantity: 1 }],
        paymentMethod: "pay_at_store",
        schedule: { type: "asap" },
        customer: { ...CALLER, email: "jordan@example.test" },
        idempotencyKey: `voice-public-${crypto.randomUUID()}`,
        channel: "ai_phone",
        context: { policy: { channel: "ai_phone" } },
      }),
    }),
  );
  assert.equal(response.status, 201);
  const { orderNumber } = (await response.json()) as { orderNumber: string };
  assert.equal((await orderByNumber(orderNumber)).channel, "online");
});

// --- the readiness proof -------------------------------------------------------------------------

frozen("READINESS: a synthetic voice session takes a real order into the existing engine and alert outbox, once", async () => {
  const { id, secret } = await newSession({ provider: "simulator" });
  // Store open?
  assert.equal((await call(secret, "get_store_status")).data!.acceptingOrdersNow, true);
  // Search, configure, add.
  await startPickup(secret);
  const search = await call(secret, "search_menu", { query: "a large hawaiian, no ham" });
  assert.equal(search.data!.status, "match");
  const [hawaiian] = search.data!.candidates;
  const item = await call(secret, "get_menu_item", { productId: hawaiian.productId });
  assert.deepEqual(item.data!.pizza.recipe.map((topping) => topping.toppingId), ["ham", "pineapple", "real-bacon"]);
  const added = await add(secret, { productId: hawaiian.productId, variationId: hawaiian.variationId, omitToppings: hawaiian.detected.omitToppings.map((topping) => topping.toppingId) });
  assert.equal(added.data!.totals.subtotalCents, 1999, "the server quote, from the live price");
  await add(secret, WINGS_24());
  await call(secret, "set_customer", CALLER);
  // The server's read-back, the caller's yes, the placement.
  const { review, placed } = await placeFull(secret);
  assert.match(review.data!.readback, /one Large Hawaiian — No Ham; Toppings: Pineapple, Real Bacon/);
  // createOrder made an ai_phone order …
  const order = await orderByNumber(placed.data!.orderNumber);
  assert.equal(order.channel, "ai_phone");
  assert.equal(Number(order.total_cents), review.data!.totals.amountDueCents);
  const events = (await getPool().query("SELECT actor_type, actor_id FROM order_events WHERE order_id = $1", [order.id])).rows;
  assert.deepEqual(events, [{ actor_type: "ai_receptionist", actor_id: id }]);
  // … with the existing restaurant alert queued in the existing outbox …
  const outbox = (await getPool().query("SELECT kind FROM notification_outbox WHERE payload_json::jsonb->>'orderId' = $1", [order.id])).rows;
  assert.deepEqual(outbox.map((row) => row.kind), ["restaurant_new_order"]);
  // … and placing again does not place again.
  const again = await call(secret, "place_order", { cartVersion: review.data!.cartVersion });
  assert.equal(again.data!.duplicate, true);
  assert.equal(again.data!.orderNumber, placed.data!.orderNumber);
  const count = (await getPool().query("SELECT COUNT(*)::int AS count FROM voice_calls WHERE id = $1 AND order_id = $2", [id, order.id])).rows[0];
  assert.equal(count.count, 1);
  const log = (await getPool().query("SELECT tool FROM voice_call_events WHERE voice_call_id = $1 AND event_type = 'tool' ORDER BY created_at, id", [id])).rows;
  assert.ok(log.length >= 9, "every tool call was logged");
});
