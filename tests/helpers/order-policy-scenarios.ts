/**
 * The behaviour matrix behind the order-policy parity test.
 *
 * Every scenario here was run against `createOrder` / `quoteOrder` *before*
 * `CreateOrderContext` was split into explicit policies, and the outcomes were
 * frozen in `tests/fixtures/order-policy-parity.json`. The parity test runs the
 * same matrix against the refactored engine and requires identical outcomes, so
 * "the refactor changes no behaviour" is a recorded fact rather than a claim.
 *
 * Only deterministic facts are recorded: whether the order was accepted, the
 * refusal's status, code and message, the stored channel, payment and contact
 * fields, acknowledgement, the outbox kinds queued, whether attribution was
 * kept, and the money. Ids, order numbers and timestamps are not.
 *
 * The clock is frozen on a Wednesday in the past (as the cutoff tests do) so
 * ASAP and cutoff scenarios do not depend on when the suite runs.
 *
 * Lives outside `tests/*.test.ts` so the runner does not execute it directly.
 */
import { mock } from "node:test";

export type ParityKind = "website" | "staff_phone" | "staff_walk_in";

export type ParityHooks = {
  create: (kind: ParityKind, body: Record<string, unknown>) => Promise<{ orderId?: unknown; duplicate?: unknown }>;
  quote: (kind: ParityKind, body: Record<string, unknown>) => Promise<{
    ok: boolean;
    issues: Array<{ index: number | null; code: string; message: string }>;
    totals: Record<string, number>;
  }>;
};

type Pool = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

const KINDS: ParityKind[] = ["website", "staff_phone", "staff_walk_in"];

/** Wednesday 2026-10-14 (EDT) at `minuteOfDay` local. */
const wednesdayAt = (minuteOfDay: number) => Date.parse("2026-10-14T00:00:00-04:00") + minuteOfDay * 60_000;
const thursdayAt = (minuteOfDay: number) => Date.parse("2026-10-15T00:00:00-04:00") + minuteOfDay * 60_000;

const OPEN_INSTANT = wednesdayAt(18 * 60);
const SLOT = wednesdayAt(19 * 60);
const NEXT_DAY_SLOT = thursdayAt(12 * 60);

const FULL = { name: "Ada Lovelace", phone: "905-555-0142", email: "ada@example.test" };
const IN_AREA = { line1: "55 Parkdale Ave N", unit: "2", city: "Hamilton", province: "ON", postalCode: "L8H 5W7" };
const NOT_HAMILTON = { line1: "1 Yonge Street", city: "Toronto", province: "ON", postalCode: "M5E 1E5" };
const ATTRIBUTION = {
  first: { utm_source: "google", utm_medium: "cpc", utm_campaign: "parity", captured_at: 1_790_000_000_000 },
  last: { utm_source: "google", utm_medium: "cpc", utm_campaign: "parity", captured_at: 1_790_000_000_000 },
};

const pickup = (extra: Record<string, unknown> = {}) => ({
  fulfilment: "pickup",
  items: [{ productId: "poutine", quantity: 2 }],
  paymentMethod: "pay_at_store",
  tip: { type: "none" },
  schedule: { type: "scheduled", scheduledFor: SLOT },
  customer: FULL,
  ...extra,
});

const delivery = (extra: Record<string, unknown> = {}) => ({
  ...pickup(),
  fulfilment: "delivery",
  items: [{ productId: "poutine", quantity: 3 }],
  address: IN_AREA,
  ...extra,
});

type CreateScenario = {
  name: string;
  body: Record<string, unknown>;
  at?: number;
  /** Runs before and after the scenario, e.g. to flip a setting and restore it. */
  setting?: { key: string; patch: Record<string, unknown> };
  /** Submit the same body twice with one key and record the replay. */
  replay?: boolean;
};

