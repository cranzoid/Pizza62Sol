/**
 * The feedback form, the five-star hand-off, and the thank-you coupon.
 *
 * Three properties worth pinning down.
 *
 * **The questions match what was eaten.** Asking a customer who bought a bottle
 * of water how the crust was produces a rating of the crust they did not have,
 * and that rating goes into the same average as everyone else's. The old test
 * for this was the product *type*, which is why the wings question — keyed to a
 * type called "wings" that has never existed — was shown to nobody, ever, and
 * why a customer who bought two large pizzas inside a deal was asked nothing
 * about pizza. So the questions key off what the order contained.
 *
 * **The coupon reaches everyone who answered, and only if it can be honoured.**
 * A one-star answer earns the same thank-you as a five: rewarding good ratings
 * only is against Google's review policy and, more to the point, buys a number
 * that is no longer a measurement. And an emailed code the checkout would refuse
 * is worse than no email, so the offer has to exist before the message is
 * queued.
 *
 * **The Google link is returned to every rating.** The five-star path opens it
 * sooner; it does not open it to the exclusion of anyone else. That distinction
 * is the difference between asking for reviews and gating them.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { createOrder } = await import("@/lib/order-service");
const { GET: feedbackRead, POST: feedbackWrite } = await import("@/app/api/feedback/route");
const { getSetting } = await import("@/db/runtime");
const { formatMoney, nextOrderSlots } = await import("@/lib/domain");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const RUN = crypto.randomUUID().slice(0, 8);
let counter = 0;
const nextClientIp = () => `203.0.113.${(counter += 1) % 250}-${RUN}`;

const hours = reachable
  ? await getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours")
  : [];
const SLOT = reachable
  ? nextOrderSlots({ now: Date.now(), hours, timeZone: "America/Toronto", leadMinutes: 30, limit: 1 })[0]
  : 0;

type Placed = { orderNumber: string; feedbackToken: string; orderId: string };

/**
 * An order, completed, with its feedback link in hand.
 *
 * Driven through `createOrder` rather than inserted, so the items really are
 * items and the traits the form derives are derived from a real order.
 */
async function completedOrder(items: Array<Record<string, unknown>>, email = `taster-${crypto.randomUUID()}@example.test`): Promise<Placed> {
  const result = await createOrder({
    fulfilment: "pickup",
    items,
    paymentMethod: "pay_at_store",
    schedule: { type: "scheduled", scheduledFor: SLOT },
    customer: { name: "Feedback Tester", phone: "9055550142", email },
    idempotencyKey: `feedback-${RUN}-${crypto.randomUUID()}-${crypto.randomUUID()}`,
  });
  await getPool().query("UPDATE orders SET status = 'completed' WHERE id = $1", [result.orderId]);
  return {
    orderNumber: String(result.orderNumber),
    feedbackToken: String(result.feedbackToken),
    orderId: String(result.orderId),
  };
}

const readForm = (placed: Placed) =>
  feedbackRead(
    new Request(`https://order.pizza62.test/api/feedback?order=${encodeURIComponent(placed.orderNumber)}`, {
      headers: { "x-tracking-token": placed.feedbackToken, "x-azure-clientip": nextClientIp() },
    }),
  );

const submitForm = (placed: Placed, answers: Record<string, number>, writtenFeedback = "") =>
  feedbackWrite(
    new Request("https://order.pizza62.test/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": nextClientIp() },
      body: JSON.stringify({ orderNumber: placed.orderNumber, token: placed.feedbackToken, answers, writtenFeedback }),
    }),
  );

const questionIds = async (placed: Placed): Promise<string[]> => {
  const response = await readForm(placed);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { questions: Array<{ id: string }> };
  return body.questions.map((question) => question.id);
};

const largePizza = {
  productId: "large-pizza",
  variationId: "large-pizza-three-toppings",
  quantity: 1,
  toppings: [
    { toppingId: "pepperoni", placement: "whole" },
    { toppingId: "mushrooms", placement: "whole" },
    { toppingId: "onions", placement: "whole" },
  ],
};

// --- the questions match what was eaten -------------------------------------

withDb("asks a pizza customer about the crust, the sauce and the toppings", async () => {
  const ids = await questionIds(await completedOrder([largePizza]));
  for (const expected of ["crust", "sauce", "toppings"]) {
    assert.ok(ids.includes(expected), `a pizza order should be asked "${expected}" — got ${ids.join(", ")}`);
  }
});

withDb("asks nobody about the crust of a pizza they did not buy", async () => {
  const ids = await questionIds(await completedOrder([{ productId: "water-bottle", quantity: 1 }]));
  assert.deepEqual(ids.filter((id) => ["crust", "sauce", "toppings", "wings"].includes(id)), []);
  assert.ok(ids.includes("overall"), "everyone is still asked the overall question");
});

