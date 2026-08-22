/**
 * The Clover webhook route, and the reaper that covers what it cannot (R1.3/R1.6).
 *
 * This is the point where an order becomes paid, so it is the point an attacker
 * would aim at: everything downstream — the kitchen ticket, the confirmation
 * email, the revenue figures — trusts the transition this route makes. It is
 * also the only place a Clover payment can be reconciled at all, because Clover
 * has no metadata passthrough and the checkout session id in
 * `payments.provider_reference` is the sole link back to the order.
 *
 * Orders here are created through the real `POST /api/orders` with `fetch`
 * stubbed to stand in for Clover, rather than seeded with SQL. That way the
 * session id the webhook is matched on is the one the order service actually
 * stored, and a change that broke that handoff would fail these tests instead of
 * passing them against a fixture that agreed with itself.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";
process.env.TRUST_PROXY_HEADERS = "true";

const MERCHANT_ID = "TESTMERCHANT123";
const SIGNING_SECRET = "test-webhook-signing-secret";

const { getPool, closePool, PostgresDatabase } = await import("@/db/pg-driver");
const { POST: createOrderRoute } = await import("@/app/api/orders/route");
const { POST: webhookRoute } = await import("@/app/api/payments/clover/webhook/route");
const { reapStalePayments } = await import("@/scripts/reap-payments");
const { writeIntegrationSecret, clearIntegrationSecretCache } = await import("@/lib/integration-secrets");
const { nextOrderSlots } = await import("@/lib/domain");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

let addressCounter = 0;
// Per-run unique: rate-limit budgets outlive the process, so a counter that
// restarts identically each run would share buckets across runs. See the note in
// tests/auth.test.ts.
const RUN = crypto.randomUUID().slice(0, 8);
const nextClientIp = () => `203.0.113.${(addressCounter += 1) % 250}-${RUN}`;

/**
 * Creates a real online order, with Clover's checkout call stubbed.
 *
 * Returns the order plus the session id the order service stored, which is
 * exactly what a genuine webhook would carry in its `data` field.
 */
async function createAwaitingPaymentOrder(): Promise<{ orderId: string; orderNumber: string; sessionId: string }> {
  const sessionId = `sess-${crypto.randomUUID()}`;
  process.env.CLOVER_MERCHANT_ID = MERCHANT_ID;
  process.env.CLOVER_API_TOKEN = "test-private-token";
  process.env.CLOVER_WEBHOOK_SECRET = SIGNING_SECRET;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        href: `https://checkout.clover.com/session/${sessionId}`,
        checkoutSessionId: sessionId,
        expirationTime: Date.now() + 15 * 60 * 1000,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  const { getSetting } = await import("@/db/runtime");
  const hours = await getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours");
  const [slot] = nextOrderSlots({ now: Date.now(), hours, timeZone: "America/Toronto", leadMinutes: 30, limit: 1 });

  const response = await createOrderRoute(
    new Request("https://order.pizza62.test/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": nextClientIp() },
      body: JSON.stringify({
        idempotencyKey: `test-${crypto.randomUUID()}-${crypto.randomUUID()}`,
        fulfilment: "pickup",
        customer: { name: "Grace Hopper", phone: "905-555-0199", email: "grace@example.test" },
        items: [{ productId: "poutine", quantity: 1 }],
        schedule: { type: "scheduled", scheduledFor: slot },
        paymentMethod: "online",
        tip: { type: "none" },
      }),
    }),
  );
  globalThis.fetch = realFetch;

  assert.equal(response.status, 201, "the stubbed Clover call should let the order through");
  const result = (await response.json()) as Record<string, unknown>;
  assert.equal(result.status, "awaiting_payment");
  assert.equal(result.checkoutUrl, `https://checkout.clover.com/session/${sessionId}`);
  return { orderId: String(result.orderId), orderNumber: String(result.orderNumber), sessionId };
}

