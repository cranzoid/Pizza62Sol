/**
 * Voice ↔ website functional parity.
 *
 * The phone agent must be able to do what a customer can do on the website's
 * ordering flow — schedule an order for later, use a promo code, tip, choose
 * light or no cheese — through the same backend contract, with the server
 * deciding every amount and every time. These tests drive the real voice tools
 * against the real engine and compare what they produce with what the public
 * website quote produces for the same cart, choice for choice.
 *
 * Sections follow docs/VOICE-WEB-PARITY.md §10: A parity, B schedule, C pizza,
 * F coupons, G gift cards, H tips, I payment and data handling, J
 * confirmation, K security, plus the business information the agent answers
 * questions from. Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before, mock } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { createVoiceSession, loadVoiceSession } = await import("@/lib/voice/session");
const { runVoiceTool } = await import("@/lib/voice/tools");
const { POST: toolRoute } = await import("@/app/api/voice/tools/[tool]/route");
const { POST: publicQuoteRoute } = await import("@/app/api/orders/quote/route");
const { parseDay, parseTime, resolveSlot, orderSlots, upcomingDays } = await import("@/lib/voice/schedule");
const { REGULAR_HOURS } = await import("@/lib/launch-config");
const { nextOrderSlots } = await import("@/lib/domain");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

before(() => {
  for (const key of ["EMAIL_API_KEY", "TWILIO_ACCOUNT_SID", "RESTAURANT_ALERT_PHONE"]) delete process.env[key];
});
after(async () => {
  await closePool();
});
afterEach(() => {
  mock.timers.reset();
  for (const key of ["VOICE_AI_MODE", "VOICE_TOOL_SECRET", "VOICE_PILOT_FULFILMENTS", "PUBLIC_BASE_URL"]) delete process.env[key];
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

/** Local Toronto wall-clock time, written with its offset so the suite does not depend on the machine's zone. */
const toronto = (iso: string) => Date.parse(iso);
const WEDNESDAY_6PM = toronto("2026-10-14T18:00:00-04:00");
const WEDNESDAY_11_30PM = toronto("2026-10-14T23:30:00-04:00");
const WEDNESDAY_9_42PM = toronto("2026-10-14T21:42:00-04:00");
const WEDNESDAY_9AM = toronto("2026-10-14T09:00:00-04:00");

async function at<T>(instant: number, body: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["Date"], now: instant });
  try {
    return await body();
  } finally {
    mock.timers.reset();
  }
}
const frozen = (name: string, body: () => Promise<void>, instant = WEDNESDAY_6PM) => withDb(name, () => at(instant, body));

type Data = Record<string, unknown> & {
  cartVersion: number;
  readback: string;
  totals: Record<string, number>;
  lines: Array<{ lineId: string; name: string; lineTotalCents: number; notes: string | null; flags: string[] }>;
  schedule: { type: string; at?: number; when?: string };
  coupon: { code: string; status: string; message: string | null } | null;
  suggestions: Array<{ at: number; when: string }>;
  reason: string;
  orderNumber: string;
  pizza: { cheese: { options: string[] } | null };
};
type Body = { ok: boolean; data?: Data; issues?: Array<{ code: string; message: string; field?: string }>; say?: string; escalate: boolean; cartVersion: number; stage: string };

async function call(secret: string, tool: string, args: unknown = {}): Promise<Body> {
  return (await runVoiceTool(tool, secret, args)).body as Body;
}
async function ok(secret: string, tool: string, args: unknown = {}): Promise<Body> {
  const body = await call(secret, tool, args);
  assert.ok(body.ok, `${tool}: ${JSON.stringify(body.issues ?? body.say)}`);
  return body;
}
async function newSession() {
  const { session, sessionSecret } = await createVoiceSession({ provider: "test", mode: "test" });
  return { id: session.id, secret: sessionSecret };
}
const CALLER = { name: "Jordan Caller", phone: "905-555-0177" };
const issueCodes = (body: Body) => (body.issues ?? []).map((issue) => issue.code);

/** The public website's quote for a body, exactly as the browser asks for it. */
async function websiteQuote(body: Record<string, unknown>) {
  const response = await publicQuoteRoute(new Request("https://pizza62.test/api/orders/quote", {
    method: "POST",
    headers: { "content-type": "application/json", "x-azure-clientip": `198.18.20.${Math.floor(Math.random() * 200)}` },
    body: JSON.stringify(body),
  }));
  assert.equal(response.status, 200);
  return (await response.json()) as {
    ok: boolean;
    lines: Array<{ productId: string; unitPriceCents: number; lineTotalCents: number }>;
    totals: Record<string, number>;
    appliedPromotions: Array<{ name: string; discountCents: number }>;
    coupon: { code: string; status: string } | null;
    issues: Array<{ code: string }>;
  };
}

async function withPromotion<T>(row: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  const id = `test-voice-${crypto.randomUUID()}`;
  const now = Date.now();
  await getPool().query(
    `INSERT INTO promotions (id, name, code, type, amount, priority, combinable, exclusive, active, starts_at, ends_at,
       rule_json, min_subtotal_cents, fulfilment, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,0,1,0,$6,$7,$8,$9,$10,$11,$12,$12)`,
    [id, row.name ?? "Test promotion", row.code ?? null, row.type ?? "percentage", row.amount ?? 1000, row.active ?? 1,
      row.startsAt ?? null, row.endsAt ?? null, JSON.stringify(row.rule ?? {}), row.minimum ?? 0, row.fulfilment ?? "any", now],
  );
  try {
    return await body();
  } finally {
    await getPool().query("DELETE FROM promotions WHERE id = $1", [id]);
  }
}

async function withClosure<T>(startsAt: number, endsAt: number, body: () => Promise<T>, message = "We're closed for a private event."): Promise<T> {
  const id = `test-voice-${crypto.randomUUID()}`;
  await getPool().query(
    `INSERT INTO store_closures (id, starts_at, ends_at, scope, reason, customer_message, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,'both','Private event',$4,'test',$5,$5)`,
    [id, startsAt, endsAt, message, Date.now()],
  );
  try {
    return await body();
  } finally {
    await getPool().query("DELETE FROM store_closures WHERE id = $1", [id]);
  }
}

// --- A. the same cart costs the same on both channels -------------------------------------

/**
 * Each case is one cart, written once in the voice tools' terms and once in the
 * website's (`toOrderItems` in app/menu/ItemCustomizer.tsx), with the same
 * checkout choices. The voice review must match the website quote line for
 * line and cent for cent.
 */
