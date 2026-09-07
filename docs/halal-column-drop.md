# Follow-up: dropping the halal columns

Halal was withdrawn from the menu. All application code was removed in the
"Withdraw halal from the order flow" change; **this document is the second half**,
deliberately not merged at the same time.

## Why this is a separate deploy

The previous revision still runs `SELECT ... halal_capable ...` against `products`
and `toppings`. If the columns are dropped in the same deploy as the code that
stopped reading them, a rollback to that revision starts throwing on every catalog
read the moment the slot swaps back. Expand first, contract later: ship the code,
let it prove itself, then drop the columns once you would no longer roll back
past them.

`DROP COLUMN` is irreversible. `toppings.halal_available` is owner-configured
supplier data and cannot be reconstructed from anything else in the schema.

## Preconditions

1. The halal-removal revision has been live and stable — a week is a reasonable bar.
2. A verified Postgres backup exists (not just "a backup job is configured").
3. You accept that per-topping halal supplier data is gone for good.

## Step 1 — retire the stored option groups

Deals seeded before the withdrawal still carry a `source: "halal"` section in
`configuration_json`. The running code discards these on read
(`RETIRED_SECTION_SOURCES` in `lib/domain.ts`), so removing them is tidying, not a
fix. Append to `DATA_MIGRATIONS` in `db/runtime.ts`:

```ts
{
  // Halal was withdrawn from the menu. The sections have been ignored on read
  // since the withdrawal; this deletes them from the stored configuration so the
  // admin option editor stops listing a group nobody can order.
  id: "2026-09-XX-drop-halal-sections",
  run: async (database, now) => {
    const stored = await database
      .prepare("SELECT id, configuration_json FROM products")
      .all<{ id: string; configuration_json: string | null }>();
    const statements: D1PreparedStatement[] = [];
    for (const row of stored.results) {
      const configuration = safeJson<Record<string, unknown>>(row.configuration_json ?? "{}", {});
      const sections = Array.isArray(configuration.sections)
        ? (configuration.sections as ModifierSectionSeed[])
        : [];
      if (!sections.some((section) => section.source === "halal")) continue;
      const next = { ...configuration, sections: sections.filter((section) => section.source !== "halal") };
      statements.push(
        database
          .prepare("UPDATE products SET configuration_json = ?, updated_at = ? WHERE id = ?")
          .bind(JSON.stringify(next), now, row.id),
      );
    }
    return statements;
  },
},
```

Leave `RETIRED_SECTION_SOURCES` and the code that honours it in place for this
deploy — saved carts in `localStorage` have no expiry, and a browser can still be
holding a basket that names one of these sections. Remove that machinery only in a
later change, if ever; it costs one filter.

## Step 2 — drop the columns

New file, `drizzle/0006_drop_halal_columns.sql`:

```sql
ALTER TABLE "products" DROP CONSTRAINT "products_flags";--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_flags" CHECK (taxable IN (0, 1) AND pickup_eligible IN (0, 1) AND delivery_eligible IN (0, 1)
          AND promotion_eligible IN (0, 1) AND active IN (0, 1)
          AND sold_out IN (0, 1) AND setup_required IN (0, 1));--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "halal_capable";--> statement-breakpoint
ALTER TABLE "toppings" DROP CONSTRAINT "toppings_flags";--> statement-breakpoint
ALTER TABLE "toppings" DROP CONSTRAINT "toppings_cost_nonneg";--> statement-breakpoint
ALTER TABLE "toppings" ADD CONSTRAINT "toppings_flags" CHECK (is_meat IN (0, 1) AND active IN (0, 1));--> statement-breakpoint
ALTER TABLE "toppings" DROP COLUMN "has_halal_version";--> statement-breakpoint
ALTER TABLE "toppings" DROP COLUMN "halal_display_name";--> statement-breakpoint
ALTER TABLE "toppings" DROP COLUMN "halal_available";--> statement-breakpoint
ALTER TABLE "toppings" DROP COLUMN "halal_cost_cents";
```

Constraints are rebuilt rather than left alone because both `products_flags` and
`toppings_flags` name the dropped columns and Postgres will not let a column go
while a check depends on it.

Then remove the matching fields and checks from `db/schema.ts` (`halalCapable`,
`hasHalalVersion`, `halalDisplayName`, `halalAvailable`, `halalCostCents`,
`toppings_cost_nonneg`) so drizzle-kit and the database agree.

## What must NOT be removed, ever

`snapshotFlags()` in `lib/order-presentation.ts` still reads `snapshot.halal`.
Every order placed before the withdrawal has that flag frozen in its stored
snapshot, and that function feeds the kitchen ticket, the thermal print, the
confirmation email and the customer's order page. Deleting the branch would
reprint historical orders as something they were not.

The settings rows (`operations.halalNotice`, `halalSurchargeType`,
`halalSurchargeAmount`, `featureFlags.halalPreparationClaim`) are owner-owned
JSON. Nothing reads them. They are harmless and can be left alone.
