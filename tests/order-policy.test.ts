/**
 * Explicit order-context policies (Phase 1C).
 *
 * `createOrder` used to take a single `staffEntry` boolean that switched five
 * unrelated privileges at once. It now takes a named policy (lib/order-policy.ts)
 * whose fields are independent. Three properties are pinned here:
 *
 * 1. **Parity.** The website, the till's phone orders and the till's walk-ins
 *    behave exactly as they did before the split. The scenario matrix in
 *    tests/helpers/order-policy-scenarios.ts was run against the old code and
 *    its outcomes frozen in tests/fixtures/order-policy-parity.json; the same
 *    matrix must now produce the same outcomes, refusal messages included.
 * 2. **Independence.** Flipping one policy field changes that behaviour and
 *    nothing else.
 * 3. **Least privilege.** The public route cannot reach a policy, and a missing
 *    or malformed one falls back to the website's.
 *
 * The clock is frozen on a past Wednesday, as in the cutoff tests.
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, afterEach, mock } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { ORDER_CHANNELS } = await import("@/db/schema");
const { createOrder, quoteOrder } = await import("@/lib/order-service");
const {
  POLICY_CHANNELS,
  STAFF_PHONE_ORDER_POLICY,
  STAFF_WALK_IN_ORDER_POLICY,
  WEBSITE_ORDER_POLICY,
  resolveOrderPolicy,
  staffOrderContext,
  websiteOrderContext,
} = await import("@/lib/order-policy");
const { runParityScenarios } = await import("@/tests/helpers/order-policy-scenarios");
const { POST: publicOrderRoute } = await import("@/app/api/orders/route");

type OrderPolicy = typeof WEBSITE_ORDER_POLICY;

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});
afterEach(() => {
  mock.timers.reset();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const RUN = crypto.randomUUID().slice(0, 8);
let counter = 0;
const nextKey = () => `policy-${RUN}-${(counter += 1)}-${crypto.randomUUID()}`;
const nextClientIp = () => `203.0.113.${(counter += 1) % 250}-${RUN}`;

const wednesdayAt = (minuteOfDay: number) => Date.parse("2026-10-14T00:00:00-04:00") + minuteOfDay * 60_000;
const OPEN = wednesdayAt(18 * 60);
const SLOT = wednesdayAt(19 * 60);

async function at<T>(instant: number, body: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["Date"], now: instant });
  try {
    return await body();
  } finally {
    mock.timers.reset();
  }
}

const FULL = { name: "Ada Lovelace", phone: "905-555-0142", email: "ada@example.test" };
const ADDRESS = { line1: "55 Parkdale Ave N", city: "Hamilton", province: "ON", postalCode: "L8H 5W7" };
const pickup = (extra: Record<string, unknown> = {}) => ({
  fulfilment: "pickup" as const,
  items: [{ productId: "poutine", quantity: 2 }],
  paymentMethod: "pay_at_store" as const,
  tip: { type: "none" as const },
  schedule: { type: "scheduled" as const, scheduledFor: SLOT },
  customer: FULL,
  idempotencyKey: nextKey(),
  ...extra,
});

/** The website's policy with exactly one field changed. */
const websiteWith = (patch: Partial<OrderPolicy>): OrderPolicy => Object.freeze({ ...WEBSITE_ORDER_POLICY, ...patch });

async function outcome(promise: Promise<{ orderId?: unknown }>) {
  try {
    const result = await promise;
    const row = (
      await getPool().query<Record<string, unknown>>(
        "SELECT channel, acknowledged_at, attribution_json, customer_email FROM orders WHERE id = $1",
        [result.orderId],
      )
    ).rows[0];
    const kinds = (
      await getPool().query<{ kind: string }>(
        "SELECT kind FROM notification_outbox WHERE payload_json::jsonb->>'orderId' = $1 ORDER BY kind",
        [result.orderId],
      )
    ).rows.map((entry) => entry.kind);
    return { accepted: true as const, channel: row.channel, acknowledged: row.acknowledged_at !== null, attribution: row.attribution_json !== null, kinds };
  } catch (error) {
    return { accepted: false as const, code: (error as { code?: string }).code, message: (error as Error).message };
  }
}

