import { env } from "cloudflare:workers";
import { LAUNCH_SETTINGS, REGULAR_HOURS } from "@/lib/launch-config";
import {
  MENU_CATEGORIES,
  MENU_PRODUCTS,
  MENU_SEED_VERSION,
  TOPPING_SEEDS,
} from "@/lib/menu";

let initialization: Promise<void> | null = null;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    description TEXT, active INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY NOT NULL, category_id TEXT NOT NULL, name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
    product_type TEXT NOT NULL, image_url TEXT, base_price_cents INTEGER NOT NULL DEFAULT 0,
    taxable INTEGER NOT NULL DEFAULT 1, pickup_eligible INTEGER NOT NULL DEFAULT 1,
    delivery_eligible INTEGER NOT NULL DEFAULT 1, halal_capable INTEGER NOT NULL DEFAULT 0,
    promotion_eligible INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1,
    sold_out INTEGER NOT NULL DEFAULT 0, setup_required INTEGER NOT NULL DEFAULT 0,
    kitchen_label TEXT, configuration_json TEXT NOT NULL DEFAULT '{}',
    display_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS products_category_idx ON products(category_id)`,
  `CREATE TABLE IF NOT EXISTS product_variations (
    id TEXT PRIMARY KEY NOT NULL, product_id TEXT NOT NULL, name TEXT NOT NULL,
    base_price_cents INTEGER NOT NULL, extra_topping_price_cents INTEGER NOT NULL DEFAULT 0,
    included_topping_units_bps INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, display_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS variations_product_idx ON product_variations(product_id)`,
  `CREATE TABLE IF NOT EXISTS toppings (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, kitchen_label TEXT NOT NULL,
    is_meat INTEGER NOT NULL DEFAULT 0, has_halal_version INTEGER NOT NULL DEFAULT 0,
    halal_display_name TEXT, halal_available INTEGER NOT NULL DEFAULT 0,
    halal_cost_cents INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS promotions (
    id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, code TEXT UNIQUE, type TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0,
    combinable INTEGER NOT NULL DEFAULT 1, exclusive INTEGER NOT NULL DEFAULT 0,
    stack_group TEXT, active INTEGER NOT NULL DEFAULT 0, starts_at INTEGER, ends_at INTEGER,
    rule_json TEXT NOT NULL DEFAULT '{}', display_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS staff_users (
    id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, password_iterations INTEGER NOT NULL,
    permissions_json TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1,
    last_login_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS staff_sessions (
    id TEXT PRIMARY KEY NOT NULL, staff_user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS staff_sessions_user_idx ON staff_sessions(staff_user_id)`,
  // H-13: keep the runtime initializer in parity with drizzle/0000_quiet_epoch.sql
  // so empty and migrated databases converge on the same schema.
  `CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL,
    password_hash TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS customers_email_uq ON customers(email)`,
  `CREATE TABLE IF NOT EXISTS refunds (
    id TEXT PRIMARY KEY NOT NULL, order_id TEXT NOT NULL, payment_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL, reason TEXT NOT NULL, internal_note TEXT,
    customer_note TEXT, provider_reference TEXT, status TEXT NOT NULL, actor_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS refunds_order_idx ON refunds(order_id)`,
  `CREATE TABLE IF NOT EXISTS order_sequences (
    key TEXT PRIMARY KEY NOT NULL, current_number INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY NOT NULL, order_number TEXT NOT NULL UNIQUE, tracking_token_hash TEXT NOT NULL UNIQUE,
    feedback_token_hash TEXT NOT NULL, customer_id TEXT, customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL, customer_email TEXT NOT NULL, fulfilment TEXT NOT NULL,
    status TEXT NOT NULL, payment_status TEXT NOT NULL, payment_method TEXT NOT NULL,
    schedule_type TEXT NOT NULL, scheduled_for INTEGER, estimated_for INTEGER NOT NULL,
    address_json TEXT, instructions TEXT, pricing_json TEXT NOT NULL,
    subtotal_cents INTEGER NOT NULL, discount_cents INTEGER NOT NULL, tax_cents INTEGER NOT NULL,
    delivery_fee_cents INTEGER NOT NULL, tip_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
    acknowledged_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, created_at)`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY NOT NULL, order_id TEXT NOT NULL, product_id TEXT NOT NULL,
    product_name TEXT NOT NULL, variation_name TEXT, quantity INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL, line_total_cents INTEGER NOT NULL,
    taxable INTEGER NOT NULL, snapshot_json TEXT NOT NULL, instructions TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id)`,
  `CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY NOT NULL, order_id TEXT NOT NULL, provider TEXT NOT NULL,
    provider_reference TEXT, method TEXT NOT NULL, status TEXT NOT NULL,
    amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
    failure_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS order_events (
    id TEXT PRIMARY KEY NOT NULL, order_id TEXT NOT NULL, previous_status TEXT,
    next_status TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT, note TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
    target_type TEXT NOT NULL, target_id TEXT NOT NULL, previous_json TEXT,
    next_json TEXT, reason TEXT, request_id TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS time_clock_events (
    id TEXT PRIMARY KEY NOT NULL, staff_user_id TEXT NOT NULL, session_id TEXT NOT NULL,
    action TEXT NOT NULL, occurred_at INTEGER NOT NULL, source TEXT NOT NULL,
    correction_of TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS clock_user_time_idx ON time_clock_events(staff_user_id, occurred_at)`,
  // C-06: compare-and-swap guard row per employee (see db/schema.ts timeClockState).
  `CREATE TABLE IF NOT EXISTS time_clock_state (
    staff_user_id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL, session_id TEXT,
    transition_id TEXT, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS correction_requests (
    id TEXT PRIMARY KEY NOT NULL, staff_user_id TEXT NOT NULL, event_id TEXT NOT NULL,
    requested_time INTEGER NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL,
    reviewer_id TEXT, reviewer_note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS time_off_requests (
    id TEXT PRIMARY KEY NOT NULL, staff_user_id TEXT NOT NULL, starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL, partial_day INTEGER NOT NULL DEFAULT 0, note TEXT,
    status TEXT NOT NULL, reviewer_id TEXT, reviewer_note TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS feedback_questions (
    id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL, rating_scale INTEGER,
    required INTEGER NOT NULL DEFAULT 0, condition_json TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1, display_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS feedback_responses (
    id TEXT PRIMARY KEY NOT NULL, order_id TEXT NOT NULL UNIQUE, overall_rating INTEGER NOT NULL,
    answers_json TEXT NOT NULL, written_feedback TEXT, reviewed_at INTEGER,
    internal_note TEXT, submitted_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS notification_outbox (
    id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, recipient TEXT, payload_json TEXT NOT NULL,
    status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, scheduled_for INTEGER NOT NULL,
    sent_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    key_hash TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL, resource_id TEXT,
    status TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key_hash TEXT PRIMARY KEY NOT NULL, window_started_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS analytics_events (
    id TEXT PRIMARY KEY NOT NULL, session_id TEXT, customer_id TEXT, order_id TEXT,
    event_name TEXT NOT NULL, context_json TEXT NOT NULL DEFAULT '{}', occurred_at INTEGER NOT NULL
  )`,
] as const;

export function getD1(): D1Database {
  if (!env.DB) throw new Error("The Pizza 62 database binding is unavailable");
  return env.DB;
}

export async function ensureDatabase(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    const database = getD1();
    for (let index = 0; index < schemaStatements.length; index += 40) {
      await database.batch(
        schemaStatements
          .slice(index, index + 40)
          .map((statement) => database.prepare(statement)),
      );
    }
    await seedLaunchData(database);
    await runDataMigrations(database);
  })();
  try {
    await initialization;
  } catch (error) {
    initialization = null;
    throw error;
  }
}

async function seedLaunchData(database: D1Database): Promise<void> {
  const now = Date.now();
  const operations: D1PreparedStatement[] = [];
  const currentMenuSeed = await database
    .prepare("SELECT value_json FROM settings WHERE key = 'menuSeedVersion'")
    .first<{ value_json: string }>();
  const menuNeedsSeed = currentMenuSeed?.value_json !== JSON.stringify(MENU_SEED_VERSION);
  const settingsEntries = {
    business: LAUNCH_SETTINGS.business,
    ordering: LAUNCH_SETTINGS.ordering,
    delivery: LAUNCH_SETTINGS.delivery,
    taxAndTips: LAUNCH_SETTINGS.taxAndTips,
    operations: LAUNCH_SETTINGS.operations,
    featureFlags: LAUNCH_SETTINGS.featureFlags,
    content: LAUNCH_SETTINGS.content,
    hours: REGULAR_HOURS,
  };
  for (const [key, value] of Object.entries(settingsEntries)) {
    operations.push(
      database
        .prepare(
          "INSERT OR IGNORE INTO settings (key, value_json, version, updated_at) VALUES (?, ?, 1, ?)",
        )
        .bind(key, JSON.stringify(value), now),
    );
  }
  if (menuNeedsSeed) {
    // C-08: a seed-version bump must not reset owner-owned rows. Settings are seeded
    // once by the INSERT OR IGNORE above and thereafter belong to the owner; the
    // retirement lists that used to run on every bump now run once each, as gated
    // entries in DATA_MIGRATIONS, so an item the owner deliberately re-enabled is
    // not silently switched off again by the next deployment.
    for (const [id, name, categorySlug, displayOrder] of MENU_CATEGORIES) {
      operations.push(
        database
          .prepare(
            `INSERT INTO categories
             (id, name, slug, active, display_order, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING`,
          )
          .bind(id, name, categorySlug, displayOrder, now, now),
      );
    }
    for (const [index, topping] of TOPPING_SEEDS.entries()) {
      const [id, name, isMeat, halalAvailable] = topping;
      operations.push(
        database
          .prepare(
            `INSERT INTO toppings
             (id, name, kitchen_label, is_meat, has_halal_version, halal_display_name,
              halal_available, halal_cost_cents, active, display_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING`,
          )
          .bind(
            id,
            name,
            name.toUpperCase(),
            isMeat ? 1 : 0,
            halalAvailable ? 1 : 0,
            halalAvailable ? `Halal ${name}` : null,
            halalAvailable ? 1 : 0,
            index,
            now,
            now,
          ),
      );
    }
    for (const [index, product] of MENU_PRODUCTS.entries()) {
      // C-08: the seed is initial data only. Existing products/variations belong to
      // the owner after first seed, so on conflict we DO NOTHING and never overwrite
      // owner-edited prices, names, or configuration. Deliberate corrections run as
      // explicit, one-time migrations in runDataMigrations() below.
      operations.push(
        database
          .prepare(
            `INSERT INTO products
             (id, category_id, name, slug, description, product_type, base_price_cents, taxable,
              pickup_eligible, delivery_eligible, halal_capable, promotion_eligible, active, sold_out,
              setup_required, kitchen_label, configuration_json, display_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, 1, 0, 0, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO NOTHING`,
          )
          .bind(
            product.id,
            product.categoryId,
            product.name,
            product.id,
            product.description,
            product.productType,
            product.basePriceCents,
            product.pickupEligible === false ? 0 : 1,
            product.deliveryEligible === false ? 0 : 1,
            product.halalCapable ? 1 : 0,
            product.name.toUpperCase().slice(0, 40),
            JSON.stringify(product.configuration ?? {}),
            index,
            now,
            now,
          ),
      );
      for (const [variationIndex, variation] of (product.variations ?? []).entries()) {
        operations.push(
          database
            .prepare(
              `INSERT INTO product_variations
               (id, product_id, name, base_price_cents, extra_topping_price_cents,
                included_topping_units_bps, active, display_order, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
               ON CONFLICT(id) DO NOTHING`,
            )
            .bind(
              variation.id,
              product.id,
              variation.name,
              variation.basePriceCents,
              variation.extraToppingPriceCents,
              variation.includedToppingUnitsBps ?? 0,
              variationIndex,
              now,
              now,
            ),
        );
      }
    }
    operations.push(
      database
        .prepare(
          `INSERT INTO settings (key, value_json, version, updated_at)
           VALUES ('menuSeedVersion', ?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
             version = version + 1, updated_at = excluded.updated_at`,
        )
        .bind(JSON.stringify(MENU_SEED_VERSION), now),
    );
  }
  operations.push(
    database
      .prepare("INSERT OR IGNORE INTO order_sequences (key, current_number) VALUES ('public_order', 1000)"),
  );
  const feedback = [
    ["overall", "Overall experience", "rating", 5, 1, {}, 10],
    ["pizza-quality", "Pizza quality", "rating", 5, 0, { includesProductType: "pizza" }, 20],
    ["wings", "Wings", "rating", 5, 0, { includesProductType: "wings" }, 30],
    ["speed", "Pickup or delivery speed", "rating", 5, 0, { wordingByFulfilment: true }, 40],
    ["comments", "Anything else we should know?", "text", null, 0, {}, 50],
  ] as const;
  for (const row of feedback) {
    operations.push(
      database
        .prepare(
          `INSERT OR IGNORE INTO feedback_questions
           (id, label, type, rating_scale, required, condition_json, active, display_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .bind(row[0], row[1], row[2], row[3], row[4], JSON.stringify(row[5]), row[6], now, now),
    );
  }
  for (let index = 0; index < operations.length; index += 40) {
    await database.batch(operations.slice(index, index + 40));
  }
}

// Explicit, one-time data transforms. Each entry runs at most once (gated by a
// `dataMigration:<id>` settings marker) and is the sanctioned way to change
// owner-owned rows after the insert-only seed (see C-08). Adding a new correction
// means appending an entry here — never widening the seed back into an upsert.
const DATA_MIGRATIONS: Array<{
  id: string;
  run: (database: D1Database, now: number) => D1PreparedStatement[];
}> = [
  {
    // H-01/H-02: bring pizza base prices and per-size extra-topping rates to the
    // corrected flyer baseline for databases seeded before the correction.
    id: "2026-07-24-flyer-price-correction",
    run: (database, now) => {
      const statements: D1PreparedStatement[] = [];
      for (const product of MENU_PRODUCTS) {
        statements.push(
          database
            .prepare("UPDATE products SET base_price_cents = ?, updated_at = ? WHERE id = ?")
            .bind(product.basePriceCents, now, product.id),
        );
        for (const variation of product.variations ?? []) {
          statements.push(
            database
              .prepare(
                `UPDATE product_variations
                 SET base_price_cents = ?, extra_topping_price_cents = ?,
                     included_topping_units_bps = ?, updated_at = ?
                 WHERE id = ?`,
              )
              .bind(
                variation.basePriceCents,
                variation.extraToppingPriceCents,
                variation.includedToppingUnitsBps ?? 0,
                now,
                variation.id,
              ),
          );
        }
      }
      return statements;
    },
  },
  {
    // H-21: turn the unconfirmed public claims off on databases seeded before the
    // correction. `json_set` patches only these two fields, so every other feature
    // flag the owner has since changed is preserved (C-08).
    id: "2026-07-24-disable-unconfirmed-claims",
    run: (database, now) => [
      database
        .prepare(
          `UPDATE settings
           SET value_json = json_set(value_json, '$.halalPreparationClaim', json('false'),
                                                 '$.dryRubLabel', json('false')),
               version = version + 1, updated_at = ?
           WHERE key = 'featureFlags'`,
        )
        .bind(now),
    ],
  },
  {
    // C-08: retire the launch items that are not on the flyer. This used to run on
    // every menu-seed bump, which silently re-deactivated anything the owner had
    // deliberately turned back on. As a gated migration it applies exactly once.
    id: "2026-07-24-retire-off-flyer-items",
    run: (database, now) => {
      const retiredCategories = ["regular-pizzas", "pizza-wing-combos"];
      const retiredProducts = [
        "build-your-own-pizza", "pickup-two-large", "combo-two-medium", "combo-two-large", "combo-two-xl",
        "pickup-jumbo-one", "pickup-jumbo-three", "pickup-large-one", "pickup-large-three",
        "pickup-medium-one", "pickup-medium-three", "pickup-slab-one", "pickup-slab-three",
        "pickup-xl-one", "pickup-xl-three", "fifa-game-day",
        "12-wings", "buffalo-chicken-wrap", "chicken-burger", "chicken-fingers-fries",
        "fried-chicken-dumplings", "shawarma-wrap",
      ];
      return [
        database
          .prepare(
            `UPDATE categories SET active = 0, updated_at = ?
             WHERE id IN (${retiredCategories.map(() => "?").join(",")})`,
          )
          .bind(now, ...retiredCategories),
        database
          .prepare(
            `UPDATE products SET active = 0, updated_at = ?
             WHERE id IN (${retiredProducts.map(() => "?").join(",")})`,
          )
          .bind(now, ...retiredProducts),
      ];
    },
  },
];

async function runDataMigrations(database: D1Database): Promise<void> {
  const now = Date.now();
  for (const migration of DATA_MIGRATIONS) {
    const marker = `dataMigration:${migration.id}`;
    const already = await database
      .prepare("SELECT 1 AS present FROM settings WHERE key = ?")
      .bind(marker)
      .first<{ present: number }>();
    if (already) continue;
    const statements = migration.run(database, now);
    statements.push(
      database
        .prepare("INSERT OR IGNORE INTO settings (key, value_json, version, updated_at) VALUES (?, ?, 1, ?)")
        .bind(marker, JSON.stringify({ appliedAt: now }), now),
    );
    for (let index = 0; index < statements.length; index += 40) {
      await database.batch(statements.slice(index, index + 40));
    }
  }
}

export async function getSetting<T>(key: string): Promise<T> {
  await ensureDatabase();
  const row = await getD1()
    .prepare("SELECT value_json FROM settings WHERE key = ?")
    .bind(key)
    .first<{ value_json: string }>();
  if (!row) throw new Error(`Missing configuration: ${key}`);
  return JSON.parse(row.value_json) as T;
}

export async function listSettings(): Promise<Record<string, unknown>> {
  await ensureDatabase();
  const result = await getD1().prepare("SELECT key, value_json, version, updated_at FROM settings").all<{
    key: string;
    value_json: string;
    version: number;
    updated_at: number;
  }>();
  return Object.fromEntries(
    result.results.map((row) => [
      row.key,
      { value: JSON.parse(row.value_json), version: row.version, updatedAt: row.updated_at },
    ]),
  );
}

export async function writeAudit(input: {
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  previous?: unknown;
  next?: unknown;
  reason?: string;
  requestId?: string;
}): Promise<void> {
  await ensureDatabase();
  await getD1()
    .prepare(
      `INSERT INTO audit_log
       (id, actor_id, action, target_type, target_id, previous_json, next_json, reason, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.actorId,
      input.action,
      input.targetType,
      input.targetId,
      input.previous === undefined ? null : JSON.stringify(input.previous),
      input.next === undefined ? null : JSON.stringify(input.next),
      input.reason ?? null,
      input.requestId ?? null,
      Date.now(),
    )
    .run();
}

export function safeJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
