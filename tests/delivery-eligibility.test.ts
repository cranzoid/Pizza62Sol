/**
 * The delivery check a caller can run before there is an order.
 *
 * `checkDeliveryEligibility` is the code `createOrder` uses to accept or refuse
 * a delivery, extracted so that something without an order yet (a phone agent
 * asking "do you deliver to …?") gets the same answer. The property defended
 * here is that the two cannot disagree: every case is put through the helper
 * and, where an order can be built for it, through `createOrder` too, and the
 * accept/refuse decision, the message and the fee must match.
 *
 * `createOrder` is called with the till's context because the public route
 * refuses a pay-at-door delivery (and an unconfigured Clover) before it reaches
 * the address. The delivery rules do not depend on who is ordering.
 *
 * Azure Maps is stubbed; without a key the FSA-centroid resolver is what runs.
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { getSetting } = await import("@/db/runtime");
const { nextOrderSlots } = await import("@/lib/domain");
const { resolveFsaCentroid } = await import("@/lib/delivery-area");
const { checkDeliveryEligibility, createOrder, quoteOrder, OrderValidationError } = await import("@/lib/order-service");
const { staffOrderContext } = await import("@/lib/order-policy");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const RUN = crypto.randomUUID().slice(0, 8);
const nextKey = () => `delivery-${RUN}-${crypto.randomUUID()}-${crypto.randomUUID()}`;

// A cloned poutine flagged free-delivery. The seeded free-delivery products are
// deals that need choices made, which would make these tests about modifiers.
// A fixed id, deactivated afterwards rather than deleted: order_items holds a
// RESTRICT key to it once an order uses it.
const FREE_DELIVERY_ID = "test-free-delivery-item";

type Delivery = { feeCents: number; minimumCents: number; radiusKm: number; outsideAreaMessage?: string };
const delivery = reachable ? await getSetting<Delivery>("delivery") : ({} as Delivery);
const business = reachable ? await getSetting<{ latitude: number; longitude: number }>("business") : null;
const hours = reachable
  ? await getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours")
  : [];
// 45 minutes clears the 30-minute delivery lead even if the suite crosses a
// slot boundary partway through.
const SLOT = reachable
  ? nextOrderSlots({ now: Date.now(), hours, timeZone: "America/Toronto", leadMinutes: 45, limit: 1 })[0]
  : 0;

before(async () => {
  if (!reachable) return;
  await getPool().query(
    `INSERT INTO products (id,category_id,name,slug,description,product_type,base_price_cents,taxable,pickup_eligible,delivery_eligible,promotion_eligible,active,sold_out,setup_required,kitchen_label,configuration_json,display_order,created_at,updated_at)
     SELECT $1,category_id,'Free Delivery Test Item',$1,description,product_type,base_price_cents,taxable,pickup_eligible,delivery_eligible,promotion_eligible,1,0,0,kitchen_label,'{"freeDelivery":true}',display_order,created_at,updated_at
     FROM products WHERE id='poutine'
     ON CONFLICT (id) DO UPDATE SET active=1, sold_out=0, configuration_json='{"freeDelivery":true}'`,
    [FREE_DELIVERY_ID],
  );
});

after(async () => {
  if (reachable) await getPool().query("UPDATE products SET active=0 WHERE id=$1", [FREE_DELIVERY_ID]);
  await closePool();
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.AZURE_MAPS_SUBSCRIPTION_KEY;
});

/** Answers Azure Maps requests with `respond`; anything else goes to the network as normal. */
function stubMaps(respond: () => Response) {
  process.env.AZURE_MAPS_SUBSCRIPTION_KEY = "test-key";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes("atlas.microsoft.com") ? respond() : realFetch(input, init)) as typeof fetch;
}
const mapsPoint = (lat: number, lon: number, confidence = "High") =>
  new Response(JSON.stringify({ results: [{ position: { lat, lon }, matchConfidence: { confidence } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const STORE = { line1: "55 Parkdale Ave N", unit: "2", city: "Hamilton", province: "ON", postalCode: "l8h5w7" };
// Dundas: a real Hamilton FSA whose centroid is about 13 km from the store.
const DUNDAS = { line1: "10 King St W", city: "Hamilton", province: "ON", postalCode: "L9H 1A1" };
// A Toronto postal code: no centroid, so it cannot be verified without Maps.
const UNKNOWN = { line1: "301 Front St W", city: "Hamilton", province: "ON", postalCode: "M5V 2T6" };

type Address = Record<string, string>;
type Line = { productId: string; quantity: number };
const poutine = (quantity: number): Line => ({ productId: "poutine", quantity });
const freeItem: Line = { productId: FREE_DELIVERY_ID, quantity: 1 };

/**
 * The same delivery through the helper and through `createOrder`.
 *
 * The helper is given exactly what `createOrder` derives: the menu subtotal as
 * the quote prices it, and which lines carry free delivery.
 */
async function both(address: Address, lines: Line[]) {
  const cart = { fulfilment: "delivery" as const, items: lines, paymentMethod: "pay_at_store" as const, tip: { type: "none" as const } };
  const quote = await quoteOrder({ ...cart, schedule: { type: "scheduled", scheduledFor: SLOT } }, staffOrderContext("phone"));
  const check = await checkDeliveryEligibility({
    address,
    menuSubtotalCents: quote.totals.menuSubtotalCents,
    items: lines.map((line) => ({ freeDelivery: line.productId === FREE_DELIVERY_ID })),
  });

  let order: { orderId: string } | null = null;
  let refusal: InstanceType<typeof OrderValidationError> | null = null;
  try {
    order = await createOrder(
      {
        ...cart,
        schedule: { type: "scheduled", scheduledFor: SLOT },
        address,
        idempotencyKey: nextKey(),
        customer: { name: "Ada Lovelace", phone: "905-555-0142", email: "ada@example.test" },
      },
      staffOrderContext("phone"),
    );
  } catch (error) {
    if (!(error instanceof OrderValidationError)) throw error;
    refusal = error;
  }
  const stored = order
    ? (
        await getPool().query<{ delivery_fee_cents: number; address_json: string }>(
          "SELECT delivery_fee_cents, address_json FROM orders WHERE id = $1",
          [order.orderId],
        )
      ).rows[0]
    : null;
  return { check, refusal, stored };
}

/** The helper and the order agree, whichever way the decision went. */
function assertAgree(result: Awaited<ReturnType<typeof both>>) {
  const { check, refusal, stored } = result;
  assert.equal(
    check.addressDeliverable,
    check.reason === "eligible" || check.reason === "below_minimum",
    `addressDeliverable is wrong for ${check.reason}`,
  );
  if (check.eligible) {
    assert.equal(refusal, null, `createOrder refused what the check accepted: ${refusal?.message}`);
    assert.ok(stored);
    assert.equal(Number(stored.delivery_fee_cents), check.feeCents, "the order charges the fee the check quoted");
    assert.deepEqual(JSON.parse(stored.address_json), check.address, "the order stores the address the check normalized");
  } else {
    assert.ok(refusal, `createOrder accepted what the check refused (${check.reason})`);
    assert.equal(refusal.message, check.message);
    if (check.reason === "invalid_address") {
      assert.equal(refusal.status, 400);
    } else {
      assert.equal(refusal.status, 422);
      assert.equal(refusal.code, "DELIVERY_ADDRESS_INELIGIBLE");
    }
  }
}

// --- the decisions -------------------------------------------------------------

withDb("accepts an in-range address and quotes the configured fee", async () => {
  const result = await both(STORE, [poutine(3)]);
  assert.equal(result.check.eligible, true);
  assert.equal(result.check.reason, "eligible");
  assert.equal(result.check.message, null);
  assert.equal(result.check.feeCents, delivery.feeCents);
  assert.ok(result.check.distanceKm !== null && result.check.distanceKm < delivery.radiusKm);
  assert.deepEqual(result.check.address, {
    line1: "55 Parkdale Ave N",
    unit: "2",
    city: "Hamilton",
    province: "ON",
    postalCode: "L8H 5W7",
  });
  assertAgree(result);
});

withDb("refuses an address outside the radius with the owner's message", async () => {
  const result = await both(DUNDAS, [poutine(3)]);
  assert.equal(result.check.eligible, false);
  assert.equal(result.check.reason, "outside_radius");
  assert.ok(result.check.distanceKm !== null && result.check.distanceKm > delivery.radiusKm);
  assert.equal(result.check.message, delivery.outsideAreaMessage);
  assert.equal(result.check.feeCents, 0);
  assertAgree(result);
});

withDb("refuses an address that cannot be located", async () => {
  const result = await both(UNKNOWN, [poutine(3)]);
  assert.equal(result.check.eligible, false);
  assert.equal(result.check.reason, "address_unverified");
  assert.equal(result.check.distanceKm, null);
  assertAgree(result);
});

withDb("refuses an address that is not a usable delivery address at all", async () => {
  for (const [address, message] of [
    [{ ...STORE, line1: "55" }, /complete delivery street address/],
    [{ ...STORE, postalCode: "12345" }, /valid Canadian postal code/],
    [{ ...STORE, city: "Toronto" }, /limited to Hamilton, Ontario/],
  ] as const) {
    const result = await both(address, [poutine(3)]);
    assert.equal(result.check.eligible, false);
    assert.equal(result.check.reason, "invalid_address");
    assert.equal(result.check.address, null);
    assert.match(String(result.check.message), message);
    assertAgree(result);
  }
});

withDb("refuses a cart under the delivery minimum and says by how much", async () => {
  const result = await both(STORE, [poutine(1)]);
  assert.equal(result.check.eligible, false);
  assert.equal(result.check.reason, "below_minimum");
  assert.equal(result.check.minimumCents, delivery.minimumCents);
  assert.equal(result.check.shortfallCents, delivery.minimumCents - 899);
  assert.match(String(result.check.message), /Delivery orders must be at least \$\d+\.\d{2} before tax\./);
  assertAgree(result);
});

withDb("says outright that an address is deliverable before there is a cart", async () => {
  // The phone agent checks the address first. With nothing in the cart the
  // order is not yet eligible, but whether we deliver *there* is a separate,
  // explicit answer — the agent must not have to read it out of `reason`.
  const inRange = await checkDeliveryEligibility({ address: STORE, menuSubtotalCents: 0 });
  assert.equal(inRange.eligible, false);
  assert.equal(inRange.reason, "below_minimum");
  assert.equal(inRange.addressDeliverable, true);
  assert.equal(inRange.minimumCents, delivery.minimumCents);
  assert.equal(inRange.shortfallCents, delivery.minimumCents);
  assert.ok(inRange.address);

  for (const address of [DUNDAS, UNKNOWN, { ...STORE, city: "Toronto" }]) {
    const check = await checkDeliveryEligibility({ address, menuSubtotalCents: 0 });
    assert.equal(check.addressDeliverable, false, `${check.reason} must not read as deliverable`);
  }
});

withDb("accepts a cart that meets the minimum, exactly at the boundary too", async () => {
  const met = await both(STORE, [poutine(3)]);
  assert.equal(met.check.eligible, true);
  assert.equal(met.check.shortfallCents, 0);
  assertAgree(met);

  // No real cart lands on the minimum to the cent, so the boundary itself is
  // checked on the helper alone: the minimum is inclusive.
  const atMinimum = await checkDeliveryEligibility({ address: STORE, menuSubtotalCents: delivery.minimumCents });
  assert.equal(atMinimum.eligible, true);
  const oneShort = await checkDeliveryEligibility({ address: STORE, menuSubtotalCents: delivery.minimumCents - 1 });
  assert.equal(oneShort.reason, "below_minimum");
  assert.equal(oneShort.shortfallCents, 1);
});

withDb("a free-delivery item zeroes the fee but never widens the area or waives the minimum", async () => {
  const free = await both(STORE, [poutine(2), freeItem]);
  assert.equal(free.check.eligible, true);
  assert.equal(free.check.feeCents, 0);
  assertAgree(free);

  const farAway = await both(DUNDAS, [poutine(2), freeItem]);
  assert.equal(farAway.check.reason, "outside_radius");
  assertAgree(farAway);

  const small = await both(STORE, [freeItem]);
  assert.equal(small.check.reason, "below_minimum");
  assertAgree(small);
});

withDb("reports delivery switched off before looking at the address", async () => {
  const ordering = await getSetting<Record<string, unknown>>("ordering");
  await getPool().query("UPDATE settings SET value_json = $1 WHERE key = 'ordering'", [
    JSON.stringify({ ...ordering, deliveryEnabled: false }),
  ]);
  try {
    const check = await checkDeliveryEligibility({ address: STORE, menuSubtotalCents: 5000 });
    assert.equal(check.eligible, false);
    assert.equal(check.reason, "delivery_unavailable");
    assert.equal(check.addressDeliverable, false, "we deliver nowhere while delivery is off");
    // createOrder refuses this earlier, with its own long-standing 409.
    await assert.rejects(
      () =>
        createOrder(
          {
            fulfilment: "delivery",
            items: [poutine(3)],
            paymentMethod: "pay_at_store",
            schedule: { type: "scheduled", scheduledFor: SLOT },
            address: STORE,
            idempotencyKey: nextKey(),
            customer: { name: "Ada Lovelace", phone: "905-555-0142", email: "ada@example.test" },
          },
          staffOrderContext("phone"),
        ),
      (error: unknown) => error instanceof OrderValidationError && error.status === 409,
    );
  } finally {
    await getPool().query("UPDATE settings SET value_json = $1 WHERE key = 'ordering'", [JSON.stringify(ordering)]);
  }
});

// --- Azure Maps ----------------------------------------------------------------

withDb("uses the Azure Maps coordinate over the postal-code centroid", async () => {
  // The Dundas postal code's centroid is out of range; Maps placing the street
  // beside the store is what decides it.
  stubMaps(() => mapsPoint(business!.latitude + 0.005, business!.longitude));
  const result = await both(DUNDAS, [poutine(3)]);
  assert.equal(result.check.eligible, true);
  assert.ok(result.check.distanceKm !== null && result.check.distanceKm < 1);
  assertAgree(result);
});

withDb("refuses when Azure Maps finds no such address, without falling back", async () => {
  // In range by its postal code alone — so only the refusal to fall back keeps
  // a mistyped street from passing.
  stubMaps(() => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  const result = await both(STORE, [poutine(3)]);
  assert.equal(result.check.reason, "address_unverified");
  assertAgree(result);

  stubMaps(() => mapsPoint(business!.latitude, business!.longitude, "Low"));
  const loose = await checkDeliveryEligibility({ address: STORE, menuSubtotalCents: 5000 });
  assert.equal(loose.reason, "address_unverified", "a low-confidence match is not trusted");
});

withDb("falls back to the postal-code centroid when Azure Maps is down", async () => {
  stubMaps(() => new Response("unavailable", { status: 503 }));
  const result = await both(STORE, [poutine(3)]);
  assert.equal(result.check.eligible, true);
  // The distance is the centroid's, which is how the fallback shows it was used.
  const centroid = resolveFsaCentroid(STORE.postalCode)!;
  const withoutMaps = await (async () => {
    delete process.env.AZURE_MAPS_SUBSCRIPTION_KEY;
    return checkDeliveryEligibility({ address: STORE, menuSubtotalCents: 5000 });
  })();
  assert.ok(centroid);
  assert.equal(result.check.distanceKm, withoutMaps.distanceKm);
  assertAgree(result);

  stubMaps(() => new Response("unavailable", { status: 503 }));
  const farAway = await checkDeliveryEligibility({ address: DUNDAS, menuSubtotalCents: 5000 });
  assert.equal(farAway.reason, "outside_radius", "the fallback still applies the radius");
});

// --- no side effects -----------------------------------------------------------

withDb("checking an address creates nothing", async () => {
  const counts = async () =>
    (
      await getPool().query<{ orders: number; payments: number; keys: number; outbox: number }>(
        `SELECT (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM payments) AS payments,
                (SELECT count(*) FROM idempotency_keys) AS keys, (SELECT count(*) FROM notification_outbox) AS outbox`,
      )
    ).rows[0];
  const before = await counts();
  for (const address of [STORE, DUNDAS, UNKNOWN, { ...STORE, line1: "55" }]) {
    await checkDeliveryEligibility({ address, menuSubtotalCents: 5000, items: [{ freeDelivery: true }] });
  }
  assert.deepEqual(await counts(), before);
});