/** Builds a correctly signed webhook request, the way Clover would. */
async function signedWebhook(
  payload: Record<string, unknown>,
  options: { secret?: string; atSeconds?: number; signBody?: string } = {},
): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = options.atSeconds ?? Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.secret ?? SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${options.signBody ?? body}`)),
  );
  const mac = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://order.pizza62.test/api/payments/clover/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "clover-signature": `t=${timestamp},v1=${mac}` },
    body,
  });
}

const approval = (sessionId: string) => ({
  id: `pay-${crypto.randomUUID()}`,
  merchantId: MERCHANT_ID,
  data: sessionId,
  status: "APPROVED",
  type: "PAYMENT",
});

type OrderRow = {
  status: string;
  payment_status: string;
  payment_row_status: string;
  /** Distinct outbox statuses across every kind queued for this order. */
  outbox: string[] | null;
  outbox_kinds: string[] | null;
  approvals: number;
};

async function readOrder(orderId: string): Promise<OrderRow> {
  // R1.4 made this an aggregate rather than a scalar: an order now queues two
  // notifications — the customer's confirmation and the restaurant's alert — and
  // both are parked and released together.
  const rows = await getPool().query<OrderRow>(
    `SELECT o.status, o.payment_status, p.status AS payment_row_status,
            (SELECT array_agg(DISTINCT n.status) FROM notification_outbox n WHERE n.payload_json::jsonb->>'orderId' = o.id) AS outbox,
            (SELECT array_agg(DISTINCT n.kind) FROM notification_outbox n WHERE n.payload_json::jsonb->>'orderId' = o.id) AS outbox_kinds,
            (SELECT count(*) FROM order_events e WHERE e.order_id = o.id AND e.note LIKE 'Clover payment approved%') AS approvals
     FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.id = $1`,
    [orderId],
  );
  return rows.rows[0];
}

// --- the transition that takes the money ------------------------------------

withDb("an approved payment marks the order paid and releases its confirmation", async () => {
  const order = await createAwaitingPaymentOrder();
  const response = await webhookRoute(await signedWebhook(approval(order.sessionId)));
  assert.equal(response.status, 200);

  const row = await readOrder(order.orderId);
  assert.equal(row.status, "received");
  assert.equal(row.payment_status, "paid");
  assert.equal(row.payment_row_status, "captured");
  assert.equal(row.approvals, 1);
  // Both notifications were parked at `waiting_payment` when the order was
  // created, precisely so an unpaid order never confirms itself or rings the
  // kitchen. This is what un-parks them — and it must un-park *both*, which is
  // why the webhook scopes its release by status rather than by kind.
  assert.deepEqual(
    [...(row.outbox_kinds ?? [])].sort(),
    ["customer_order_confirmation", "feedback_request", "restaurant_new_order"],
  );
  assert.ok(!(row.outbox ?? []).includes("waiting_payment"), `still parked: ${JSON.stringify(row.outbox)}`);
  // The feedback request is deliberately NOT released by payment — it waits for
  // staff to complete the order. Asking someone how their meal was before it has
  // been cooked would be worse than not asking.
  assert.ok(
    (row.outbox ?? []).includes("waiting_completion"),
    `feedback request should still be waiting: ${JSON.stringify(row.outbox)}`,
  );
});

withDb("redelivering the same approval changes nothing", async () => {
  // Clover retries until it gets a 2xx, so redelivery is routine rather than
  // exceptional. Applying it twice would write a second approval event and
  // re-open an order the kitchen may already have moved on.
  const order = await createAwaitingPaymentOrder();
  await webhookRoute(await signedWebhook(approval(order.sessionId)));
  const replay = await webhookRoute(await signedWebhook(approval(order.sessionId)));

  assert.equal(replay.status, 200, "a replay is acknowledged, not refused, or Clover retries forever");
  const row = await readOrder(order.orderId);
  assert.equal(row.approvals, 1);
  assert.equal(row.status, "received");
});

withDb("a decline records the failure but leaves the order payable", async () => {
  // The session is still valid for the rest of its 15 minutes and the customer
  // may retry on it with another card. Cancelling here would destroy an order
  // that is about to be paid for; the reaper decides instead.
  const order = await createAwaitingPaymentOrder();
  const response = await webhookRoute(
    await signedWebhook({ ...approval(order.sessionId), status: "DECLINED" }),
  );
  assert.equal(response.status, 200);

  const row = await readOrder(order.orderId);
  assert.equal(row.status, "awaiting_payment", "a decline must not cancel the order");
  assert.equal(row.payment_row_status, "declined");
  // Not 'failed': that value drops the row out of the partial
  // payments_idempotency_uq index and releases the checkout key (H-17b), which
  // is right when no session could be created and wrong when one exists.
  assert.notEqual(row.payment_row_status, "failed");
});

withDb("an approval still lands after a decline on the same session", async () => {
  const order = await createAwaitingPaymentOrder();
  await webhookRoute(await signedWebhook({ ...approval(order.sessionId), status: "DECLINED" }));
  await webhookRoute(await signedWebhook(approval(order.sessionId)));

  const row = await readOrder(order.orderId);
  assert.equal(row.status, "received");
  assert.equal(row.payment_row_status, "captured");
});

// --- everything that must not get through -----------------------------------

withDb("refuses an event signed with the wrong secret", async () => {
  const order = await createAwaitingPaymentOrder();
  const response = await webhookRoute(
    await signedWebhook(approval(order.sessionId), { secret: "not-the-signing-secret" }),
  );
  assert.equal(response.status, 400);
  assert.equal((await readOrder(order.orderId)).status, "awaiting_payment", "nothing may change");
});

withDb("refuses a body swapped under a valid signature", async () => {
  // The attack: capture a real signature, then point `data` at a different
  // order. The MAC covers the body, so the substitution invalidates it.
  const victim = await createAwaitingPaymentOrder();
  const attacker = await createAwaitingPaymentOrder();
  const signedFor = JSON.stringify(approval(attacker.sessionId));
  const request = await signedWebhook(approval(victim.sessionId), { signBody: signedFor });

  assert.equal((await webhookRoute(request)).status, 400);
  assert.equal((await readOrder(victim.orderId)).status, "awaiting_payment");
});

withDb("refuses a stale event", async () => {
  const order = await createAwaitingPaymentOrder();
  const response = await webhookRoute(
    await signedWebhook(approval(order.sessionId), { atSeconds: Math.floor(Date.now() / 1000) - 3600 }),
  );
  assert.equal(response.status, 400);
  assert.equal((await readOrder(order.orderId)).status, "awaiting_payment");
});

withDb("refuses an unsigned request", async () => {
  const order = await createAwaitingPaymentOrder();
  const response = await webhookRoute(
    new Request("https://order.pizza62.test/api/payments/clover/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(approval(order.sessionId)),
    }),
  );
  assert.equal(response.status, 400);
  assert.equal((await readOrder(order.orderId)).status, "awaiting_payment");
});

withDb("refuses a validly signed event for another merchant", async () => {
  // One signing secret can cover several merchants, so the signature alone does
  // not establish that the event is ours to act on.
  const order = await createAwaitingPaymentOrder();
  const response = await webhookRoute(
    await signedWebhook({ ...approval(order.sessionId), merchantId: "SOMEONEELSE999" }),
  );
  assert.equal(response.status, 409);
  assert.equal((await readOrder(order.orderId)).status, "awaiting_payment");
});

withDb("acknowledges an event for a session it has never seen", async () => {
  // Not an error: replays and events from another deployment are normal, and a
  // non-2xx would make Clover retry a delivery we will never act on.
  const response = await webhookRoute(await signedWebhook(approval(`sess-${crypto.randomUUID()}`)));
  assert.equal(response.status, 200);
});

withDb("ignores a non-payment event type", async () => {
  const order = await createAwaitingPaymentOrder();
  const response = await webhookRoute(
    await signedWebhook({ ...approval(order.sessionId), type: "ORDER" }),
  );
  assert.equal(response.status, 200);
  assert.equal((await readOrder(order.orderId)).status, "awaiting_payment");
});

// --- the reaper, which covers the event Clover never sends ------------------

withDb("cancels an order whose checkout window has closed", async () => {
  const order = await createAwaitingPaymentOrder();
  // 25 minutes on from creation: past the 15-minute session and the 5-minute
  // margin. Advancing the clock rather than back-dating the row keeps the order
  // exactly as the application wrote it.
  const cancelled = await reapStalePayments(new PostgresDatabase(getPool()), Date.now() + 25 * 60 * 1000);
  assert.ok(cancelled.some((row) => row.id === order.orderId));

  const row = await readOrder(order.orderId);
  assert.equal(row.status, "cancelled");
  assert.equal(row.payment_status, "expired");
  assert.equal(row.payment_row_status, "expired");
  // The customer never paid, so neither the confirmation nor the kitchen alert
  // may ever be sent.
  assert.deepEqual(row.outbox, ["cancelled"]);
});

withDb("leaves an order inside its checkout window alone", async () => {
  const order = await createAwaitingPaymentOrder();
  const cancelled = await reapStalePayments(new PostgresDatabase(getPool()), Date.now() + 5 * 60 * 1000);
  assert.ok(!cancelled.some((row) => row.id === order.orderId));
  assert.equal((await readOrder(order.orderId)).status, "awaiting_payment");
});

withDb("never touches an order that was already paid", async () => {
  // The race the guard exists for: an approval landing moments before the
  // reaper runs. Cancelling a paid order would take the customer's money and
  // then throw the order away.
  const order = await createAwaitingPaymentOrder();
  await webhookRoute(await signedWebhook(approval(order.sessionId)));

  const cancelled = await reapStalePayments(new PostgresDatabase(getPool()), Date.now() + 25 * 60 * 1000);
  assert.ok(!cancelled.some((row) => row.id === order.orderId));
  const row = await readOrder(order.orderId);
  assert.equal(row.status, "received");
  assert.equal(row.payment_row_status, "captured");
});

withDb("is safe to run twice", async () => {
  const order = await createAwaitingPaymentOrder();
  const at = Date.now() + 25 * 60 * 1000;
  await reapStalePayments(new PostgresDatabase(getPool()), at);
  const second = await reapStalePayments(new PostgresDatabase(getPool()), at);
  assert.ok(!second.some((row) => row.id === order.orderId), "an already-cancelled order is not re-reaped");
});


// --- where the signing secret is read from ----------------------------------

withDb("authenticates a delivery when the signing secret is only in the database", async () => {
  // The regression this exists for. Every Clover credential is read through
  // `readIntegrationSecret`, which is database-first — that is the whole point of
  // the Integrations tab, and it is where the owner actually pastes the signing
  // secret. The webhook route alone read `process.env` directly, so in the one
  // configuration the deployment guide tells you to use, every delivery 503'd
  // while `cloverWebhookConfigured()` reported the webhook as configured. Paid
  // orders sat in `awaiting_payment` until the reaper cancelled them, with Clover
  // holding the money and no refund API to give it back.
  //
  // The existing tests all missed it because they set `process.env` directly,
  // exercising the fallback and never the primary path. This one stores the
  // secret the way the owner does and removes the environment variable, so a
  // route that reads the environment cannot pass it.
  const databaseSecret = `db-only-${crypto.randomUUID()}`;
  const order = await createAwaitingPaymentOrder();

  const previousKey = process.env.SETTINGS_ENCRYPTION_KEY;
  const previousSecret = process.env.CLOVER_WEBHOOK_SECRET;
  process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    await writeIntegrationSecret("CLOVER_WEBHOOK_SECRET", databaseSecret, "test");
    delete process.env.CLOVER_WEBHOOK_SECRET;
    clearIntegrationSecretCache();

    const response = await webhookRoute(
      await signedWebhook(approval(order.sessionId), { secret: databaseSecret }),
    );
    assert.equal(response.status, 200, "a database-stored secret must authenticate the delivery");

    const row = await readOrder(order.orderId);
    assert.equal(row.status, "received");
    assert.equal(row.payment_status, "paid");
    assert.equal(row.payment_row_status, "captured");
  } finally {
    await getPool().query("DELETE FROM integration_secrets WHERE key = $1", ["CLOVER_WEBHOOK_SECRET"]);
    clearIntegrationSecretCache();
    if (previousKey === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.CLOVER_WEBHOOK_SECRET;
    else process.env.CLOVER_WEBHOOK_SECRET = previousSecret;
  }
});