const CREATE_SCENARIOS: CreateScenario[] = [
  { name: "pickup, full contact, pay at store, scheduled", body: pickup() },
  { name: "pickup, name only", body: pickup({ customer: { name: "Blue cap" } }) },
  { name: "pickup, name and phone, no email", body: pickup({ customer: { name: "Ada", phone: "905-555-0142" } }) },
  { name: "pickup, no name", body: pickup({ customer: { phone: "905-555-0142", email: "ada@example.test" } }) },
  { name: "pickup, malformed phone", body: pickup({ customer: { name: "Ada", phone: "123" } }) },
  { name: "pickup, malformed email", body: pickup({ customer: { name: "Ada", email: "not-an-email" } }) },
  { name: "delivery in area, full contact, pay at store", body: delivery() },
  { name: "delivery, name only", body: delivery({ customer: { name: "Ada" } }) },
  { name: "delivery outside Hamilton", body: delivery({ address: NOT_HAMILTON }) },
  { name: "delivery below the minimum", body: delivery({ items: [{ productId: "poutine", quantity: 1 }] }) },
  { name: "pickup, online payment without Clover", body: pickup({ paymentMethod: "online" }) },
  { name: "pickup, staff-only product", body: pickup({ items: [{ productId: "chicken-burger", quantity: 1 }] }) },
  { name: "pickup ASAP while open", body: pickup({ schedule: { type: "asap" } }) },
  { name: "pickup with no schedule while open", body: pickup({ schedule: undefined }) },
  {
    name: "pickup ASAP ten minutes before close",
    body: pickup({ schedule: { type: "asap" } }),
    at: wednesdayAt(22 * 60 - 10),
  },
  {
    name: "pickup scheduled for tomorrow, placed after the cutoff",
    body: pickup({ schedule: { type: "scheduled", scheduledFor: NEXT_DAY_SLOT } }),
    at: wednesdayAt(22 * 60 - 10),
  },
  { name: "pickup with campaign attribution", body: pickup({ attribution: ATTRIBUTION }) },
  {
    name: "pickup paid at store while pay-at-store pickup is switched off",
    body: pickup(),
    setting: { key: "ordering", patch: { payAtStorePickupEnabled: false } },
  },
  { name: "pickup with an unknown promo code", body: pickup({ couponCode: "NOPE62" }) },
  { name: "the same submission twice", body: pickup(), replay: true },
  {
    name: "request body tries to claim a trusted context",
    body: pickup({
      customer: { name: "Blue cap" },
      channel: "walk_in",
      staffEntry: true,
      staffUserId: "intruder",
      context: { channel: "ai_phone" },
    }),
  },
];

type QuoteScenario = { name: string; body: Record<string, unknown>; at?: number; setting?: CreateScenario["setting"] };

const QUOTE_SCENARIOS: QuoteScenario[] = [
  { name: "quote: pickup pay at store", body: pickup() },
  { name: "quote: delivery pay at store", body: delivery() },
  { name: "quote: delivery below the minimum", body: delivery({ items: [{ productId: "poutine", quantity: 1 }] }) },
  { name: "quote: staff-only product", body: pickup({ items: [{ productId: "chicken-burger", quantity: 1 }] }) },
  { name: "quote: ASAP while open", body: pickup({ schedule: { type: "asap" } }) },
  { name: "quote: ASAP ten minutes before close", body: pickup({ schedule: { type: "asap" } }), at: wednesdayAt(22 * 60 - 10) },
  { name: "quote: no schedule ten minutes before close", body: pickup({ schedule: undefined }), at: wednesdayAt(22 * 60 - 10) },
  {
    name: "quote: pay at store while pay-at-store pickup is switched off",
    body: pickup(),
    setting: { key: "ordering", patch: { payAtStorePickupEnabled: false } },
  },
  { name: "quote: online payment without Clover", body: pickup({ paymentMethod: "online" }) },
  { name: "quote: no payment method named", body: pickup({ paymentMethod: undefined }) },
];

async function at<T>(instant: number, body: () => Promise<T>): Promise<T> {
  mock.timers.enable({ apis: ["Date"], now: instant });
  try {
    return await body();
  } finally {
    mock.timers.reset();
  }
}

async function withSetting<T>(pool: Pool, setting: CreateScenario["setting"], body: () => Promise<T>): Promise<T> {
  if (!setting) return body();
  const original = (await pool.query<{ value_json: string }>("SELECT value_json FROM settings WHERE key = $1", [setting.key]))
    .rows[0].value_json;
  await pool.query("UPDATE settings SET value_json = $1 WHERE key = $2", [
    JSON.stringify({ ...JSON.parse(original), ...setting.patch }),
    setting.key,
  ]);
  try {
    return await body();
  } finally {
    await pool.query("UPDATE settings SET value_json = $1 WHERE key = $2", [original, setting.key]);
  }
}

