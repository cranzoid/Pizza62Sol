import type { Pool, PoolClient } from "pg";
import { MENU_PRODUCTS, PIZZA_BY_SIZE_PRODUCT_IDS } from "@/lib/menu";

export const ORDERING_RELEASE_ID = "2026-10-13-staff-ordering";
const MARKER = `dataMigration:${ORDERING_RELEASE_ID}`;
type Row = Record<string, unknown>;
type Table = "settings" | "categories" | "products" | "product_variations";
type Change = { table: Table; key: string; before: Row | null; after: Row };
export type OrderingReleaseSnapshot = { release: string; capturedAt: number; changes: Change[]; observed: { products: Row[]; variations: Row[]; category: Row | null; operations: Row | null } };
const identity = (table: Table) => table === "settings" ? "key" : "id";
const equivalent = (a: unknown, b: unknown): boolean => {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sorted(entry)])) : value;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};

/** Read-only preview. Captures complete affected records before proposing field-limited changes. */
export async function inspectOrderingRelease(client: PoolClient, capturedAt = Date.now()): Promise<OrderingReleaseSnapshot> {
  const now = capturedAt;
  const read = async (table: Table, key: string) => (await client.query(`SELECT * FROM ${table} WHERE ${identity(table)} = $1`, [key])).rows[0] as Row | undefined;
  const operations = await read("settings", "operations") ?? null;
  const category = await read("categories", "build-your-own") ?? null;
  const products = (await client.query("SELECT * FROM products WHERE id = ANY($1::text[]) ORDER BY id", [PIZZA_BY_SIZE_PRODUCT_IDS])).rows;
  const variations = (await client.query("SELECT * FROM product_variations WHERE product_id = ANY($1::text[]) ORDER BY id", [PIZZA_BY_SIZE_PRODUCT_IDS])).rows;
  const changes: Change[] = [];
  const propose = (table: Table, key: string, before: Row | null, fields: Row) => {
    if (!before || Object.entries(fields).some(([field, value]) => !equivalent(before[field], value))) {
      changes.push({ table, key, before, after: fields });
    }
  };
  if (!operations) throw new Error("Missing operations settings; initialize the database before inspecting this release.");
  const values = JSON.parse(String(operations.value_json));
  propose("settings", "operations", operations, { value_json: JSON.stringify({ ...values, halfToppingUnitsBps: 5000 }), version: Number(operations.version) + 1, updated_at: now });
  if (category) propose("categories", "build-your-own", category, { name: "Delivery pizzas", active: 1, updated_at: now });
  else propose("categories", "build-your-own", null, { id: "build-your-own", name: "Delivery pizzas", slug: "pizza-by-size", active: 1, display_order: 10, created_at: now, updated_at: now });
  for (const id of PIZZA_BY_SIZE_PRODUCT_IDS) {
    const seed = MENU_PRODUCTS.find((product) => product.id === id)!;
    const previous = products.find((product) => product.id === id) ?? null;
    const configuration = previous ? JSON.parse(String(previous.configuration_json)) : seed.configuration ?? {};
    // Remove only the public-visibility flag. Keep the owner's crust, sauce, extras and notes configuration.
    delete configuration.staffOnly;
    propose("products", id, previous, {
      ...(previous ? {} : { id, name: seed.name, slug: id, description: seed.description, product_type: seed.productType, taxable: 1, promotion_eligible: 1, sold_out: 0, kitchen_label: seed.name.toUpperCase().slice(0, 40), display_order: PIZZA_BY_SIZE_PRODUCT_IDS.indexOf(id), created_at: now }),
      category_id: "build-your-own", base_price_cents: seed.basePriceCents, pickup_eligible: 0, delivery_eligible: 1,
      active: 1, setup_required: 0, configuration_json: JSON.stringify(configuration), updated_at: now,
    });
    const variation = seed.variations![0];
    const oldVariation = variations.find((entry) => entry.id === variation.id) ?? null;
    if (oldVariation && oldVariation.product_id !== id) throw new Error(`Variation ${variation.id} belongs to another product.`);
    const otherActive = variations.filter((entry) => entry.product_id === id && entry.id !== variation.id && entry.active === 1);
    if (otherActive.length) throw new Error(`Inspect active owner variations for ${id} before release: ${otherActive.map((entry) => entry.id).join(", ")}. No variations were overwritten.`);
    propose("product_variations", variation.id, oldVariation, {
      ...(oldVariation ? {} : { id: variation.id, product_id: id, name: variation.name, display_order: 0, created_at: now }),
      base_price_cents: variation.basePriceCents, extra_topping_price_cents: variation.extraToppingPriceCents,
      included_topping_units_bps: variation.includedToppingUnitsBps, active: 1, updated_at: now,
    });
  }
  return { release: ORDERING_RELEASE_ID, capturedAt: now, changes, observed: { products, variations, category, operations } };
}

