/**
 * Closures and the last-order cutoff (H-08).
 *
 * The audit's point was that orders could be promised when the store cannot
 * fulfil them. Two distinct ways that happens, and both are covered here:
 *
 * **Holidays.** The only control was an indefinite `paused` toggle, which
 * depends on someone remembering to switch it back. A closure is a window with
 * an end. The property that matters most is that it is judged against the time
 * the order is *for* — otherwise a Christmas Day pickup ordered on the Monday is
 * accepted and nothing objects until Christmas Day.
 *
 * **The cutoff.** A kitchen that closes at 22:00 cannot start a pizza at 21:59.
 * "Open" and "still taking orders" are different questions, and answering the
 * first when the customer asked the second is how an order arrives that nobody
 * can cook.
 *
 * The scope cases are not incidental: closing delivery while the counter keeps
 * selling is the ordinary situation, not the exotic one.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { storeStatus, activeClosure } = await import("@/lib/domain");
const { closureFor, closureMessage } = await import("@/lib/closures");
const { quoteOrder } = await import("@/lib/order-service");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const HOURS = [
  { weekday: 0, label: "Sunday", openMinute: 720, closeMinute: 1320 },
  { weekday: 1, label: "Monday", openMinute: 660, closeMinute: 1320 },
  { weekday: 2, label: "Tuesday", openMinute: 660, closeMinute: 1320 },
  { weekday: 3, label: "Wednesday", openMinute: 660, closeMinute: 1320 },
  { weekday: 4, label: "Thursday", openMinute: 660, closeMinute: 1380 },
  { weekday: 5, label: "Friday", openMinute: 660, closeMinute: 1440 },
  { weekday: 6, label: "Saturday", openMinute: 660, closeMinute: 1440 },
];

/** A Wednesday at the given Toronto wall-clock time. */
const wednesdayAt = (hour: number, minute = 0) =>
  new Date(`2026-08-19T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-04:00`).getTime();

const closure = (overrides: Partial<Parameters<typeof closureFor>[1][number]> = {}) => ({
  id: "c1",
  startsAt: wednesdayAt(0),
  endsAt: wednesdayAt(23, 59),
  scope: "both" as const,
  reason: "Civic holiday",
  customerMessage: null,
  ...overrides,
});

// --- the cutoff --------------------------------------------------------------

test("stops taking orders before the doors close", () => {
  // Open at 21:00, twenty minutes before the 21:40 cutoff on a 22:00 close.
  const early = storeStatus(wednesdayAt(21, 0), HOURS, "America/Toronto", { lastOrderCutoffMinutes: 20 });
  assert.equal(early.open, true);
  assert.ok(early.acceptingUntil);
  assert.equal(new Date(early.acceptingUntil).getTime(), wednesdayAt(21, 40));

  // 21:50 — the lights are on, the kitchen is not taking anything new.
  const late = storeStatus(wednesdayAt(21, 50), HOURS, "America/Toronto", { lastOrderCutoffMinutes: 20 });
  assert.equal(late.open, false, "past the cutoff, ordering is closed even though the store is not");
  // `changesAt` still reports the real closing time, so the UI can distinguish
  // "we stopped taking orders" from "we have shut".
  assert.equal(late.changesAt, wednesdayAt(22, 0));
});

test("a zero cutoff keeps the old behaviour exactly", () => {
  // The setting is owner-editable, and 0 has to mean "take orders until closing"
  // rather than "take no orders".
  const status = storeStatus(wednesdayAt(21, 59), HOURS, "America/Toronto", { lastOrderCutoffMinutes: 0 });
  assert.equal(status.open, true);
});

test("never pushes the cutoff before opening time", () => {
  // A cutoff longer than the trading day would otherwise produce a store that is
  // shut all day with no explanation.
  const status = storeStatus(wednesdayAt(12, 0), HOURS, "America/Toronto", { lastOrderCutoffMinutes: 10_000 });
  assert.ok(status.acceptingUntil);
  assert.equal(status.acceptingUntil, wednesdayAt(11, 0), "clamped to opening, not before it");
});

// --- closures ----------------------------------------------------------------

test("a closure overrides the weekly schedule and explains itself", () => {
  const status = storeStatus(wednesdayAt(13, 0), HOURS, "America/Toronto", { closures: [closure()] });
  assert.equal(status.open, false);
  assert.ok(status.closure);
  assert.equal(status.closure.reason, "Civic holiday");
  // `changesAt` is the end of the closure, not the next scheduled opening —
  // telling a customer the store opens at 11 on a day it is shut is worse than
  // saying nothing.
  assert.equal(status.changesAt, closure().endsAt);
});