// --- 1. parity with the pre-refactor engine ---------------------------------

withDb("the website, staff phone and walk-in behave exactly as before the split", async () => {
  const expected = JSON.parse(await readFile(new URL("./fixtures/order-policy-parity.json", import.meta.url), "utf8"));
  const actual = await runParityScenarios(getPool() as never, {
    create: (kind, body) =>
      kind === "website"
        ? createOrder(body as never)
        : createOrder(body as never, staffOrderContext(kind === "staff_phone" ? "phone" : "walk_in", "parity-staff-user")),
    quote: (kind, body) =>
      (kind === "website"
        ? quoteOrder(body as never)
        : quoteOrder(body as never, staffOrderContext(kind === "staff_phone" ? "phone" : "walk_in"))) as never,
  });
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), "the same scenarios ran");
  for (const name of Object.keys(expected)) {
    assert.deepEqual(actual[name], expected[name], name);
  }
});

withDb("an explicit website context is the same as passing none", async () => {
  await at(OPEN, async () => {
    const implicit = await outcome(createOrder(pickup({ customer: { name: "Blue cap" } })));
    const explicit = await outcome(createOrder(pickup({ customer: { name: "Blue cap" } }), websiteOrderContext()));
    assert.deepEqual(explicit, implicit);
    assert.equal(implicit.accepted, false);
  });
});

// --- 2. the presets ----------------------------------------------------------

test("each preset states every privilege, and none can be edited at runtime", () => {
  assert.deepEqual({ ...WEBSITE_ORDER_POLICY }, {
    channel: "online",
    actorType: "customer",
    contactPolicy: "full",
    allowStaffOnlyItems: false,
    paymentMethods: ["pay_at_store", "online"],
    payAtStorePickup: "setting",
    allowPayOnDelivery: false,
    payAtStoreLimitCents: 10000,
    bypassLastOrderCutoff: false,
    recordAttribution: true,
    alertRestaurant: true,
    allowCodes: true,
  });
  const staff = {
    actorType: "staff",
    contactPolicy: "name_only",
    allowStaffOnlyItems: true,
    paymentMethods: ["pay_at_store", "online"],
    payAtStorePickup: "always",
    allowPayOnDelivery: true,
    payAtStoreLimitCents: null,
    bypassLastOrderCutoff: true,
    recordAttribution: false,
    allowCodes: true,
  };
  assert.deepEqual({ ...STAFF_PHONE_ORDER_POLICY }, { ...staff, channel: "phone", alertRestaurant: true });
  assert.deepEqual({ ...STAFF_WALK_IN_ORDER_POLICY }, { ...staff, channel: "walk_in", alertRestaurant: false });
  for (const policy of [WEBSITE_ORDER_POLICY, STAFF_PHONE_ORDER_POLICY, STAFF_WALK_IN_ORDER_POLICY]) {
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.paymentMethods));
    assert.throws(() => {
      (policy as { allowStaffOnlyItems: boolean }).allowStaffOnlyItems = true;
    });
  }
  assert.deepEqual(staffOrderContext("phone", "user-1"), { policy: STAFF_PHONE_ORDER_POLICY, staffUserId: "user-1" });
  assert.deepEqual(staffOrderContext("walk_in"), { policy: STAFF_WALK_IN_ORDER_POLICY });
});

test("the policy's channel list is the database's", () => {
  assert.deepEqual([...POLICY_CHANNELS].sort(), [...ORDER_CHANNELS].sort());
});

// --- 3. independence: one field, one behaviour --------------------------------