const PARITY_CASES: Array<{
  name: string;
  fulfilment: "pickup" | "delivery";
  voice: Array<Record<string, unknown>>;
  website: Array<Record<string, unknown>>;
  coupon?: string;
  tip?: { voice: Record<string, unknown>; website: Record<string, unknown> };
  schedule?: { day: string; time: string; scheduledFor: number };
}> = [
  {
    name: "a half-and-half pizza with extra cheese, crust and bake choices",
    fulfilment: "pickup",
    voice: [{
      productId: "pickup-large-three",
      toppings: [{ toppingId: "pepperoni", placement: "left" }, { toppingId: "mushrooms", placement: "right" }, { toppingId: "real-chicken", placement: "whole" }],
      cheese: "extra",
      modifiers: [{ id: "pizza-crust", values: [{ value: "Thin Crust" }] }, { id: "pizza-bake-sauce", values: [{ value: "Well Done" }] }],
    }],
    website: [{
      productId: "pickup-large-three",
      variationId: "pickup-large-three-size",
      quantity: 1,
      toppings: [{ toppingId: "pepperoni", placement: "left" }, { toppingId: "mushrooms", placement: "right" }, { toppingId: "real-chicken", placement: "whole" }],
      extraCheese: true,
      modifiers: [{ id: "pizza-crust", values: ["Thin Crust"] }, { id: "pizza-bake-sauce", values: ["Well Done"] }],
    }],
  },
  {
    name: "a specialty with an omission, light cheese and a note, plus wings, with a 15% tip",
    fulfilment: "pickup",
    voice: [
      { productId: "specialty-hawaiian", variationId: "specialty-hawaiian-large", omitToppings: ["ham"], cheese: "light", notes: "cut into squares" },
      { productId: "24-wings", quantity: 2, modifiers: [{ id: "wing-style", values: ["Breaded"] }, { id: "wing-flavours", values: ["Honey Garlic", "Hot"] }] },
    ],
    website: [
      { productId: "specialty-hawaiian", variationId: "specialty-hawaiian-large", quantity: 1, toppings: [{ toppingId: "ham", placement: "whole" }, { toppingId: "pineapple", placement: "whole" }, { toppingId: "real-bacon", placement: "whole" }], omitToppings: ["ham"], specialInstructions: "Light Cheese · cut into squares" },
      { productId: "24-wings", quantity: 2, modifiers: [{ id: "wing-style", values: ["Breaded"] }, { id: "wing-flavours", values: ["Honey Garlic", "Hot"] }] },
    ],
    tip: { voice: { type: "percentage", percent: 15 }, website: { type: "percentage", valueBps: 1500 } },
  },
  {
    name: "a promo code on its eligible item, a custom tip, scheduled for tomorrow",
    fulfilment: "pickup",
    voice: [{ productId: "pickup-large-one", toppings: [{ toppingId: "pepperoni", placement: "whole" }] }, { productId: "garlic-bread" }],
    website: [{ productId: "pickup-large-one", variationId: "pickup-large-one-size", quantity: 1, toppings: [{ toppingId: "pepperoni", placement: "whole" }] }, { productId: "garlic-bread", quantity: 1 }],
    coupon: "THANKS62",
    tip: { voice: { type: "custom", amount: "4.25" }, website: { type: "custom", amountCents: 425 } },
    schedule: { day: "tomorrow", time: "17:45", scheduledFor: toronto("2026-10-15T17:45:00-04:00") },
  },
  {
    name: "a free-delivery deal with its required choices, and wings, on a delivery order",
    fulfilment: "delivery",
    voice: [
      {
        productId: "hamilton-hero-deal",
        modifiers: [
          { id: "pizza-cheese", values: [{ value: "Light Cheese" }] },
          { id: "pizza-toppings", values: [{ value: "pepperoni", placement: "left" }, { value: "mushrooms" }] },
        ],
      },
      { productId: "24-wings", modifiers: [{ id: "wing-style", values: ["Classic (non-breaded)"] }, { id: "wing-flavours", values: ["Mild"] }] },
    ],
    website: [
      {
        productId: "hamilton-hero-deal",
        quantity: 1,
        modifiers: [{ id: "pizza-cheese", values: ["Light Cheese"] }, { id: "pizza-toppings", values: [{ value: "pepperoni", placement: "left" }, { value: "mushrooms", placement: "whole" }] }],
      },
      { productId: "24-wings", quantity: 1, modifiers: [{ id: "wing-style", values: ["Classic (non-breaded)"] }, { id: "wing-flavours", values: ["Mild"] }] },
    ],
  },
];

for (const scenario of PARITY_CASES) {
  frozen(`PARITY: ${scenario.name}`, async () => {
    process.env.VOICE_PILOT_FULFILMENTS = "pickup,delivery";
    const { secret } = await newSession();
    await ok(secret, "start_order", { fulfilment: scenario.fulfilment });
    // A deal's sections are read from the live menu rather than assumed here.
    for (const line of scenario.voice) {
      const item = await ok(secret, "get_menu_item", { productId: line.productId });
      const sectionIds = (item.data!.sections as Array<{ id: string }>).map((section) => section.id);
      for (const modifier of (line.modifiers as Array<{ id: string }> | undefined) ?? []) assert.ok(sectionIds.includes(modifier.id), `${modifier.id} is a real section of ${line.productId}`);
      await ok(secret, "add_item", line);
    }
    if (scenario.coupon) await ok(secret, "apply_coupon", { code: scenario.coupon.toLowerCase() });
    if (scenario.tip) await ok(secret, "set_tip", scenario.tip.voice);
    if (scenario.schedule) await ok(secret, "set_schedule", { when: "scheduled", day: scenario.schedule.day, time: scenario.schedule.time });
    await ok(secret, "set_customer", CALLER);
    if (scenario.fulfilment === "delivery") await ok(secret, "check_delivery_address", { line1: "55 Parkdale Ave N", postalCode: "L8H 5W7" });
    const review = await ok(secret, "review_order");

    const website = await websiteQuote({
      fulfilment: scenario.fulfilment,
      items: scenario.website,
      ...(scenario.coupon ? { couponCode: scenario.coupon } : {}),
      tip: scenario.tip?.website ?? { type: "none" },
      schedule: scenario.schedule ? { type: "scheduled", scheduledFor: scenario.schedule.scheduledFor } : { type: "asap" },
    });
    assert.equal(website.ok, true, JSON.stringify(website.issues));
    const voice = review.data!;
    assert.deepEqual(voice.lines.map((line) => line.lineTotalCents), website.lines.map((line) => line.lineTotalCents), "every line prices the same");
    const totals = voice.totals;
    assert.equal(totals.subtotalCents, website.totals.menuSubtotalCents, "subtotal");
    assert.equal(totals.discountCents, website.totals.discountCents, "discount");
    assert.equal(totals.deliveryFeeCents, website.totals.deliveryFeeCents, "delivery fee");
    assert.equal(totals.taxCents, website.totals.taxCents, "tax");
    assert.equal(totals.tipCents, website.totals.tipCents, "tip");
    assert.equal(totals.totalCents, website.totals.totalCents, "total");
    assert.equal(totals.amountDueCents, website.totals.amountDueCents, "amount due");
    assert.deepEqual(voice.promotions, website.appliedPromotions.map((promotion) => promotion.name), "the same promotions apply");
    if (scenario.coupon) assert.equal(website.coupon?.status, "applied");
  });
}