test("a delivery closure leaves the counter open", () => {
  const delivery = closure({ scope: "delivery", reason: "No driver tonight" });
  const asPickup = storeStatus(wednesdayAt(13, 0), HOURS, "America/Toronto", {
    closures: [delivery],
    fulfilment: "pickup",
  });
  const asDelivery = storeStatus(wednesdayAt(13, 0), HOURS, "America/Toronto", {
    closures: [delivery],
    fulfilment: "delivery",
  });
  assert.equal(asPickup.open, true, "the kitchen is not closed just because the driver is off");
  assert.equal(asDelivery.open, false);
});

test("reports the closure that ends soonest", () => {
  // Two overlapping closures must not produce a reopening time later than the
  // truth — "back Tuesday" when it is back tomorrow loses business.
  const long = closure({ id: "long", endsAt: wednesdayAt(23, 0) });
  const short = closure({ id: "short", endsAt: wednesdayAt(15, 0) });
  const found = activeClosure(wednesdayAt(13, 0), [long, short]);
  assert.equal(found?.id, "short");
});

test("ignores a closure that has not started or has finished", () => {
  const past = closure({ startsAt: wednesdayAt(1), endsAt: wednesdayAt(2) });
  const future = closure({ startsAt: wednesdayAt(20), endsAt: wednesdayAt(22) });
  assert.equal(activeClosure(wednesdayAt(13), [past, future]), null);
  // The end is exclusive: the moment a closure ends, the store is open.
  assert.equal(activeClosure(past.endsAt, [past]), null);
  assert.ok(activeClosure(past.startsAt, [past]), "the start is inclusive");
});

test("writes a message a customer can act on when none was given", () => {
  const message = closureMessage(closure({ customerMessage: null }));
  assert.match(message, /closed right now/);
  assert.match(message, /Civic holiday/);
  assert.match(message, /Back/);
  // A supplied message wins outright.
  assert.equal(closureMessage(closure({ customerMessage: "Family wedding — back Monday!" })), "Family wedding — back Monday!");
});

test("judges a scheduled order on the time it is for", () => {
  // The trap: ordering on Monday for a Christmas Day pickup. Checking "is the
  // store closed now" accepts it, and nothing objects until Christmas Day.
  const christmas = closure({ startsAt: wednesdayAt(0), endsAt: wednesdayAt(23, 59) });
  const orderingNow = wednesdayAt(0) - 3 * 86_400_000;
  assert.equal(closureFor(orderingNow, [christmas], "pickup"), null, "the store is open when the order is placed");
  assert.ok(closureFor(wednesdayAt(13), [christmas], "pickup"), "and shut when the order is wanted");
});

// --- enforcement -------------------------------------------------------------

withDb("refuses to quote an order for a time the store is closed", async () => {
  const startsAt = Date.now() - 60_000;
  const endsAt = Date.now() + 6 * 3_600_000;
  const id = `test-closure-${crypto.randomUUID()}`;
  await getPool().query(
    `INSERT INTO store_closures (id, starts_at, ends_at, scope, reason, customer_message, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,'both','Test closure',$4,'test',$5,$5)`,
    [id, startsAt, endsAt, "We are closed for a staff meeting.", Date.now()],
  );
  try {
    const quote = await quoteOrder({
      fulfilment: "pickup",
      items: [{ productId: "poutine", quantity: 1 }],
      paymentMethod: "pay_at_store",
    });
    assert.equal(quote.ok, false);
    const issue = quote.issues.find((entry) => entry.code === "STORE_CLOSED");
    assert.ok(issue, "a closure must reach the customer as a refusal, not a surprise at checkout");
    assert.equal(issue.message, "We are closed for a staff meeting.");
  } finally {
    await getPool().query("DELETE FROM store_closures WHERE id = $1", [id]);
  }
});

withDb("a delivery-only closure still lets pickup through", async () => {
  const id = `test-closure-${crypto.randomUUID()}`;
  await getPool().query(
    `INSERT INTO store_closures (id, starts_at, ends_at, scope, reason, customer_message, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,'delivery','No driver',NULL,'test',$4,$4)`,
    [id, Date.now() - 60_000, Date.now() + 6 * 3_600_000, Date.now()],
  );
  try {
    const pickup = await quoteOrder({
      fulfilment: "pickup",
      items: [{ productId: "poutine", quantity: 1 }],
      paymentMethod: "pay_at_store",
    });
    assert.ok(
      !pickup.issues.some((entry) => entry.code === "STORE_CLOSED"),
      "closing delivery must not close the counter",
    );

    const delivery = await quoteOrder({
      fulfilment: "delivery",
      items: [{ productId: "poutine", quantity: 4 }],
      paymentMethod: "online",
    });
    assert.ok(delivery.issues.some((entry) => entry.code === "STORE_CLOSED"));
  } finally {
    await getPool().query("DELETE FROM store_closures WHERE id = $1", [id]);
  }
});