withDb("allowing counter-only items does not relax the contact rules", async () => {
  await at(OPEN, async () => {
    const policy = websiteWith({ allowStaffOnlyItems: true });
    const item = [{ productId: "chicken-burger", quantity: 1 }];
    assert.equal((await outcome(createOrder(pickup({ items: item }), { policy }))).accepted, true);
    const nameOnly = await outcome(createOrder(pickup({ items: item, customer: { name: "Blue cap" } }), { policy }));
    assert.equal(nameOnly.accepted, false);
    assert.equal(nameOnly.message, "Enter a valid phone number.");
    // And the website itself still refuses the item.
    const website = await outcome(createOrder(pickup({ items: item })));
    assert.equal(website.message, "This item is only available at the counter.");
  });
});

withDb("relaxing the contact rules does not unlock counter-only items or pay at the door", async () => {
  await at(OPEN, async () => {
    const policy = websiteWith({ contactPolicy: "name_only" });
    const nameOnly = await outcome(createOrder(pickup({ customer: { name: "Blue cap" } }), { policy }));
    assert.equal(nameOnly.accepted, true);
    const counterItem = await outcome(createOrder(pickup({ items: [{ productId: "chicken-burger", quantity: 1 }] }), { policy }));
    assert.equal(counterItem.message, "This item is only available at the counter.");
    const delivery = await outcome(
      createOrder(pickup({ fulfilment: "delivery", items: [{ productId: "poutine", quantity: 3 }], address: ADDRESS }), { policy }),
    );
    assert.equal(delivery.message, "Pay at store is available for pickup orders only.");
  });
});

withDb("pay at the door can be allowed on its own, and the delivery rules still apply", async () => {
  await at(OPEN, async () => {
    const policy = websiteWith({ allowPayOnDelivery: true });
    const delivery = (extra: Record<string, unknown> = {}) =>
      pickup({ fulfilment: "delivery", items: [{ productId: "poutine", quantity: 3 }], address: ADDRESS, ...extra });
    assert.equal((await outcome(createOrder(delivery(), { policy }))).accepted, true);
    const small = await outcome(createOrder(delivery({ items: [{ productId: "poutine", quantity: 1 }] }), { policy }));
    assert.equal(small.code, "DELIVERY_ADDRESS_INELIGIBLE");
    const nameOnly = await outcome(createOrder(delivery({ customer: { name: "Blue cap" } }), { policy }));
    assert.equal(nameOnly.message, "Enter a valid phone number.");
    // Pay-at-store on a pickup still follows the website setting.
    const original = (await getPool().query<{ value_json: string }>("SELECT value_json FROM settings WHERE key='ordering'")).rows[0].value_json;
    await getPool().query("UPDATE settings SET value_json=$1 WHERE key='ordering'", [JSON.stringify({ ...JSON.parse(original), payAtStorePickupEnabled: false })]);
    try {
      const pickupOff = await outcome(createOrder(pickup(), { policy }));
      assert.equal(pickupOff.message, "Pay at store is available for pickup orders only.");
      const counter = await outcome(createOrder(pickup(), { policy: websiteWith({ payAtStorePickup: "always" }) }));
      assert.equal(counter.accepted, true, "payAtStorePickup is a separate field");
    } finally {
      await getPool().query("UPDATE settings SET value_json=$1 WHERE key='ordering'", [original]);
    }
  });
});

withDb("the payment-method list can withhold online payment without touching pay at store", async () => {
  await at(OPEN, async () => {
    const policy = websiteWith({ paymentMethods: ["pay_at_store"] });
    const online = await outcome(createOrder(pickup({ paymentMethod: "online" }), { policy }));
    assert.equal(online.message, "That payment method is not available for this order.");
    assert.equal((await outcome(createOrder(pickup(), { policy }))).accepted, true);
    const quote = await quoteOrder(pickup({ paymentMethod: "online" }), { policy });
    assert.deepEqual(quote.issues.map((issue) => issue.code), ["PAYMENT_METHOD_UNAVAILABLE"]);
  });
});