frozen("PARITY: an automatic promotion applies to a voice order exactly as to a website order", async () => {
  await withPromotion({ name: "Test 10% off pickup over $30", type: "percentage", amount: 1000, minimum: 3000, fulfilment: "pickup" }, async () => {
    const { secret } = await newSession();
    await ok(secret, "start_order", { fulfilment: "pickup" });
    await ok(secret, "add_item", { productId: "24-wings", modifiers: [{ id: "wing-style", values: ["Breaded"] }, { id: "wing-flavours", values: ["Mild"] }] });
    await ok(secret, "set_customer", CALLER);
    const review = await ok(secret, "review_order");
    const website = await websiteQuote({ fulfilment: "pickup", items: [{ productId: "24-wings", quantity: 1, modifiers: [{ id: "wing-style", values: ["Breaded"] }, { id: "wing-flavours", values: ["Mild"] }] }] });
    assert.ok(website.totals.discountCents > 0);
    assert.equal(review.data!.totals.discountCents, website.totals.discountCents);
    assert.equal(review.data!.totals.amountDueCents, website.totals.amountDueCents);
    assert.match(review.data!.readback, /discount \$\d+\.\d\d \(Test 10% off pickup over \$30\)/);
  });
});

// --- B. scheduled orders --------------------------------------------------------------------

test("schedule words: days and times are read, never guessed", () => {
  const now = WEDNESDAY_6PM;
  assert.equal(parseDay("today", now), "2026-10-14");
  assert.equal(parseDay("Tonight", now), "2026-10-14");
  assert.equal(parseDay("tomorrow", now), "2026-10-15");
  assert.equal(parseDay("Wednesday", now), "2026-10-14", "today's weekday is today");
  assert.equal(parseDay("monday", now), "2026-10-19");
  assert.equal(parseDay("2026-10-20", now), "2026-10-20");
  assert.equal(parseDay("2026-02-30", now), null);
  assert.equal(parseDay("next week", now), null);
  assert.equal(parseTime("17:45"), 17 * 60 + 45);
  assert.equal(parseTime("5:45 PM"), 17 * 60 + 45);
  assert.equal(parseTime("5:45 p.m."), 17 * 60 + 45);
  assert.equal(parseTime("11:30am"), 11 * 60 + 30);
  assert.equal(parseTime("12 pm"), 12 * 60);
  assert.equal(parseTime("12:15 am"), 15);
  assert.equal(parseTime("noon"), 720);
  assert.equal(parseTime("5:45"), 5 * 60 + 45, "a bare time is read as written, then refused as outside hours");
  assert.equal(parseTime("25:00"), null);
  assert.equal(parseTime("half five"), null);
});

test("schedule slots are the website's own nextOrderSlots, less closures, across daylight saving", () => {
  const hours = [...REGULAR_HOURS];
  // Saturday 31 October 2026, 11:30 PM EDT. Clocks go back at 2 AM on Sunday 1 November.
  const saturdayNight = toronto("2026-10-31T23:30:00-04:00");
  const sunday = resolveSlot("tomorrow", "12:00", { now: saturdayNight, hours, closures: [], fulfilment: "pickup", leadMinutes: 15 });
  assert.deepEqual(sunday, { ok: true, slot: toronto("2026-11-01T12:00:00-05:00") }, "noon on Sunday is EST, an hour later in UTC");
  const monday = resolveSlot("monday", "11:15", { now: saturdayNight, hours, closures: [], fulfilment: "pickup", leadMinutes: 15 });
  assert.deepEqual(monday, { ok: true, slot: toronto("2026-11-02T11:15:00-05:00") });
  // Spring forward, Sunday 14 March 2027 at 2 AM: Saturday evening's "tomorrow" is EDT, an hour earlier in UTC.
  const saturday = toronto("2027-03-13T20:00:00-05:00");
  assert.deepEqual(resolveSlot("tomorrow", "1:30 pm", { now: saturday, hours, closures: [], fulfilment: "pickup", leadMinutes: 15 }), { ok: true, slot: toronto("2027-03-14T13:30:00-04:00") });

  const now = WEDNESDAY_6PM;
  type StoreClosure = Parameters<typeof orderSlots>[0]["closures"][number];
  const settings = { now, hours, closures: [] as StoreClosure[], fulfilment: "pickup" as const, leadMinutes: 15 };
  const slots = orderSlots(settings);
  assert.equal(slots[0], toronto("2026-10-14T18:15:00-04:00"), "the first slot respects the lead time and the 15-minute grid");
  assert.ok(slots.every((slot) => (slot / 60_000) % 15 === 0));
  const refusal = (day: string, time: string, extra: Partial<typeof settings> = {}) => {
    const result = resolveSlot(day, time, { ...settings, ...extra });
    assert.equal(result.ok, false);
    return result as Extract<typeof result, { ok: false }>;
  };
  assert.equal(refusal("today", "17:00").reason, "past");
  assert.equal(refusal("today", "18:05").reason, "too_soon");
  assert.equal(refusal("tomorrow", "10:30").reason, "outside_hours", "before opening");
  assert.equal(refusal("today", "23:30", { now: WEDNESDAY_9AM }).reason, "outside_hours", "after closing, on a day the website still lists");
  assert.equal(refusal("tomorrow", "23:30").reason, "beyond_horizon", "past the last time the checkout lists");
  assert.equal(refusal("tomorrow", "17:40").reason, "off_grid");
  assert.deepEqual(refusal("tomorrow", "17:40").suggestions, [toronto("2026-10-15T17:30:00-04:00"), toronto("2026-10-15T17:45:00-04:00")]);
  assert.equal(refusal("2026-10-30", "12:00").reason, "beyond_horizon");
  assert.equal(refusal("someday", "12:00").reason, "invalid_day");
  const closure = { id: "c", startsAt: toronto("2026-10-15T00:00:00-04:00"), endsAt: toronto("2026-10-16T00:00:00-04:00"), scope: "both" as const, reason: "Holiday", customerMessage: null };
  assert.equal(refusal("tomorrow", "17:45", { closures: [closure] }).reason, "closure");
  assert.ok(orderSlots({ ...settings, closures: [closure] }).every((slot) => slot < closure.startsAt || slot >= closure.endsAt));
  const deliveryOnly = { ...closure, scope: "delivery" as const };
  assert.equal(resolveSlot("tomorrow", "17:45", { ...settings, closures: [deliveryOnly] }).ok, true, "a delivery closure leaves pickup open");
});

