import { env } from "@/lib/runtime-env";
import { LAUNCH_SETTINGS, REGULAR_HOURS } from "@/lib/launch-config";
import {
  FEEDBACK_REWARD_PRODUCT_IDS,
  GAME_DAY_SPECIAL_PRODUCT_ID,
  MENU_CATEGORIES,
  MENU_PRODUCTS,
  MENU_SEED_VERSION,
  PICKUP_SPECIALS_RELEASE_PRODUCT_IDS,
  PIZZA_BY_SIZE_PRODUCT_IDS,
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
    rewards: LAUNCH_SETTINGS.rewards,
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
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 0, 0, ?, ?, ?, ?, ?)
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
            product.taxable === false ? 0 : 1,
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
  /**
   * The offer behind the feedback thank-you code.
   *
   * A coded promotion, so it never applies on its own — `activePromotions` only
   * considers it when the customer types the code (C-02). Seeded here rather
   * than left for the owner to create because the mail refuses to send without
   * it, and "the thank-you email silently stopped going out" is a failure nobody
   * would notice for a month.
   *
   * Worth C$3.99 — a garlic bread — on a C$15 order, and spendable only on the
   * garlic breads and drinks in `FEEDBACK_REWARD_PRODUCT_IDS`. The targeting is
   * the point of the offer, not a detail of it: without it the same C$3.99 comes
   * off a pizza order, which is a promotion nobody agreed to run. Both numbers,
   * the code, the targeting, the name and whether it is active at all are
   * owner-editable in Admin → History & offers from the moment it exists; this
   * insert only decides where it starts.
   * `ON CONFLICT DO NOTHING` without a target so it yields to an existing row on
   * either the id or the unique code.
   */
  operations.push(
    database
      .prepare(
        `INSERT INTO promotions
         (id, name, code, type, amount, priority, combinable, exclusive, active,
          min_subtotal_cents, fulfilment, per_customer_limit, rule_json, display_order,
          created_at, updated_at)
         VALUES ('feedback-thank-you', 'Feedback thank-you', ?, 'fixed', 399, 0, 1, 0, 1,
                 1500, 'any', 1, ?, 90, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .bind(
        LAUNCH_SETTINGS.rewards.feedbackRewardCode,
        JSON.stringify({ productIds: [...FEEDBACK_REWARD_PRODUCT_IDS] }),
        now,
        now,
      ),
  );
  /**
   * What the customer is actually asked.
   *
   * Seeded on every boot rather than behind the menu-seed gate, and inserted
   * with ON CONFLICT DO NOTHING — so a question added here appears on databases
   * that were seeded long ago, and one the owner has since reworded or switched
   * off is never overwritten.
   *
   * **The pizza questions are specific on purpose.** "Pizza quality: 3/5" tells
   * the kitchen nothing it can act on. Crust, sauce and toppings are three
   * separate people doing three separate things, and a week of answers points at
   * whichever one has slipped. That is the whole reason for asking.
   *
   * `requiresTrait` beats the old `includesProductType`: a deal is a `bundle`
   * whose product type says nothing about the pizza inside it, so matching on
   * product type asked a customer who ordered two large pizzas in a deal
   * nothing about their pizza — and the wings question, keyed to a product type
   * named "wings" that has never existed, was never shown to anyone at all.
   */
  const feedback = [
    ["overall", "Overall experience", "rating", 5, 1, {}, 10],
    ["crust", "How was the crust?", "rating", 5, 0, { requiresTrait: "pizza" }, 20],
    ["sauce", "How was the sauce?", "rating", 5, 0, { requiresTrait: "pizza" }, 30],
    ["toppings", "How were the toppings?", "rating", 5, 0, { requiresTrait: "pizza" }, 40],
    ["wings", "How were the wings?", "rating", 5, 0, { requiresTrait: "wings" }, 50],
    ["speed", "Pickup or delivery speed", "rating", 5, 0, { wordingByFulfilment: true }, 60],
    ["comments", "Anything else we should know?", "text", null, 0, {}, 70],
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
    // "Flyer price" was our word for it, not the customer's.
    //
    // The seeded description for every build-your-own size said "the
    // flyer-priced 1-topping or 3-topping pizza". A flyer is an internal
    // reference — how the launch prices were sourced — and on a menu page it
    // reads as jargon or, worse, as a promotion the customer cannot find. The
    // seed text is fixed in `lib/menu.ts`, but products are inserted with ON
    // CONFLICT DO NOTHING so an already-seeded database keeps the old string
    // forever without this.
    //
    // Scoped by the exact phrase rather than by product id: a description the
    // owner has since rewritten no longer contains it and is left alone, which
    // is the C-08 rule — the menu belongs to the owner after first seed.
    id: "2026-08-23-drop-flyer-wording",
    run: (database, now) => [
      database
        .prepare(
          `UPDATE products
             SET description = REPLACE(description, 'Choose the flyer-priced ', 'Choose a '),
                 updated_at = ?
           WHERE description LIKE 'Choose the flyer-priced %'`,
        )
        .bind(now),
    ],
  },
  {
    /**
     * Ask about the meal after the meal.
     *
     * `feedbackDelayMinutes` shipped at 75, which put the request more than an
     * hour after a pickup order was handed over — long enough that the customer
     * has moved on and the response rate goes with it. Forty minutes is after
     * the food has been eaten and while it is still the thing they were just
     * doing.
     *
     * Conditional on the value still being the shipped default: an owner who has
     * already tuned this has an opinion, and a migration must not overwrite it.
     */
    id: "2026-08-23-feedback-delay-40",
    run: (database, now) => [
      database
        .prepare(
          `UPDATE settings
             SET value_json = jsonb_set(value_json::jsonb, '{feedbackDelayMinutes}', '40'::jsonb)::text,
                 version = settings.version + 1, updated_at = ?
           WHERE key = 'operations' AND (value_json::jsonb ->> 'feedbackDelayMinutes') = '75'`,
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
  {
    /**
     * Ask about the crust and the sauce, not about "pizza quality".
     *
     * The new questions arrive on their own — feedback questions are seeded on
     * every boot with ON CONFLICT DO NOTHING — but three things about the rows
     * already in the table have to be corrected here, because that insert by
     * design never touches a row that exists.
     *
     * 1. `pizza-quality` is retired. It is the vague version of the three
     *    questions that replace it, and a form with four pizza ratings on it is
     *    a form people close. Retired, not deleted: past answers stay readable.
     * 2. The wings question has never once been shown. Its condition asks for a
     *    product *type* called "wings", and the four product types are pizza,
     *    simple, bundle and configurable — so it matched nothing, ever.
     * 3. Speed and the comment box move to the end, behind the new questions.
     *
     * Every statement is conditional on the row still holding its seeded value.
     * An owner who has reworded or reordered a question has an opinion, and a
     * migration must not overwrite it (C-08).
     */
    id: "2026-08-24-feedback-crust-and-sauce",
    run: (database, now) => [
      database
        .prepare(
          `UPDATE feedback_questions SET active = 0, updated_at = ?
           WHERE id = 'pizza-quality' AND label = 'Pizza quality'`,
        )
        .bind(now),
      database
        .prepare(
          `UPDATE feedback_questions
             SET condition_json = '{"requiresTrait":"wings"}',
                 label = 'How were the wings?', display_order = 50, updated_at = ?
           WHERE id = 'wings' AND label = 'Wings'
             AND condition_json::jsonb = '{"includesProductType":"wings"}'::jsonb`,
        )
        .bind(now),
      database
        .prepare(
          `UPDATE feedback_questions SET display_order = 60, updated_at = ?
           WHERE id = 'speed' AND display_order = 40`,
        )
        .bind(now),
      database
        .prepare(
          `UPDATE feedback_questions SET display_order = 70, updated_at = ?
           WHERE id = 'comments' AND display_order = 50`,
        )
        .bind(now),
    ],
  },
  {
    // The ten size/item pickup pizzas existed in an early database seed and were
    // later retired because their prices had not been confirmed. The owner has
    // now supplied the exact products and prices. An insert-only seed cannot
    // reactivate those old rows, so this one-time migration deliberately restores
    // this release's products while leaving every unrelated owner edit alone.
    id: "2026-08-27-confirm-pickup-specials",
    run: (database, now) => {
      const releaseIds = new Set<string>(PICKUP_SPECIALS_RELEASE_PRODUCT_IDS);
      const statements: D1PreparedStatement[] = [];
      for (const [displayOrder, product] of MENU_PRODUCTS.entries()) {
        if (!releaseIds.has(product.id)) continue;
        statements.push(
          database
            .prepare(
              `UPDATE products
               SET category_id = ?, name = ?, slug = ?, description = ?, product_type = ?,
                   base_price_cents = ?, taxable = ?, pickup_eligible = ?, delivery_eligible = ?,
                   halal_capable = ?, promotion_eligible = 1, active = 1, sold_out = 0,
                   setup_required = 0, kitchen_label = ?, configuration_json = ?,
                   display_order = ?, updated_at = ?
               WHERE id = ?`,
            )
            .bind(
              product.categoryId,
              product.name,
              product.id,
              product.description,
              product.productType,
              product.basePriceCents,
              product.taxable === false ? 0 : 1,
              product.pickupEligible === false ? 0 : 1,
              product.deliveryEligible === false ? 0 : 1,
              product.halalCapable ? 1 : 0,
              product.name.toUpperCase().slice(0, 40),
              JSON.stringify(product.configuration ?? {}),
              displayOrder,
              now,
              product.id,
            ),
        );
        if (product.productType !== "pizza") continue;
        statements.push(
          database
            .prepare("UPDATE product_variations SET active = 0, updated_at = ? WHERE product_id = ?")
            .bind(now, product.id),
        );
        for (const [variationOrder, variation] of (product.variations ?? []).entries()) {
          statements.push(
            database
              .prepare(
                `INSERT INTO product_variations
                 (id, product_id, name, base_price_cents, extra_topping_price_cents,
                  included_topping_units_bps, active, display_order, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET product_id = excluded.product_id,
                   name = excluded.name, base_price_cents = excluded.base_price_cents,
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
                variationOrder,
                now,
                now,
              ),
          );
        }
      }
      return statements;
    },
  },
  {
    // Pizza by Size became the delivery pizza list: one price per size, any one
    // to four toppings for that price, and no longer sold on pickup. Pickup
    // single pizzas are the Pickup Specials, which start below every price here,
    // so leaving these on a pickup order undercut the special and listed the
    // same pizza twice.
    //
    // The seed is insert-only and these rows already exist, so the price, the
    // topping allowance and the fulfilment all have to be written here. The two
    // old options (1 Topping, 3 Toppings) are deactivated rather than deleted:
    // orders already placed against them still have to render.
    //
    // Only the fields this release actually changes are written. The product's
    // name, image, display order, sold-out flag and every other owner-owned
    // column are left exactly as the owner has them — a repricing has no
    // business resetting a photograph or a name the owner rewrote.
    id: "2026-08-28-delivery-pizza-by-size",
    run: (database, now) => {
      const statements: D1PreparedStatement[] = [];
      for (const productId of PIZZA_BY_SIZE_PRODUCT_IDS) {
        const product = MENU_PRODUCTS.find((entry) => entry.id === productId);
        if (!product) continue;
        statements.push(
          database
            .prepare(
              `UPDATE products
               SET description = ?, base_price_cents = ?,
                   pickup_eligible = ?, delivery_eligible = ?, configuration_json = ?,
                   updated_at = ?
               WHERE id = ?`,
            )
            .bind(
              product.description,
              product.basePriceCents,
              product.pickupEligible === false ? 0 : 1,
              product.deliveryEligible === false ? 0 : 1,
              JSON.stringify(product.configuration ?? {}),
              now,
              product.id,
            ),
        );
        statements.push(
          database
            .prepare("UPDATE product_variations SET active = 0, updated_at = ? WHERE product_id = ?")
            .bind(now, product.id),
        );
        for (const [variationOrder, variation] of (product.variations ?? []).entries()) {
          statements.push(
            database
              .prepare(
                `INSERT INTO product_variations
                 (id, product_id, name, base_price_cents, extra_topping_price_cents,
                  included_topping_units_bps, active, display_order, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET product_id = excluded.product_id,
                   name = excluded.name, base_price_cents = excluded.base_price_cents,
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
                variationOrder,
                now,
                now,
              ),
          );
        }
      }
      return statements;
    },
  },
  {
    /**
     * THANKS62 is a garlic bread or a drink, not C$3.99 off anything.
     *
     * The row was seeded with an empty `rule_json`, so on every database created
     * before this release the feedback code comes off whatever is in the cart —
     * a large pizza included. The offer the customer was emailed has always been
     * "a free garlic bread or four pops"; this makes the promotion honour the
     * sentence it was described by.
     *
     * Conditional on the targeting still being empty. An owner who has since
     * pointed the offer at products of their own has made a decision, and a
     * migration that overwrote it would be a second person editing their
     * promotion behind their back (C-08).
     */
    id: "2026-08-28-thanks62-garlic-bread-and-pop",
    run: (database, now) => [
      database
        .prepare(
          `UPDATE promotions SET rule_json = ?, updated_at = ?
           WHERE id = 'feedback-thank-you'
             AND (rule_json IS NULL OR rule_json = '' OR rule_json::jsonb = '{}'::jsonb)`,
        )
        .bind(JSON.stringify({ productIds: [...FEEDBACK_REWARD_PRODUCT_IDS] }), now),
    ],
  },
  {
    /**
     * The 2 L pop comes in Coke and Pepsi, not in all fifteen canned flavours.
     *
     * The Game Day Special shipped with its bottle pointed at the canned-pop
     * list, which offered thirteen bottles the fridge does not hold. The seed is
     * insert-only and the product row already exists, so the corrected `source`
     * has to be written here or the live offer keeps the wrong list.
     *
     * Surgical on purpose: it rewrites the `source` of the one section whose id
     * is `two-litre-pop` and whose source is still the seeded `drinks`, and
     * leaves every other key of the configuration — and every other product —
     * exactly as it is. An owner who has already repointed it has made a
     * decision, and this must not be a second person editing behind them (C-08).
     */
    id: "2026-08-29-two-litre-pop-source",
    run: async (database, now) => {
      const row = await database
        .prepare("SELECT configuration_json FROM products WHERE id = ?")
        .bind(GAME_DAY_SPECIAL_PRODUCT_ID)
        .first<{ configuration_json: string | null }>();
      if (!row) return [];
      const configuration = safeJson<Record<string, unknown>>(row.configuration_json ?? "{}", {});
      const sections = Array.isArray(configuration.sections)
        ? (configuration.sections as ModifierSectionSeed[])
        : [];
      if (!sections.some((section) => section.id === "two-litre-pop" && section.source === "drinks")) {
        return [];
      }
      const next = {
        ...configuration,
        sections: sections.map((section) =>
          section.id === "two-litre-pop" && section.source === "drinks"
            ? { ...section, source: "two_litre_drinks" as const }
            : section,
        ),
      };
      return [
        database
          .prepare("UPDATE products SET configuration_json = ?, updated_at = ? WHERE id = ?")
          .bind(JSON.stringify(next), now, GAME_DAY_SPECIAL_PRODUCT_ID),
      ];
    },
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
