/**
 * The last-order cutoff, enforced on the server.
 *
 * The website has always refused ASAP once `storeStatus` says ordering is
 * closed — "a kitchen that closes at 22:00 cannot start a pizza at 21:59" — but
 * only in the browser. Anything calling the API directly could still place an
 * ASAP order at 21:59. These pin the server to the browser's exact boundary, and
 * pin everything else (scheduled orders, the till, cutoff 0, plain closed hours)
 * to what it did before.
 *
 * The clock is frozen with `mock.timers` so the boundary can be tested to the
 * second. The date is a Wednesday in the past: rows created "at" it can never
 * look like they were created during another suite's run.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, mock } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";
process.env.TRUST_PROXY_HEADERS = "true";

const { getPool, closePool } = await import("@/db/pg-driver");
const { getSetting } = await import("@/db/runtime");
const { storeStatus } = await import("@/lib/domain");
const { quoteOrder } = await import("@/lib/order-service");
const { createPasswordHash } = await import("@/lib/auth");
const { POST: loginRoute } = await import("@/app/api/auth/login/route");
const { POST: publicOrderRoute } = await import("@/app/api/orders/route");
const { POST: staffOrderRoute } = await import("@/app/api/admin/orders/route");

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

const TZ = "America/Toronto";
const RUN = crypto.randomUUID().slice(0, 8);
let counter = 0;
const nextClientIp = () => `192.0.2.${(counter += 1) % 250}-${RUN}`;
const nextKey = () => `cutoff-${RUN}-${crypto.randomUUID()}-${crypto.randomUUID()}`;

type Hours = Array<{ weekday: number; openMinute: number; closeMinute: number }>;
type Ordering = Record<string, unknown> & { lastOrderCutoffMinutes?: number };

// Read from the seeded settings rather than restated, so the boundaries below
// move with the configuration instead of silently testing stale numbers.
const hours = reachable ? await getSetting<Hours>("hours") : [];
const ordering = reachable ? await getSetting<Ordering>("ordering") : ({} as Ordering);
const CUTOFF = Number(ordering.lastOrderCutoffMinutes ?? 0);
const CLOSE = hours.find((day) => day.weekday === 3)?.closeMinute ?? 0;

/** Wednesday 2026-10-14 (EDT), `minuteOfDay` local, plus `second`. */
const wednesdayAt = (minuteOfDay: number, second = 0) =>
  Date.parse("2026-10-14T00:00:00-04:00") + minuteOfDay * 60_000 + second * 1000;
const LAST_MINUTE = CLOSE - CUTOFF;

/** Runs `body` with `Date.now()` frozen at `instant`. */
async function at<T>(instant: number, body: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["Date"], now: instant });
  try {
    return await body();
  } finally {
    mock.timers.reset();
  }
}

const accepting = (instant: number) =>
  storeStatus(instant, hours, TZ, { lastOrderCutoffMinutes: CUTOFF }).open;

const CUSTOMER = { name: "Ada Lovelace", phone: "905-555-0142", email: "ada@example.test" };
const cart = (schedule?: { type: "asap" | "scheduled"; scheduledFor?: number }) => ({
  fulfilment: "pickup" as const,
  items: [{ productId: "poutine", quantity: 2 }],
  paymentMethod: "pay_at_store" as const,
  tip: { type: "none" as const },
  ...(schedule ? { schedule } : {}),
});
const ASAP = { type: "asap" as const };

const postPublic = (body: unknown) =>
  publicOrderRoute(
    new Request("https://order.pizza62.test/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": nextClientIp() },
      body: JSON.stringify(body),
    }),
  );

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

/** Quote and create the same public order at `instant`. */
async function quoteAndCreate(instant: number, schedule: Parameters<typeof cart>[0] = ASAP) {
  return at(instant, async () => {
    const quote = await quoteOrder(cart(schedule));
    const response = await postPublic({ ...cart(schedule), idempotencyKey: nextKey(), customer: CUSTOMER });
    return { quote, status: response.status, body: await json(response) };
  });
}

// --- staff helpers ------------------------------------------------------------

const PASSWORD = "Correct Horse Battery Staple 62";