test("voice offers exactly the times the website's checkout dropdown lists, no further", () => {
  const hours = [...REGULAR_HOURS];
  const now = WEDNESDAY_6PM;
  const settings = { now, hours, closures: [], fulfilment: "pickup" as const, leadMinutes: 15 };
  // CustomerApp calls nextOrderSlots with exactly these four arguments.
  const dropdown = nextOrderSlots({ now, hours, timeZone: "America/Toronto", leadMinutes: 15 });
  assert.equal(dropdown.length, 48);
  assert.deepEqual(orderSlots(settings), dropdown, "same function, same arguments, same list");

  const last = dropdown[dropdown.length - 1];
  // The server would accept a Monday slot (its own bound is 14 days), but the website never shows it.
  const monday = resolveSlot("monday", "12:00", settings);
  assert.equal(monday.ok, false);
  assert.equal((monday as { reason: string }).reason, "beyond_horizon");
  assert.deepEqual((monday as { suggestions: number[] }).suggestions, [last], "the refusal offers the last time the website offers");
  // The last visible slot is takeable; the next grid step after it is not.
  assert.deepEqual(resolveSlot("tomorrow", "18:45", settings), { ok: true, slot: last });
  const after = resolveSlot("tomorrow", "19:00", settings);
  assert.equal((after as { reason: string }).reason, "beyond_horizon");
});

frozen("ASAP while open; a time later today; a time tomorrow; each moves the version", async () => {
  const { secret } = await newSession();
  await ok(secret, "start_order", { fulfilment: "pickup" });
  assert.equal(issueCodes(await call(secret, "set_schedule", { when: "scheduled", day: "today", time: "19:30" })).length, 0);
  const later = await call(secret, "get_cart");
  assert.equal(later.data!.schedule.when, "today at 7:30 PM");
  const tomorrow = await ok(secret, "set_schedule", { when: "scheduled", day: "tomorrow", time: "11:30 am" });
  assert.equal(tomorrow.data!.schedule.at, toronto("2026-10-15T11:30:00-04:00"));
  assert.equal(tomorrow.cartVersion, later.cartVersion + 1);
  const asap = await ok(secret, "set_schedule", { when: "asap" });
  assert.equal(asap.data!.schedule.type, "asap");
  assert.match(asap.say!, /about 15 minutes/);
});

withDb("a caller can order for later while the store is closed, exactly as on the website", async () => {
  await at(WEDNESDAY_11_30PM, async () => {
    const { secret } = await newSession();
    const status = await ok(secret, "get_store_status");
    assert.equal(status.data!.acceptingOrdersNow, false);
    assert.equal(status.data!.acceptingScheduledOrders, true);
    assert.match(status.say!, /earliest time is tomorrow at 11:00 AM/);
    const slots = await ok(secret, "get_order_slots", { day: "tomorrow" });
    assert.equal((slots.data!.day as { times: string[] }).times[0], "11:00 AM");
    await ok(secret, "start_order", { fulfilment: "pickup" });
    await ok(secret, "add_item", { productId: "poutine" });
    await ok(secret, "set_customer", CALLER);
    const asap = await call(secret, "set_schedule", { when: "asap" });
    assert.deepEqual(issueCodes(asap), ["ASAP_UNAVAILABLE"]);
    const blocked = await call(secret, "review_order");
    assert.equal(issueCodes(blocked)[0], "SCHEDULE_REQUIRED");
    assert.match(blocked.say!, /earliest time is tomorrow at 11:00 AM/);
    await ok(secret, "set_schedule", { when: "scheduled", day: "tomorrow", time: "11:00" });
    const review = await ok(secret, "review_order");
    assert.match(review.data!.readback, /^Here is your pickup order, for tomorrow at 11:00 AM\./);
    assert.match(review.data!.readback, /It will be ready for pickup tomorrow at 11:00 AM\./);
    await ok(secret, "confirm_order", { cartVersion: review.data!.cartVersion, utterance: "yes" });
    const placed = await ok(secret, "place_order", { cartVersion: review.data!.cartVersion });
    assert.match(placed.say!, /ready for pickup tomorrow at 11:00 AM/);
    const order = (await getPool().query("SELECT schedule_type, scheduled_for, estimated_for, channel FROM orders WHERE order_number = $1", [placed.data!.orderNumber])).rows[0];
    assert.equal(order.schedule_type, "scheduled");
    assert.equal(Number(order.scheduled_for), toronto("2026-10-15T11:00:00-04:00"));
    assert.equal(Number(order.estimated_for), toronto("2026-10-15T11:00:00-04:00"));
    assert.equal(order.channel, "ai_phone");
  });
});

withDb("before opening, ASAP is refused and the first slot of the day is offered", async () => {
  await at(WEDNESDAY_9AM, async () => {
    const { secret } = await newSession();
    const slots = await ok(secret, "get_order_slots", {});
    assert.equal(slots.data!.asapAvailable, false);
    assert.equal((slots.data!.earliest as { when: string }).when, "today at 11:00 AM");
  });
});

withDb("past the last-order cutoff, ASAP is over but the website's remaining slots are not", async () => {
  await at(WEDNESDAY_9_42PM, async () => {
    const { secret } = await newSession();
    const status = await ok(secret, "get_store_status");
    assert.equal(status.data!.asapCutoffPassed, true);
    // The cutoff stops ASAP only. The website still offers 10:00 PM, its last slot inside opening hours.
    assert.match(status.say!, /^Last orders have gone in for tonight\. I can take a pickup order for later; the earliest time is today at 10:00 PM\./);
    await ok(secret, "start_order", { fulfilment: "pickup" });
    assert.deepEqual(issueCodes(await call(secret, "set_schedule", { when: "asap" })), ["ASAP_UNAVAILABLE"]);
    const tonight = await ok(secret, "set_schedule", { when: "scheduled", day: "today", time: "22:00" });
    assert.equal(tonight.data!.schedule.at, toronto("2026-10-14T22:00:00-04:00"));
    const tomorrow = await ok(secret, "set_schedule", { when: "scheduled", day: "tomorrow", time: "11:00" });
    assert.equal(tomorrow.data!.schedule.at, toronto("2026-10-15T11:00:00-04:00"));
  });
});