withDb("website orders over $100 must be paid online; the till has no limit", async () => {
  await at(OPEN, async () => {
    // Twelve poutines at $8.99 come to $121.90 with HST; eight come to $81.27,
    // which the old $40 limit refused and the $100 one allows.
    const large = (extra: Record<string, unknown> = {}) => pickup({ items: [{ productId: "poutine", quantity: 12 }], ...extra });
    const refused = await outcome(createOrder(large()));
    assert.equal(refused.accepted, false);
    assert.equal(refused.code, "PAY_ONLINE_REQUIRED");
    assert.equal(refused.message, "Orders over $100.00 must be paid online. Please choose Pay online by card.");
    const quote = await quoteOrder(large());
    assert.equal(quote.ok, false);
    assert.deepEqual(quote.issues.map((issue) => issue.message), [refused.message]);
    // Choosing online clears it, and an order under the limit can still pay at the store.
    const online = await quoteOrder(large({ paymentMethod: "online" }));
    assert.ok(!online.issues.some((issue) => issue.code === "PAYMENT_METHOD_UNAVAILABLE"));
    assert.equal((await outcome(createOrder(pickup({ items: [{ productId: "poutine", quantity: 8 }] })))).accepted, true);
    // The till takes the same order at the counter.
    assert.equal((await outcome(createOrder(large(), staffOrderContext("phone", "limit-staff-user")))).accepted, true);
    assert.equal((await outcome(createOrder(large(), { policy: websiteWith({ payAtStoreLimitCents: null }) }))).accepted, true);
  });
});

withDb("the cutoff exemption is its own privilege", async () => {
  await at(wednesdayAt(22 * 60 - 10), async () => {
    const policy = websiteWith({ bypassLastOrderCutoff: true });
    assert.equal((await outcome(createOrder(pickup({ schedule: { type: "asap" } }), { policy }))).accepted, true);
    const website = await outcome(createOrder(pickup({ schedule: { type: "asap" } })));
    assert.equal(website.code, "LAST_ORDERS_CLOSED");
    const nameOnly = await outcome(createOrder(pickup({ schedule: { type: "asap" }, customer: { name: "Blue cap" } }), { policy }));
    assert.equal(nameOnly.message, "Enter a valid phone number.");
  });
});

withDb("channel, alert and attribution are independent of every privilege", async () => {
  await at(OPEN, async () => {
    const attribution = { last: { utm_source: "google", utm_campaign: "policy", captured_at: 1 } };
    const phoneChannel = await outcome(createOrder(pickup({ attribution }), { policy: websiteWith({ channel: "phone" }) }));
    assert.equal(phoneChannel.channel, "phone");
    assert.equal(phoneChannel.attribution, true, "naming a channel does not drop attribution");
    const phoneNameOnly = await outcome(createOrder(pickup({ customer: { name: "Blue cap" } }), { policy: websiteWith({ channel: "phone" }) }));
    assert.equal(phoneNameOnly.accepted, false, "naming a channel does not relax contact rules");

    const quiet = await outcome(createOrder(pickup(), { policy: websiteWith({ alertRestaurant: false }) }));
    assert.equal(quiet.channel, "online");
    assert.equal(quiet.acknowledged, true);
    assert.ok(!quiet.kinds.includes("restaurant_new_order"));
    assert.ok(quiet.kinds.includes("customer_order_confirmation"));

    const unattributed = await outcome(createOrder(pickup({ attribution }), { policy: websiteWith({ recordAttribution: false }) }));
    assert.equal(unattributed.attribution, false);
    assert.ok(unattributed.kinds.includes("restaurant_new_order"));
  });
});