withDb("asks about the pizza inside a deal, not just a pizza bought on its own", async () => {
  // The regression that made this worth testing: a deal is a `bundle`, so a
  // question keyed to the product type "pizza" skipped the customer who had just
  // eaten two of them.
  const ids = await questionIds(
    await completedOrder([
      {
        productId: "two-for-one-large",
        quantity: 1,
        modifiers: [
          { id: "pizza-1-cheese", values: ["Regular Cheese"] },
          { id: "pizza-1-toppings", values: ["pepperoni"] },
          { id: "pizza-2-cheese", values: ["Regular Cheese"] },
          { id: "pizza-2-toppings", values: ["mushrooms"] },
        ],
      },
    ]),
  );
  assert.ok(ids.includes("crust"), `a two-pizza deal should be asked about the crust — got ${ids.join(", ")}`);
});

withDb("asks about the wings, which no customer was ever asked before", async () => {
  const ids = await questionIds(
    await completedOrder([{ productId: "1-lb-wings", quantity: 1, modifiers: [{ id: "wing-flavours", values: ["Hot"] }] }]),
  );
  assert.ok(ids.includes("wings"), `a wings order should be asked about the wings — got ${ids.join(", ")}`);
  assert.ok(!ids.includes("crust"), "wings alone are not a pizza");
});

withDb("has retired the vague pizza-quality question", async () => {
  const ids = await questionIds(await completedOrder([largePizza]));
  assert.ok(!ids.includes("pizza-quality"), "crust, sauce and toppings replace it");
});

// --- the coupon --------------------------------------------------------------

withDb("emails the thank-you coupon to someone who rated us one star", async () => {
  const placed = await completedOrder([largePizza]);
  const response = await submitForm(placed, { overall: 1, crust: 1 }, "Cold by the time I got home.");
  assert.equal(response.status, 201);
  const body = (await response.json()) as { reward: { offer: string; worth: string } | null };
  assert.ok(body.reward, "a bad rating earns the same thank-you as a good one");
  assert.equal(body.reward.worth, `${formatMoney(399)} off`);

  const queued = await getPool().query<{ recipient: string; kind: string }>(
    "SELECT kind, recipient FROM notification_outbox WHERE kind = 'feedback_reward' AND payload_json LIKE $1",
    [`%${placed.orderId}%`],
  );
  assert.equal(queued.rows.length, 1, "exactly one coupon per submission");
});

withDb("quotes the promotion rather than a second copy of its value", async () => {
  // Move the offer, and the mail has to move with it — that is the whole reason
  // the amount is not stored beside the wording.
  await getPool().query("UPDATE promotions SET amount = 500 WHERE id = 'feedback-thank-you'");
  try {
    const response = await submitForm(await completedOrder([largePizza]), { overall: 4 });
    const body = (await response.json()) as { reward: { worth: string } | null };
    assert.equal(body.reward?.worth, `${formatMoney(500)} off`, "the mail follows the promotion");
  } finally {
    await getPool().query("UPDATE promotions SET amount = 399 WHERE id = 'feedback-thank-you'");
  }
});

withDb("sends no coupon when the code behind it is switched off", async () => {
  await getPool().query("UPDATE promotions SET active = 0 WHERE id = 'feedback-thank-you'");
  try {
    const placed = await completedOrder([largePizza]);
    const response = await submitForm(placed, { overall: 5 });
    assert.equal(response.status, 201, "the feedback is still saved");
    const body = (await response.json()) as { reward: unknown };
    assert.equal(body.reward, null, "never promise a code the checkout would refuse");
    const queued = await getPool().query(
      "SELECT id FROM notification_outbox WHERE kind = 'feedback_reward' AND payload_json LIKE $1",
      [`%${placed.orderId}%`],
    );
    assert.equal(queued.rows.length, 0);
  } finally {
    await getPool().query("UPDATE promotions SET active = 1 WHERE id = 'feedback-thank-you'");
  }
});

withDb("sends no coupon to a counter order with no email address", async () => {
  const placed = await completedOrder([largePizza]);
  await getPool().query("UPDATE orders SET customer_email = '' WHERE id = $1", [placed.orderId]);
  const response = await submitForm(placed, { overall: 5 });
  const body = (await response.json()) as { reward: unknown };
  assert.equal(body.reward, null, "the screen must not mention a mail that was never queued");
  const queued = await getPool().query(
    "SELECT id FROM notification_outbox WHERE kind = 'feedback_reward' AND payload_json LIKE $1",
    [`%${placed.orderId}%`],
  );
  assert.equal(queued.rows.length, 0);
});

// --- the review invitation ---------------------------------------------------

withDb("returns the Google review link to every rating, not only to five stars", async () => {
  for (const overall of [1, 3, 5]) {
    const response = await submitForm(await completedOrder([largePizza]), { overall });
    const body = (await response.json()) as { googleReviewUrl: string | null };
    assert.ok(body.googleReviewUrl, `a ${overall}-star rating must still be offered the review link`);
  }
});

withDb("still refuses a second submission for the same order", async () => {
  const placed = await completedOrder([largePizza]);
  assert.equal((await submitForm(placed, { overall: 5 })).status, 201);
  assert.equal((await submitForm(placed, { overall: 1 })).status, 409);
});
