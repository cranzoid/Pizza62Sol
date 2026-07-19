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
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_by TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    description TEXT, active INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY, category_id TEXT NOT NULL, name TEXT NOT NULL,
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
    id TEXT PRIMARY KEY, product_id TEXT NOT NULL, name TEXT NOT NULL,
    base_price_cents INTEGER NOT NULL, extra_topping_price_cents INTEGER NOT NULL DEFAULT 0,
    included_topping_units_bps INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, display_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS variations_product_idx ON product_variations(product_id)`,
  `CREATE TABLE IF NOT EXISTS toppings (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kitchen_label TEXT NOT NULL,
    is_meat INTEGER NOT NULL DEFAULT 0, has_halal_version INTEGER NOT NULL DEFAULT 0,
    halal_display_name TEXT, halal_available INTEGER NOT NULL DEFAULT 0,
    halal_cost_cents INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS promotions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT UNIQUE, type TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0,
    combinable INTEGER NOT NULL DEFAULT 1, exclusive INTEGER NOT NULL DEFAULT 0,
    stack_group TEXT, active INTEGER NOT NULL DEFAULT 0, starts_at INTEGER, ends_at INTEGER,
    rule_json TEXT NOT NULL DEFAULT '{}', display_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS staff_users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
    password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, password_iterations INTEGER NOT NULL,
    permissions_json TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1,
    last_login_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS staff_sessions (
    id TEXT PRIMARY KEY, staff_user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS staff_sessions_user_idx ON staff_sessions(staff_user_id)`,
  `CREATE TABLE IF NOT EXISTS order_sequences (
    key TEXT PRIMARY KEY, current_number INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, order_number TEXT NOT NULL UNIQUE, tracking_token_hash TEXT NOT NULL UNIQUE,
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
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT NOT NULL,
    product_name TEXT NOT NULL, variation_name TEXT, quantity INTEGER NOT NULL,
    unit_price_cents INTEGER NOT NULL, line_total_cents INTEGER NOT NULL,
    taxable INTEGER NOT NULL, snapshot_json TEXT NOT NULL, instructions TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id)`,
  `CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL, provider TEXT NOT NULL,
    provider_reference TEXT, method TEXT NOT NULL, status TEXT NOT NULL,
    amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
    failure_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS order_events (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL, previous_status TEXT,
    next_status TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT, note TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL,
    target_type TEXT NOT NULL, target_id TEXT NOT NULL, previous_json TEXT,
    next_json TEXT, reason TEXT, request_id TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS time_clock_events (
    id TEXT PRIMARY KEY, staff_user_id TEXT NOT NULL, session_id TEXT NOT NULL,
    action TEXT NOT NULL, occurred_at INTEGER NOT NULL, source TEXT NOT NULL,
    correction_of TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS clock_user_time_idx ON time_clock_events(staff_user_id, occurred_at)`,
  `CREATE TABLE IF NOT EXISTS correction_requests (
    id TEXT PRIMARY KEY, staff_user_id TEXT NOT NULL, event_id TEXT NOT NULL,
    requested_time INTEGER NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL,
    reviewer_id TEXT, reviewer_note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS time_off_requests (
    id TEXT PRIMARY KEY, staff_user_id TEXT NOT NULL, starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL, partial_day INTEGER NOT NULL DEFAULT 0, note TEXT,
    status TEXT NOT NULL, reviewer_id TEXT, reviewer_note TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS feedback_questions (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, type TEXT NOT NULL, rating_scale INTEGER,
    required INTEGER NOT NULL DEFAULT 0, condition_json TEXT NOT NULL DEFAULT '{}',
    active INTEGER NOT NULL DEFAULT 1, display_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS feedback_responses (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, overall_rating INTEGER NOT NULL,
    answers_json TEXT NOT NULL, written_feedback TEXT, reviewed_at INTEGER,
    internal_note TEXT, submitted_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS notification_outbox (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, recipient TEXT, payload_json TEXT NOT NULL,
    status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, scheduled_for INTEGER NOT NULL,
    sent_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
    key_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, resource_id TEXT,
    status TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key_hash TEXT PRIMARY KEY, window_started_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS analytics_events (
    id TEXT PRIMARY KEY, session_id TEXT, customer_id TEXT, order_id TEXT,
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
    operations.push(
      database
        .prepare("UPDATE settings SET value_json = ?, version = version + 1, updated_at = ? WHERE key = 'business'")
        .bind(JSON.stringify(LAUNCH_SETTINGS.business), now),
      database
        .prepare("UPDATE settings SET value_json = ?, version = version + 1, updated_at = ? WHERE key = 'ordering'")
        .bind(JSON.stringify(LAUNCH_SETTINGS.ordering), now),
      database
        .prepare("UPDATE settings SET value_json = ?, version = version + 1, updated_at = ? WHERE key = 'operations'")
        .bind(JSON.stringify(LAUNCH_SETTINGS.operations), now),
      database
        .prepare("UPDATE settings SET value_json = ?, version = version + 1, updated_at = ? WHERE key = 'featureFlags'")
        .bind(JSON.stringify(LAUNCH_SETTINGS.featureFlags), now),
      database
        .prepare("UPDATE categories SET active = 0, updated_at = ? WHERE id IN ('regular-pizzas', 'pizza-wing-combos')")
        .bind(now),
      database
        .prepare("UPDATE products SET active = 0, updated_at = ? WHERE id IN ('build-your-own-pizza', 'pickup-two-large', 'combo-two-medium', 'combo-two-large', 'combo-two-xl')")
        .bind(now),
    );
    for (const [id, name, categorySlug, displayOrder] of MENU_CATEGORIES) {
      operations.push(
        database
          .prepare(
            `INSERT INTO categories
             (id, name, slug, active, display_order, created_at, updated_at)
             VALUES (?, ?, ?, 1, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, slug = excluded.slug,
               active = 1, display_order = excluded.display_order, updated_at = excluded.updated_at`,
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
             ON CONFLICT(id) DO UPDATE SET name = excluded.name,
               kitchen_label = excluded.kitchen_label, is_meat = excluded.is_meat,
               has_halal_version = excluded.has_halal_version,
               halal_display_name = excluded.halal_display_name,
               halal_available = excluded.halal_available, active = 1,
               display_order = excluded.display_order, updated_at = excluded.updated_at`,
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
      operations.push(
        database
          .prepare(
            `INSERT INTO products
             (id, category_id, name, slug, description, product_type, base_price_cents, taxable,
              pickup_eligible, delivery_eligible, halal_capable, promotion_eligible, active, sold_out,
              setup_required, kitchen_label, configuration_json, display_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1, 1, 0, 0, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET category_id = excluded.category_id, name = excluded.name,
               slug = excluded.slug, description = excluded.description, product_type = excluded.product_type,
               base_price_cents = excluded.base_price_cents, pickup_eligible = excluded.pickup_eligible,
               delivery_eligible = excluded.delivery_eligible, halal_capable = excluded.halal_capable,
               active = 1, setup_required = 0, kitchen_label = excluded.kitchen_label,
               configuration_json = excluded.configuration_json, display_order = excluded.display_order,
               updated_at = excluded.updated_at`,
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
               ON CONFLICT(id) DO UPDATE SET product_id = excluded.product_id, name = excluded.name,
                 base_price_cents = excluded.base_price_cents,
                 extra_topping_price_cents = excluded.extra_topping_price_cents,
                 included_topping_units_bps = excluded.included_topping_units_bps,
                 active = 1, display_order = excluded.display_order, updated_at = excluded.updated_at`,
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
