import { env } from "@/lib/runtime-env";
import { LAUNCH_SETTINGS, REGULAR_HOURS } from "@/lib/launch-config";
import {
  MENU_CATEGORIES,
  MENU_PRODUCTS,
  MENU_SEED_VERSION,
  TOPPING_SEEDS,
  type ModifierSectionSeed,
} from "@/lib/menu";

let initialization: Promise<void> | null = null;


export function getD1(): D1Database {
  if (!env.DB) throw new Error("The Pizza 62 database binding is unavailable");
  return env.DB;
}

/**
 * Confirms once per process that the database has been migrated.
 *
 * This used to create every table and run the seed on the first request, which
 * cannot work with more than one replica: concurrent cold starts would race on
 * DDL and on the seed's check-then-insert. Schema and seed now belong to the
 * migration job (`npm run db:migrate`), and the ~15 handlers that call this keep
 * doing so only to fail with an actionable message rather than a raw relation
 * error when someone points the app at an unmigrated database.
 */
export async function ensureDatabase(): Promise<void> {
  initialization ??= (async () => {
    try {
      const ready = await getD1()
        .prepare("SELECT value_json FROM settings WHERE key = 'business'")
        .first();
      if (ready) return;
    } catch (error) {
      throw new Error(
        `The Pizza 62 database is unavailable or has not been migrated — run "npm run db:migrate". (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
    throw new Error('The Pizza 62 database has no launch settings — run "npm run db:migrate".');
  })();
  try {
    await initialization;
  } catch (error) {
    initialization = null;
    throw error;
  }
}

export async function seedLaunchData(database: D1Database): Promise<void> {
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
    alerts: LAUNCH_SETTINGS.alerts,
    featureFlags: LAUNCH_SETTINGS.featureFlags,
    content: LAUNCH_SETTINGS.content,
    hours: REGULAR_HOURS,
  };
  for (const [key, value] of Object.entries(settingsEntries)) {
    operations.push(
      database
        .prepare(
          "INSERT INTO settings (key, value_json, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT (key) DO NOTHING",
        )
        .bind(key, JSON.stringify(value), now),
    );
  }
  if (menuNeedsSeed) {
    // C-08: a seed-version bump must not reset owner-owned rows. Settings are seeded
    // once by the conflict-ignoring insert above and thereafter belong to the owner; the
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
             version = settings.version + 1, updated_at = excluded.updated_at`,
        )
        .bind(JSON.stringify(MENU_SEED_VERSION), now),
    );
  }
  operations.push(
    database
      .prepare("INSERT INTO order_sequences (key, current_number) VALUES ('public_order', 1000) ON CONFLICT (key) DO NOTHING"),
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
          `INSERT INTO feedback_questions
           (id, label, type, rating_scale, required, condition_json, active, display_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
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
  run: (database: D1Database, now: number) => D1PreparedStatement[] | Promise<D1PreparedStatement[]>;
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
    // correction. `jsonb_set` patches only these two fields, so every other feature
    // flag the owner has since changed is preserved (C-08).
    id: "2026-07-24-disable-unconfirmed-claims",
    run: (database, now) => [
      database
        .prepare(
          `UPDATE settings
           SET value_json = jsonb_set(
                 jsonb_set(value_json::jsonb, '{halalPreparationClaim}', 'false'::jsonb),
                 '{dryRubLabel}', 'false'::jsonb
               )::text,
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
  {
    // Splits "Crust, bake & sauce" into a single-choice crust (Regular/Thin/Thick)
    // and a separate bake & sauce group, and gives every pizza inside a deal the
    // same cheese and halal choices a standalone pizza has, in the same order.
    // Owner-tuned numbers on a section that still exists (min, max, included, extra
    // price) are carried across; the group structure itself is what this replaces.
    id: "2026-07-27-pizza-option-groups",
    run: async (database, now) => {
      const statements: D1PreparedStatement[] = [];
      const stored = await database
        .prepare("SELECT id, configuration_json FROM products")
        .all<{ id: string; configuration_json: string | null }>();
      const current = new Map(
        stored.results.map((row) => [row.id, safeJson<Record<string, unknown>>(row.configuration_json ?? "{}", {})]),
      );
      for (const product of MENU_PRODUCTS) {
        const existing = current.get(product.id);
        const seed = (product.configuration ?? {}) as Record<string, unknown>;
        if (!existing) continue;
        const next: Record<string, unknown> = { ...existing };
        if (Array.isArray(seed.crustOptions)) {
          next.crustOptions = seed.crustOptions;
          next.bakeSauceOptions = seed.bakeSauceOptions;
          next.cheeseEnabled = existing.cheeseEnabled ?? true;
          delete next.pizzaBaseOptions;
        }
        if (Array.isArray(seed.sections)) {
          const previous = new Map(
            (Array.isArray(existing.sections) ? (existing.sections as ModifierSectionSeed[]) : []).map((section) => [section.id, section]),
          );
          next.sections = (seed.sections as ModifierSectionSeed[]).map((section) => {
            const owned = previous.get(section.id);
            if (!owned) return section;
            return {
              ...section,
              min: owned.min ?? section.min,
              max: owned.max ?? section.max,
              included: owned.included ?? section.included,
              extraPriceCents: owned.extraPriceCents ?? section.extraPriceCents,
            };
          });
        }
        if (next.crustOptions === undefined && next.sections === undefined) continue;
        statements.push(
          database
            .prepare("UPDATE products SET configuration_json = ?, updated_at = ? WHERE id = ?")
            .bind(JSON.stringify(next), now, product.id),
        );
      }
      return statements;
    },
  },
  {
    // Owner decision, 2026-08-21: HST applies to the delivery fee, and delivery
    // orders have a $20 minimum.
    //
    // Settings are seeded once and belong to the owner afterwards (C-08), so a
    // database seeded before today keeps `feeTaxable: false` and `minimumCents:
    // 0` no matter what the launch defaults say — hence a gated patch rather
    // than a seed change alone. `jsonb_set` touches exactly these two keys and
    // preserves the radius, the fee and the outside-area message, which the
    // owner may already have tuned.
    //
    // Runs once. A later change of mind is an admin edit, not another migration.
    id: "2026-08-21-delivery-tax-and-minimum",
    run: (database, now) => [
      database
        .prepare(
          `UPDATE settings
             SET value_json = jsonb_set(
                   jsonb_set(value_json::jsonb, '{feeTaxable}', 'true'::jsonb),
                   '{minimumCents}', '2000'::jsonb
                 )::text,
                 version = settings.version + 1, updated_at = ?
           WHERE key = 'delivery'`,
        )
        .bind(now),
    ],
  },
  {
    // Populates `business.email`, which the dispatcher already sends the
    // new-order and low-rating alerts to and which had never been set — so those
    // alerts fell back to voice and SMS alone.
    //
    // Conditional on the key being absent: unlike the delivery change above,
    // this is not a correction the owner asked for, so an address they have
    // already entered must win. `-> 'email'` returns SQL NULL when the key is
    // missing, which is the test we want; `->> 'email'` would also match an
    // empty string, and treating "" as unset is a judgement this need not make.
    id: "2026-08-21-restaurant-alert-email",
    run: (database, now) => [
      database
        .prepare(
          `UPDATE settings
             SET value_json = jsonb_set(value_json::jsonb, '{email}', ?::jsonb)::text,
                 version = settings.version + 1, updated_at = ?
           WHERE key = 'business' AND (value_json::jsonb -> 'email') IS NULL`,
        )
        .bind(JSON.stringify(LAUNCH_SETTINGS.business.email), now),
    ],
  },
];

export async function runDataMigrations(database: D1Database): Promise<void> {
  const now = Date.now();
  for (const migration of DATA_MIGRATIONS) {
    const marker = `dataMigration:${migration.id}`;
    const already = await database
      .prepare("SELECT 1 AS present FROM settings WHERE key = ?")
      .bind(marker)
      .first<{ present: number }>();
    if (already) continue;
    const statements = await migration.run(database, now);
    statements.push(
      database
        .prepare("INSERT INTO settings (key, value_json, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT (key) DO NOTHING")
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