withDb("codes can be withheld without changing anything else", async () => {
  await at(OPEN, async () => {
    const policy = websiteWith({ allowCodes: false });
    const coupon = await outcome(createOrder(pickup({ couponCode: "THANKS62" }), { policy }));
    assert.equal(coupon.code, "CODES_NOT_ACCEPTED");
    const giftCard = await outcome(createOrder(pickup({ giftCardCode: "P62-AAAA-BBBB-CCCC" }), { policy }));
    assert.equal(giftCard.code, "CODES_NOT_ACCEPTED");
    assert.equal((await outcome(createOrder(pickup({ couponCode: "  " }), { policy }))).accepted, true, "an empty code is no code");
    const quote = await quoteOrder(pickup({ couponCode: "THANKS62" }), { policy });
    assert.ok(quote.issues.some((issue) => issue.code === "CODES_NOT_ACCEPTED"));
    assert.equal(quote.ok, false);
    const website = await quoteOrder(pickup({ couponCode: "THANKS62" }));
    assert.ok(!website.issues.some((issue) => issue.code === "CODES_NOT_ACCEPTED"));
  });
});

// --- 4. least privilege -----------------------------------------------------

test("a missing or malformed policy resolves to the website's", () => {
  assert.equal(resolveOrderPolicy(undefined), WEBSITE_ORDER_POLICY);
  assert.equal(resolveOrderPolicy({}), WEBSITE_ORDER_POLICY);
  // The pre-refactor shape names no policy at all.
  assert.equal(resolveOrderPolicy({ staffEntry: true, channel: "phone" } as never), WEBSITE_ORDER_POLICY);
  // A partial policy is not merged with anything; it is refused whole.
  assert.equal(resolveOrderPolicy({ policy: { allowStaffOnlyItems: true } as never }), WEBSITE_ORDER_POLICY);
  assert.equal(resolveOrderPolicy({ policy: { ...STAFF_PHONE_ORDER_POLICY, channel: "ai_receptionist" } as never }), WEBSITE_ORDER_POLICY);
  assert.equal(resolveOrderPolicy({ policy: { ...STAFF_PHONE_ORDER_POLICY, paymentMethods: ["cash"] } as never }), WEBSITE_ORDER_POLICY);
  assert.equal(resolveOrderPolicy({ policy: { ...STAFF_PHONE_ORDER_POLICY, payAtStoreLimitCents: undefined } as never }), WEBSITE_ORDER_POLICY);
  assert.equal(resolveOrderPolicy({ policy: { ...STAFF_PHONE_ORDER_POLICY, payAtStoreLimitCents: "40" } as never }), WEBSITE_ORDER_POLICY);
  assert.equal(resolveOrderPolicy(staffOrderContext("phone")), STAFF_PHONE_ORDER_POLICY);
});

withDb("the public route cannot request a privilege through the request body", async () => {
  await at(OPEN, async () => {
    const forged = {
      channel: "walk_in",
      staffEntry: true,
      staffUserId: "intruder",
      policy: { ...STAFF_WALK_IN_ORDER_POLICY },
      context: { policy: { ...STAFF_WALK_IN_ORDER_POLICY } },
    };
    const post = (body: unknown) =>
      publicOrderRoute(
        new Request("https://order.pizza62.test/api/orders", {
          method: "POST",
          headers: { "content-type": "application/json", "x-azure-clientip": nextClientIp() },
          body: JSON.stringify(body),
        }),
      );
    const nameOnly = await post({ ...pickup({ customer: { name: "Blue cap" } }), ...forged });
    assert.equal(nameOnly.status, 400);
    assert.equal(((await nameOnly.json()) as { error: string }).error, "Enter a valid phone number.");

    const counterItem = await post({ ...pickup({ items: [{ productId: "chicken-burger", quantity: 1 }] }), ...forged });
    assert.equal(counterItem.status, 400);
    assert.equal(((await counterItem.json()) as { error: string }).error, "This item is only available at the counter.");

    const accepted = await post({ ...pickup(), ...forged });
    assert.equal(accepted.status, 201);
    const { orderId } = (await accepted.json()) as { orderId: string };
    const row = (await getPool().query<{ channel: string; acknowledged_at: number | null }>("SELECT channel, acknowledged_at FROM orders WHERE id=$1", [orderId])).rows[0];
    assert.equal(row.channel, "online");
    assert.equal(row.acknowledged_at, null);
  });
});