frozen("a closure refuses its window with the closure's own words, and is caught again at review", async () => {
  const { secret } = await newSession();
  await ok(secret, "start_order", { fulfilment: "pickup" });
  await ok(secret, "add_item", { productId: "poutine" });
  await ok(secret, "set_customer", CALLER);
  await ok(secret, "set_schedule", { when: "scheduled", day: "tomorrow", time: "18:00" });
  await withClosure(toronto("2026-10-15T17:00:00-04:00"), toronto("2026-10-15T20:00:00-04:00"), async () => {
    const refused = await call(secret, "set_schedule", { when: "scheduled", day: "tomorrow", time: "18:30" });
    assert.equal(refused.data!.reason, "closure");
    assert.match(refused.say!, /^We're closed for a private event\. Would tomorrow at 4:30 PM or tomorrow at 4:45 PM work\?$/);
    const review = await call(secret, "review_order");
    assert.equal(issueCodes(review)[0], "TIME_UNAVAILABLE", "the stored 6:00 PM slot is now inside the closure");
    assert.ok(issueCodes(review).includes("STORE_CLOSED"), "and the engine refuses it too");
  });
});

frozen("ordinary schedule refusals are answers, not failures: they never hand the caller to staff", async () => {
  const { secret } = await newSession();
  await ok(secret, "start_order", { fulfilment: "pickup" });
  for (const time of ["17:40", "17:50", "18:05", "04:00"]) {
    const refused = await call(secret, "set_schedule", { when: "scheduled", day: "tomorrow", time });
    assert.equal(refused.ok, false);
    assert.equal(refused.escalate, false);
  }
});

frozen("a model can never send a timestamp, and a stale version is refused", async () => {
  const { secret } = await newSession();
  const started = await ok(secret, "start_order", { fulfilment: "pickup" });
  const forged = await call(secret, "set_schedule", { when: "scheduled", scheduledFor: toronto("2026-10-15T03:00:00-04:00") });
  assert.deepEqual(forged.issues?.map((issue) => [issue.code, issue.field]), [["FIELD_NOT_ACCEPTED", "scheduledFor"]]);
  await ok(secret, "add_item", { productId: "poutine" });
  const stale = await call(secret, "set_schedule", { when: "scheduled", day: "tomorrow", time: "12:00", expectedCartVersion: started.cartVersion });
  assert.deepEqual(issueCodes(stale), ["CART_CHANGED"]);
});

// --- C. pizza customization ---------------------------------------------------------------

frozen("the cheese step: none and light go on the ticket as the website writes them, extra is priced", async () => {
  const { secret } = await newSession();
  await ok(secret, "start_order", { fulfilment: "pickup" });
  const item = await ok(secret, "get_menu_item", { productId: "specialty-hawaiian" });
  assert.deepEqual(item.data!.pizza.cheese!.options, ["none", "light", "regular", "extra"]);
  const none = await ok(secret, "add_item", { productId: "specialty-hawaiian", variationId: "specialty-hawaiian-large", cheese: "none", notes: "cut into squares" });
  const regular = await ok(secret, "add_item", { productId: "specialty-hawaiian", variationId: "specialty-hawaiian-large" });
  const extra = await ok(secret, "add_item", { productId: "specialty-hawaiian", variationId: "specialty-hawaiian-large", cheese: "extra" });
  const lines = (await ok(secret, "get_cart")).data!.lines;
  assert.equal(lines[0].notes, "No Cheese · cut into squares");
  assert.equal(lines[0].lineTotalCents, lines[1].lineTotalCents, "no cheese is not a discount");
  assert.ok(lines[2].flags.includes("Extra cheese"));
  // Extra cheese is one topping unit: inside the Hawaiian's four-unit allowance it is free;
  // past a 1-item pizza's allowance it costs that size's extra-topping rate.
  assert.equal(lines[2].lineTotalCents, lines[1].lineTotalCents);
  const plain = await ok(secret, "add_item", { productId: "pickup-large-one", toppings: [{ toppingId: "pepperoni" }] });
  const cheesy = await ok(secret, "add_item", { productId: "pickup-large-one", toppings: [{ toppingId: "pepperoni" }], cheese: "extra" });
  const priceOf = (body: Body) => body.data!.lines.find((line) => line.lineId === body.data!.lineId)!.lineTotalCents;
  assert.equal(priceOf(cheesy) - priceOf(plain), 230, "charged as one extra topping at the large rate");
  await ok(secret, "remove_item", { lineId: String(plain.data!.lineId) });
  await ok(secret, "remove_item", { lineId: String(cheesy.data!.lineId) });
  const light = await ok(secret, "update_item", { lineId: String(none.data!.lineId), cheese: "light" });
  assert.equal(light.data!.lines[0].notes, "Light Cheese · cut into squares");
  const back = await ok(secret, "update_item", { lineId: String(none.data!.lineId), cheese: "regular" });
  assert.equal(back.data!.lines[0].notes, "cut into squares");
  assert.ok(regular.ok && extra.ok);
  // Not a choice an item without the step has, and never two answers at once.
  const wings = await call(secret, "add_item", { productId: "24-wings", cheese: "none", modifiers: [{ id: "wing-style", values: ["Breaded"] }, { id: "wing-flavours", values: ["Mild"] }] });
  assert.deepEqual(issueCodes(wings), ["CHEESE_NOT_OFFERED"]);
  const conflicted = await call(secret, "add_item", { productId: "specialty-hawaiian", variationId: "specialty-hawaiian-large", cheese: "none", extraCheese: true });
  assert.deepEqual(conflicted.issues?.map((issue) => issue.field), ["cheese"]);
  await ok(secret, "update_item", { lineId: String(none.data!.lineId), cheese: "light" });
  const review = await ok(secret, "set_customer", CALLER).then(() => ok(secret, "review_order"));
  assert.match(review.data!.readback, /note: Light Cheese, cut into squares/);
});

frozen("spoken pizza choices resolve to real options: halves, no cheese, light sauce, well done, thin crust", async () => {
  const { secret } = await newSession();
  type Detected = { toppings: Array<{ toppingId: string; placement: string }>; cheese: string | null; extraCheese: boolean; options: Array<{ value: string }> };
  const detected = async (query: string, fulfilment: "pickup" | "delivery") => {
    const result = await ok(secret, "search_menu", { query, fulfilment });
    assert.equal(result.data!.status, "match", `${query}: ${JSON.stringify(result.data)}`);
    return (result.data!.candidates as Array<{ productId: string; detected: Detected }>)[0];
  };
  const half = await detected("large pizza half pepperoni half mushrooms light sauce no cheese", "delivery");
  assert.equal(half.productId, "large-pizza");
  assert.deepEqual(half.detected.toppings.map((topping) => [topping.toppingId, topping.placement]), [["pepperoni", "left"], ["mushrooms", "right"]]);
  assert.equal(half.detected.cheese, "none");
  assert.deepEqual(half.detected.options.map((option) => option.value), ["Easy on the Sauce"]);
  const bacon = await detected("large pizza with real bacon only on the left half", "delivery");
  assert.deepEqual(bacon.detected.toppings.map((topping) => [topping.toppingId, topping.placement]), [["real-bacon", "left"]]);
  // "Bacon" alone is two toppings on this menu, so the caller is asked rather than guessed for.
  const which = await ok(secret, "search_menu", { query: "large pizza with bacon on the left half", fulfilment: "delivery" });
  assert.deepEqual((which.data!.ambiguousToppings as Array<{ options: string[] }>)[0].options, ["Real Bacon", "Bacon Bits"]);
  const hawaiian = await detected("large hawaiian well done thin crust easy on the cheese", "pickup");
  assert.equal(hawaiian.productId, "specialty-hawaiian");
  assert.equal(hawaiian.detected.cheese, "light");
  assert.deepEqual(hawaiian.detected.options.map((option) => option.value).sort(), ["Thin Crust", "Well Done"]);
  const feta = await detected("large pizza with feta cheese and double cheese", "delivery");
  assert.deepEqual(feta.detected.toppings.map((topping) => topping.toppingId), ["feta-cheese"], "feta cheese is a topping, not the cheese step");
  assert.equal(feta.detected.cheese, "extra");
  assert.equal(feta.detected.extraCheese, true);
});

// --- F. promo codes ---------------------------------------------------------------------------

frozen("a promo code is checked and priced by the website's coupon rules, never by the agent", async () => {
  const { secret } = await newSession();
  await ok(secret, "start_order", { fulfilment: "pickup" });
  assert.deepEqual(issueCodes(await call(secret, "apply_coupon", { code: "THANKS62" })), ["CART_EMPTY"], "the website's promo box is in a checkout with a cart");
  await ok(secret, "add_item", { productId: "pickup-large-one", toppings: [{ toppingId: "pepperoni" }] });
  await ok(secret, "add_item", { productId: "poutine" });

  const invalid = await call(secret, "apply_coupon", { code: "NOPE62" });
  assert.deepEqual(issueCodes(invalid), ["PROMO_CODE_INVALID"]);
  assert.equal(invalid.say, "That promo code isn't valid right now.");
  assert.equal((await ok(secret, "get_cart")).data!.coupon, null, "an invalid code is never stored");
  assert.deepEqual(issueCodes(await call(secret, "apply_coupon", { code: "THANKS 62!" })), ["PROMO_CODE_INVALID"]);

  // A live code that this cart does not qualify for: kept, priced at full price, and explained.
  const missed = await ok(secret, "apply_coupon", { code: "thanks62" });
  assert.equal(missed.data!.coupon!.status, "not_applied");
  assert.match(missed.say!, /^THANKS62 can only be used on Garlic Bread, Garlic Bread with Cheese/);
  const added = await ok(secret, "add_item", { productId: "garlic-bread" });
  assert.equal(added.data!.coupon!.status, "applied", "it starts to apply once the cart qualifies");
  assert.ok(added.data!.totals.discountCents > 0);
  await ok(secret, "set_customer", CALLER);
  const review = await ok(secret, "review_order");
  assert.match(review.data!.readback, /discount \$3\.99 \(Feedback thank-you\)/);
  const removed = await ok(secret, "remove_coupon");
  assert.equal(removed.data!.coupon, null);
  assert.equal(removed.data!.totals.discountCents, 0);
  assert.ok(removed.cartVersion > review.data!.cartVersion);

  const forged = await call(secret, "apply_coupon", { code: "THANKS62", discountCents: 2000 });
  assert.deepEqual(forged.issues?.map((issue) => [issue.code, issue.field]), [["FIELD_NOT_ACCEPTED", "discountCents"]]);
  const named = await call(secret, "add_item", { productId: "poutine", couponCode: "THANKS62" });
  assert.deepEqual(named.issues?.map((issue) => issue.code), ["FIELD_NOT_ACCEPTED"]);
});

frozen("an expired or not-yet-started code is refused; a code withdrawn mid-call stops the review", async () => {
  const now = Date.now();
  await withPromotion({ code: "OLD62", type: "fixed", amount: 500, startsAt: now - 10 * 86_400_000, endsAt: now - 86_400_000 }, async () => {
    await withPromotion({ code: "SOON62", type: "fixed", amount: 500, startsAt: now + 86_400_000 }, async () => {
      await withPromotion({ code: "LIVE62", type: "fixed", amount: 500 }, async () => {
        const { secret } = await newSession();
        await ok(secret, "start_order", { fulfilment: "pickup" });
        await ok(secret, "add_item", { productId: "poutine" });
        await ok(secret, "set_customer", CALLER);
        assert.deepEqual(issueCodes(await call(secret, "apply_coupon", { code: "OLD62" })), ["PROMO_CODE_INVALID"]);
        assert.deepEqual(issueCodes(await call(secret, "apply_coupon", { code: "SOON62" })), ["PROMO_CODE_INVALID"]);
        assert.equal((await ok(secret, "apply_coupon", { code: "LIVE62" })).data!.coupon!.status, "applied");
        await getPool().query("UPDATE promotions SET active = 0 WHERE code = 'LIVE62'");
        const review = await call(secret, "review_order");
        assert.ok(issueCodes(review).includes("PROMO_CODE_INVALID"), "createOrder would refuse it, so the review does");
      });
    });
  });
});

frozen("three bad codes in a row hand the caller to staff", async () => {
  const { secret } = await newSession();
  await ok(secret, "start_order", { fulfilment: "pickup" });
  await ok(secret, "add_item", { productId: "poutine" });
  const answers = [];
  for (const code of ["AAAA62", "BBBB62", "CCCC62"]) answers.push(await call(secret, "apply_coupon", { code }));
  assert.deepEqual(answers.map((answer) => answer.escalate), [false, false, true]);
});

// --- G. gift cards ----------------------------------------------------------------------------

frozen("gift cards are never taken by voice: no tool has a field for one, and the AI policy refuses them", async () => {
  const { secret } = await newSession();
  await ok(secret, "start_order", { fulfilment: "pickup" });
  for (const [tool, args] of [
    ["apply_coupon", { code: "P62-AAAA-BBBB-CCCC-DDDD", giftCardCode: "P62-AAAA-BBBB-CCCC-DDDD" }],
    ["add_item", { productId: "poutine", giftCardCode: "P62-AAAA-BBBB-CCCC-DDDD" }],
    ["set_tip", { type: "none", giftCard: "P62-AAAA-BBBB-CCCC-DDDD" }],
  ] as const) {
    const refused = await call(secret, tool, args);
    assert.equal(refused.ok, false);
    assert.ok(refused.issues!.some((issue) => issue.code === "FIELD_NOT_ACCEPTED"), `${tool}: ${JSON.stringify(refused.issues)}`);
  }
  // A gift card said as a "promo code" is not a promo code: the coupon rules refuse it.
  await ok(secret, "add_item", { productId: "poutine" });
  assert.deepEqual(issueCodes(await call(secret, "apply_coupon", { code: "P62-AAAA-BBBB-CCCC-DDDD" })), ["PROMO_CODE_INVALID"]);
  const info = await ok(secret, "get_business_info");
  assert.equal((info.data!.ordering as { giftCardsByPhone: boolean }).giftCardsByPhone, false);
});

// --- H. tips ----------------------------------------------------------------------------------

frozen("tips: none, the website's presets, a dollar amount, and the website's ceiling", async () => {
  const { secret } = await newSession();
  await ok(secret, "start_order", { fulfilment: "pickup" });
  assert.deepEqual(issueCodes(await call(secret, "set_tip", { type: "percentage", percent: 15 })), ["CART_EMPTY"]);
  await ok(secret, "add_item", { productId: "24-wings", modifiers: [{ id: "wing-style", values: ["Breaded"] }, { id: "wing-flavours", values: ["Mild"] }] });
  const base = (await ok(secret, "get_cart")).data!.totals;
  const fifteen = await ok(secret, "set_tip", { type: "percentage", percent: 15 });
  assert.equal(fifteen.data!.totals.tipCents, Math.round(base.subtotalCents * 0.15), "the server works out the percentage");
  assert.match(fifteen.say!, /^Added a \$\d+\.\d\d tip\. Your total is now \$\d+\.\d\d\.$/);
  const twelve = await call(secret, "set_tip", { type: "percentage", percent: 12 });
  assert.deepEqual(issueCodes(twelve), ["TIP_NOT_OFFERED"]);
  assert.equal(twelve.say, "I can add a tip of 10, 15, 18 percent, or a dollar amount.");
  const five = await ok(secret, "set_tip", { type: "custom", amount: "$5" });
  assert.equal(five.data!.totals.tipCents, 500);
  assert.equal((await ok(secret, "set_tip", { type: "custom", amount: 5.5 })).data!.totals.tipCents, 550);
  assert.deepEqual(issueCodes(await call(secret, "set_tip", { type: "custom", amount: "five" })), ["INVALID_INPUT"]);
  assert.deepEqual(issueCodes(await call(secret, "set_tip", { type: "custom", amount: "500" })), ["TIP_INVALID"], "above the website's custom-tip ceiling");
  const none = await ok(secret, "set_tip", { type: "none" });
  assert.equal(none.data!.totals.tipCents, 0);
  for (const field of ["tip", "tipCents", "amountCents"]) {
    const forged = await call(secret, "set_tip", { type: "custom", amount: "5", [field]: 100 });
    assert.deepEqual(forged.issues?.map((issue) => [issue.code, issue.field]), [["FIELD_NOT_ACCEPTED", field]]);
  }
});

frozen("no tips are taken when the restaurant switches tipping off", async () => {
  const original = (await getPool().query<{ value_json: string }>("SELECT value_json FROM settings WHERE key='taxAndTips'")).rows[0].value_json;
  await getPool().query("UPDATE settings SET value_json=$1 WHERE key='taxAndTips'", [JSON.stringify({ ...JSON.parse(original), tippingEnabled: false })]);
  try {
    const { secret } = await newSession();
    await ok(secret, "start_order", { fulfilment: "pickup" });
    await ok(secret, "add_item", { productId: "poutine" });
    assert.deepEqual(issueCodes(await call(secret, "set_tip", { type: "percentage", percent: 15 })), ["TIPS_UNAVAILABLE"]);
  } finally {
    await getPool().query("UPDATE settings SET value_json=$1 WHERE key='taxAndTips'", [original]);
  }
});

// --- I. payment and data handling ------------------------------------------------------------

frozen("a card number said as a code or an amount never reaches a log", async () => {
  const { id, secret } = await newSession();
  await ok(secret, "start_order", { fulfilment: "pickup" });
  await ok(secret, "add_item", { productId: "poutine" });
  assert.equal((await call(secret, "apply_coupon", { code: "4111 1111 1111 1111" })).ok, false);
  assert.equal((await call(secret, "set_tip", { type: "custom", amount: "4111111111111111" })).ok, false);
  const logged = (await getPool().query<{ request_json: string; response_json: string }>("SELECT request_json, response_json FROM voice_call_events WHERE voice_call_id = $1", [id])).rows;
  for (const row of logged) {
    assert.doesNotMatch(`${row.request_json}${row.response_json}`, /4111[ -]?1111/);
  }
});

frozen("a delivery's instructions reach the order and the read-back; payment stays with the driver", async () => {
  process.env.VOICE_PILOT_FULFILMENTS = "pickup,delivery";
  const { secret } = await newSession();
  await ok(secret, "start_order", { fulfilment: "delivery" });
  await ok(secret, "add_item", { productId: "24-wings", modifiers: [{ id: "wing-style", values: ["Breaded"] }, { id: "wing-flavours", values: ["Mild"] }] });
  await ok(secret, "check_delivery_address", { line1: "55 Parkdale Ave N", unit: "2", postalCode: "L8H 5W7", instructions: "Call when you arrive, don't ring the bell" });
  await ok(secret, "set_customer", CALLER);
  const review = await ok(secret, "review_order");
  assert.match(review.data!.readback, /Delivery instructions: Call when you arrive, don't ring the bell\./);
  await ok(secret, "confirm_order", { cartVersion: review.data!.cartVersion });
  const placed = await ok(secret, "place_order", { cartVersion: review.data!.cartVersion });
  const order = (await getPool().query("SELECT instructions, payment_method FROM orders WHERE order_number = $1", [placed.data!.orderNumber])).rows[0];
  assert.equal(order.instructions, "Call when you arrive, don't ring the bell");
  assert.equal(order.payment_method, "pay_at_store");
});

// --- J. confirmation -------------------------------------------------------------------------

frozen("a changed time, code or tip after the yes needs a new read-back and a new yes", async () => {
  const { secret } = await newSession();
  await ok(secret, "start_order", { fulfilment: "pickup" });
  await ok(secret, "add_item", { productId: "pickup-large-one", toppings: [{ toppingId: "pepperoni" }] });
  await ok(secret, "add_item", { productId: "garlic-bread" });
  await ok(secret, "set_customer", CALLER);
  for (const [tool, args] of [
    ["set_schedule", { when: "scheduled", day: "tomorrow", time: "12:00" }],
    ["apply_coupon", { code: "THANKS62" }],
    ["set_tip", { type: "percentage", percent: 10 }],
    ["remove_coupon", {}],
  ] as const) {
    const review = await ok(secret, "review_order");
    await ok(secret, "confirm_order", { cartVersion: review.data!.cartVersion, utterance: "yes" });
    await ok(secret, tool, args);
    const place = await call(secret, "place_order", { cartVersion: review.data!.cartVersion });
    assert.equal(place.ok, false, `${tool} after the yes`);
    assert.ok(["NOT_REVIEWED", "CART_CHANGED"].includes(issueCodes(place)[0]), `${tool}: ${issueCodes(place)}`);
    assert.deepEqual(issueCodes(await call(secret, "confirm_order", { cartVersion: review.data!.cartVersion })), ["NOT_REVIEWED"]);
  }
});

frozen("starting over drops the code and tip it was priced with; resetting keeps the chosen time", async () => {
  const { id, secret } = await newSession();
  await ok(secret, "start_order", { fulfilment: "pickup" });
  await ok(secret, "add_item", { productId: "garlic-bread" });
  await ok(secret, "add_item", { productId: "poutine" });
  await ok(secret, "set_schedule", { when: "scheduled", day: "tomorrow", time: "12:00" });
  await ok(secret, "apply_coupon", { code: "THANKS62" });
  await ok(secret, "set_tip", { type: "custom", amount: "2" });
  await ok(secret, "reset_order");
  const reset = (await loadVoiceSession(id))!.orderOptions;
  assert.deepEqual(reset, { schedule: { type: "scheduled", scheduledFor: toronto("2026-10-15T12:00:00-04:00") }, couponCode: null, tip: { type: "none" } });
  await ok(secret, "start_order", { fulfilment: "pickup" });
  assert.deepEqual((await loadVoiceSession(id))!.orderOptions.schedule, { type: "asap" });
});

// --- K. security -------------------------------------------------------------------------------

frozen("the session header must be the secret itself: an unexpanded dynamic variable opens nothing", async () => {
  process.env.VOICE_AI_MODE = "internal";
  process.env.VOICE_TOOL_SECRET = "voice-tool-secret-for-tests-0123456789abcdef";
  const { secret } = await newSession();
  const post = (session: string) => toolRoute(
    new Request("https://pizza62.test/api/voice/tools/get_business_info", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.VOICE_TOOL_SECRET}`, "x-voice-session": session, "content-type": "application/json" },
      body: "{}",
    }),
    { params: Promise.resolve({ tool: "get_business_info" }) },
  );
  assert.equal((await post("{{secret__voice_session}}")).status, 401);
  assert.equal((await post('{"variable_name":"secret__voice_session"}')).status, 401);
  assert.equal((await post(secret)).status, 200);
});

frozen("expired sessions answer nothing, new tools included", async () => {
  const { sessionSecret } = await createVoiceSession({ provider: "test", mode: "test", now: Date.now() - 31 * 60_000 });
  for (const tool of ["get_business_info", "get_order_slots", "set_schedule", "apply_coupon", "set_tip"]) {
    assert.equal((await runVoiceTool(tool, sessionSecret, {})).status, 401, tool);
  }
});

frozen("new tools refuse unknown fields by name, and every money field as server-controlled", async () => {
  const { secret } = await newSession();
  await ok(secret, "start_order", { fulfilment: "pickup" });
  assert.deepEqual((await call(secret, "get_order_slots", { day: "today", leadMinutes: 0 })).issues?.map((issue) => issue.code), ["UNKNOWN_FIELD"]);
  assert.deepEqual((await call(secret, "set_schedule", { when: "asap", estimatedFor: 1 })).issues?.map((issue) => issue.code), ["FIELD_NOT_ACCEPTED"]);
  assert.deepEqual((await call(secret, "get_business_info", { address: "elsewhere" })).issues?.map((issue) => issue.code), ["UNKNOWN_FIELD"]);
  assert.deepEqual((await call(secret, "apply_coupon", { code: "X", totalCents: 1 })).issues?.map((issue) => issue.code), ["FIELD_NOT_ACCEPTED"]);
});

// --- business information --------------------------------------------------------------------

frozen("the agent answers address, phone, website and hours from the live settings", async () => {
  process.env.PUBLIC_BASE_URL = "https://www.pizza62.ca/";
  const { secret } = await newSession();
  const info = await ok(secret, "get_business_info");
  assert.equal(info.say, "Pizza 62 is at 55 Parkdale Avenue North, Hamilton, Ontario L8H 5W7. Our phone number is 905-547-5777 and our website is pizza62.ca. Today we're open from 11:00 AM to 10:00 PM.");
  const days = info.data!.upcomingDays as Array<{ label: string; weekday: string; opensAt: string; closesAt: string; lastOrdersAt: string }>;
  assert.deepEqual(days.slice(0, 3).map((day) => [day.label, day.opensAt, day.closesAt, day.lastOrdersAt]), [
    ["today", "11:00 AM", "10:00 PM", "9:40 PM"],
    ["tomorrow", "11:00 AM", "11:00 PM", "10:40 PM"],
    ["Friday, October 16", "11:00 AM", "midnight", "11:40 PM"],
  ]);
  assert.equal(days.find((day) => day.weekday === "Sunday")!.opensAt, "noon");
  // Changing the settings changes the answer: nothing is kept in a prompt.
  const original = (await getPool().query<{ value_json: string }>("SELECT value_json FROM settings WHERE key='business'")).rows[0].value_json;
  await getPool().query("UPDATE settings SET value_json=$1 WHERE key='business'", [JSON.stringify({ ...JSON.parse(original), phone: "(905) 555-0100" })]);
  try {
    assert.match((await ok(secret, "get_business_info")).say!, /Our phone number is 905-555-0100/);
  } finally {
    await getPool().query("UPDATE settings SET value_json=$1 WHERE key='business'", [original]);
  }
  // An internal hostname is never read out as the website.
  process.env.PUBLIC_BASE_URL = "https://app-pizza62-prod-638134.azurewebsites.net";
  assert.equal((await ok(secret, "get_business_info")).data!.website, null);
});

test("a closure that covers a whole day closes it in the hours a caller is told", () => {
  const now = WEDNESDAY_6PM;
  const closure = { id: "c", startsAt: toronto("2026-10-15T00:00:00-04:00"), endsAt: toronto("2026-10-16T00:00:00-04:00"), scope: "both" as const, reason: "Holiday", customerMessage: "Closed for the holiday." };
  const days = upcomingDays({ now, hours: [...REGULAR_HOURS], closures: [closure], lastOrderCutoffMinutes: 20, closureMessage: (entry) => entry.customerMessage ?? "" });
  assert.deepEqual([days[1].label, days[1].closed, days[1].closureMessage], ["tomorrow", true, "Closed for the holiday."]);
  assert.equal(days[0].closed, false);
});