async function signedInAsOwner(): Promise<string> {
  const id = crypto.randomUUID();
  const email = `cutoff-${id}@example.test`;
  const hash = await createPasswordHash(PASSWORD);
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_users (id,email,name,role,password_hash,password_salt,password_iterations,permissions_json,active,created_at,updated_at)
     VALUES ($1,$2,'Cutoff Tester','owner',$3,$4,$5,'[]',1,$6,$6)`,
    [id, email, hash.hash, hash.salt, hash.iterations, now],
  );
  const response = await loginRoute(
    new Request("https://order.pizza62.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": nextClientIp() },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  assert.equal(response.status, 200);
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

const staffOrder = (cookie: string, body: unknown) =>
  staffOrderRoute(
    new Request("https://order.pizza62.test/api/admin/orders", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

// --- the tests ----------------------------------------------------------------

withDb("the seeded configuration is the one these tests assume", async () => {
  assert.ok(CUTOFF > 0, "the seeded ordering setting should have a last-order cutoff");
  assert.ok(CLOSE > CUTOFF + 120, "Wednesday should have seeded hours long enough to test against");
});

withDb("an ASAP order comfortably before the cutoff is accepted", async () => {
  const instant = wednesdayAt(LAST_MINUTE - 100);
  assert.equal(accepting(instant), true);
  const { quote, status } = await quoteAndCreate(instant);
  assert.equal(quote.ok, true, JSON.stringify(quote.issues));
  assert.equal(status, 201);
});

withDb("an ASAP order immediately before the boundary is accepted, exactly as storeStatus says", async () => {
  // storeStatus's cutoff is inclusive of its last minute: with a 22:00 close and
  // a 20-minute cutoff, 21:40:00 through 21:40:59 still read as open.
  for (const instant of [wednesdayAt(LAST_MINUTE - 1, 59), wednesdayAt(LAST_MINUTE), wednesdayAt(LAST_MINUTE, 59)]) {
    assert.equal(accepting(instant), true, `storeStatus should be open at ${new Date(instant).toISOString()}`);
    const { quote, status } = await quoteAndCreate(instant);
    assert.equal(quote.ok, true, JSON.stringify(quote.issues));
    assert.equal(status, 201);
  }
});

withDb("an ASAP order at the boundary is refused, exactly as storeStatus says", async () => {
  const instant = wednesdayAt(LAST_MINUTE + 1);
  assert.equal(accepting(instant), false);
  const { quote, status, body } = await quoteAndCreate(instant);
  assert.equal(status, 409);
  assert.equal(body.code, "LAST_ORDERS_CLOSED");
  assert.equal(quote.ok, false);
  assert.deepEqual(quote.issues.map((issue) => issue.code), ["LAST_ORDERS_CLOSED"]);
});

withDb("an ASAP order after the cutoff but before the doors close is refused", async () => {
  for (const instant of [wednesdayAt(CLOSE - 10), wednesdayAt(CLOSE - 1, 59)]) {
    const { quote, status, body } = await quoteAndCreate(instant);
    assert.equal(status, 409);
    assert.equal(body.code, "LAST_ORDERS_CLOSED");
    assert.match(String(body.error), /Last orders have gone in/);
    assert.equal(quote.ok, false);
    assert.deepEqual(quote.issues.map((issue) => issue.code), ["LAST_ORDERS_CLOSED"]);
  }
});

withDb("an ASAP order with no schedule at all is judged the same way by quote and create", async () => {
  // Both default a missing schedule to ASAP; neither may skip the cutoff for it.
  const { quote, status, body } = await quoteAndCreate(wednesdayAt(CLOSE - 10), undefined);
  assert.equal(status, 409);
  assert.equal(body.code, "LAST_ORDERS_CLOSED");
  assert.equal(quote.ok, false);
  assert.deepEqual(quote.issues.map((issue) => issue.code), ["LAST_ORDERS_CLOSED"]);
});

withDb("an order after closing keeps the existing closed-hours refusal", async () => {
  const { quote, status, body } = await quoteAndCreate(wednesdayAt(CLOSE + 30));
  assert.equal(status, 400);
  assert.equal(body.code, "ORDER_VALIDATION_FAILED");
  assert.match(String(body.error), /outside the restaurant's configured hours/);
  assert.equal(quote.ok, false);
  assert.equal(quote.issues.length, 1, "one refusal for one cause");
  assert.match(quote.issues[0].message, /outside the restaurant's configured hours/);
});

withDb("a cutoff of 0 behaves exactly as before", async () => {
  await getPool().query("UPDATE settings SET value_json = $1 WHERE key = 'ordering'", [
    JSON.stringify({ ...ordering, lastOrderCutoffMinutes: 0 }),
  ]);
  try {
    for (const instant of [wednesdayAt(CLOSE - 10), wednesdayAt(CLOSE - 1, 59)]) {
      const { quote, status } = await quoteAndCreate(instant);
      assert.equal(quote.ok, true, JSON.stringify(quote.issues));
      assert.equal(status, 201);
    }
  } finally {
    await getPool().query("UPDATE settings SET value_json = $1 WHERE key = 'ordering'", [JSON.stringify(ordering)]);
  }
});

withDb("a scheduled order placed after the ASAP cutoff is still accepted", async () => {
  // The website keeps offering slots up to closing; only ASAP stops early.
  const { quote, status } = await quoteAndCreate(wednesdayAt(LAST_MINUTE + 1), {
    type: "scheduled",
    scheduledFor: wednesdayAt(CLOSE),
  });
  assert.equal(quote.ok, true, JSON.stringify(quote.issues));
  assert.equal(status, 201);
});

withDb("staff phone and walk-in ASAP orders after the cutoff are unchanged", async () => {
  await at(wednesdayAt(CLOSE - 10), async () => {
    const cookie = await signedInAsOwner();
    for (const channel of ["phone", "walk_in"] as const) {
      const quote = await staffOrder(cookie, { ...cart(ASAP), channel, quoteOnly: true });
      assert.equal(quote.status, 200);
      const quoted = await json(quote);
      assert.equal(quoted.ok, true, JSON.stringify(quoted.issues));

      const created = await staffOrder(cookie, { ...cart(ASAP), channel, idempotencyKey: nextKey(), customer: CUSTOMER });
      assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    }
  });
});