async function describeOrder(pool: Pool, orderId: string) {
  const order = (
    await pool.query<Record<string, unknown>>(
      `SELECT channel, status, payment_status, payment_method, customer_name, customer_phone, customer_email,
              fulfilment, schedule_type, address_json, acknowledged_at, attribution_json,
              subtotal_cents, discount_cents, tax_cents, delivery_fee_cents, tip_cents, total_cents
       FROM orders WHERE id = $1`,
      [orderId],
    )
  ).rows[0];
  const outbox = await pool.query<{ kind: string }>(
    "SELECT kind FROM notification_outbox WHERE payload_json::jsonb->>'orderId' = $1 ORDER BY kind",
    [orderId],
  );
  const events = await pool.query<{ actor_type: string; actor_id: string | null; note: string }>(
    "SELECT actor_type, actor_id, note FROM order_events WHERE order_id = $1 ORDER BY created_at",
    [orderId],
  );
  return {
    channel: order.channel,
    status: order.status,
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method,
    customer: { name: order.customer_name, phone: order.customer_phone, email: order.customer_email },
    fulfilment: order.fulfilment,
    scheduleType: order.schedule_type,
    address: order.address_json ? JSON.parse(String(order.address_json)) : null,
    acknowledged: order.acknowledged_at !== null,
    attributionKept: order.attribution_json !== null,
    money: {
      subtotal: Number(order.subtotal_cents),
      discount: Number(order.discount_cents),
      tax: Number(order.tax_cents),
      deliveryFee: Number(order.delivery_fee_cents),
      tip: Number(order.tip_cents),
      total: Number(order.total_cents),
    },
    outboxKinds: outbox.rows.map((row) => row.kind),
    events: events.rows.map((row) => ({ actorType: row.actor_type, actorId: row.actor_id, note: row.note })),
  };
}

function refusal(error: unknown) {
  const detail = error as { status?: number; code?: string; message?: string };
  return { accepted: false, status: detail.status ?? null, code: detail.code ?? null, message: detail.message ?? String(error) };
}

let keySequence = 0;
const RUN = crypto.randomUUID().slice(0, 8);
const nextKey = () => `parity-${RUN}-${(keySequence += 1)}-${crypto.randomUUID()}`;

/** Runs every scenario for every context and returns the deterministic outcomes, keyed by name. */
export async function runParityScenarios(pool: Pool, hooks: ParityHooks): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  for (const scenario of CREATE_SCENARIOS) {
    for (const kind of KINDS) {
      const key = nextKey();
      const body = { ...scenario.body, idempotencyKey: key };
      results[`${scenario.name} [${kind}]`] = await withSetting(pool, scenario.setting, () =>
        at(scenario.at ?? OPEN_INSTANT, async () => {
          try {
            const first = await hooks.create(kind, body);
            const replay = scenario.replay ? await hooks.create(kind, body) : null;
            return {
              accepted: true,
              duplicate: Boolean(first.duplicate),
              ...(replay ? { replay: { duplicate: Boolean(replay.duplicate), sameOrder: replay.orderId === first.orderId } } : {}),
              order: await describeOrder(pool, String(first.orderId)),
            };
          } catch (error) {
            return refusal(error);
          }
        }),
      );
    }
  }
  for (const scenario of QUOTE_SCENARIOS) {
    for (const kind of KINDS) {
      results[`${scenario.name} [${kind}]`] = await withSetting(pool, scenario.setting, () =>
        at(scenario.at ?? OPEN_INSTANT, async () => {
          try {
            const quote = await hooks.quote(kind, scenario.body);
            return {
              ok: quote.ok,
              issues: quote.issues.map((issue) => ({ index: issue.index, code: issue.code, message: issue.message })),
              totals: quote.totals,
            };
          } catch (error) {
            return refusal(error);
          }
        }),
      );
    }
  }
  return results;
}