/** Explicit apply/rollback, atomic and repeat-safe. Refuses concurrent owner changes. */
export async function applyOrderingRelease(pool: Pool, snapshot: OrderingReleaseSnapshot, rollback = false): Promise<string> {
  if (snapshot.release !== ORDERING_RELEASE_ID) throw new Error("Wrong release snapshot.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(6211962)");
    const marker = (await client.query("SELECT value_json FROM settings WHERE key = $1 FOR UPDATE", [MARKER])).rows[0];
    if (!rollback && marker) { await client.query("COMMIT"); return "already applied"; }
    if (rollback && !marker) { await client.query("COMMIT"); return "already rolled back or not applied"; }
    if (rollback && !equivalent(JSON.parse(marker.value_json).snapshot, snapshot)) throw new Error("Rollback snapshot does not match the applied release.");
    if (!rollback) {
      const fresh = await inspectOrderingRelease(client, snapshot.capturedAt);
      if (!equivalent(fresh, snapshot)) throw new Error("Menu or settings changed since inspection. Capture a fresh preview; owner edits were preserved.");
    }
    for (const change of rollback ? [...snapshot.changes].reverse() : snapshot.changes) {
      const column = identity(change.table);
      const current = (await client.query(`SELECT * FROM ${change.table} WHERE ${column} = $1 FOR UPDATE`, [change.key])).rows[0] ?? null;
      const expected = rollback ? change.before ? { ...change.before, ...change.after } : change.after : change.before;
      // Created rows have database defaults not present in the insert. Compare the exact inserted fields.
      const matches = rollback && !change.before && current ? Object.entries(change.after).every(([key, value]) => equivalent(current[key], value)) : equivalent(current, expected);
      if (!matches) throw new Error(`${change.table}:${change.key} changed since inspection. Capture a fresh preview; owner edits were preserved.`);
      if (rollback && !change.before) {
        await client.query(`DELETE FROM ${change.table} WHERE ${column} = $1`, [change.key]);
      } else if (!rollback && !change.before) {
        const fields = Object.keys(change.after);
        await client.query(`INSERT INTO ${change.table} (${fields.join(", ")}) VALUES (${fields.map((_, index) => `$${index + 1}`).join(", ")})`, fields.map((field) => change.after[field]));
      } else {
        const fields = Object.keys(change.after).filter((field) => field !== column);
        const values = fields.map((field) => rollback ? change.before![field] : change.after[field]);
        await client.query(`UPDATE ${change.table} SET ${fields.map((field, index) => `${field} = $${index + 1}`).join(", ")} WHERE ${column} = $${fields.length + 1}`, [...values, change.key]);
      }
    }
    if (rollback) await client.query("DELETE FROM settings WHERE key = $1", [MARKER]);
    else await client.query("INSERT INTO settings (key, value_json, version, updated_at) VALUES ($1, $2, 1, $3)", [MARKER, JSON.stringify({ snapshot, appliedAt: Date.now() }), Date.now()]);
    await client.query("COMMIT");
    return rollback ? "rolled back" : "applied";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
