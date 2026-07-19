import { ensureDatabase, getD1, listSettings, safeJson } from "@/db/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureDatabase();
  const database = getD1();
  const [categoryResult, productResult, variationResult, toppingResult, settings] =
    await Promise.all([
      database
        .prepare(
          "SELECT id, name, slug, description, display_order FROM categories WHERE active = 1 ORDER BY display_order, name",
        )
        .all(),
      database
        .prepare(
          `SELECT id, category_id, name, slug, description, product_type, image_url,
                  base_price_cents, taxable, pickup_eligible, delivery_eligible, halal_capable,
                  promotion_eligible, active, sold_out, setup_required, configuration_json, display_order
           FROM products WHERE active = 1 ORDER BY display_order, name`,
        )
        .all<Record<string, unknown>>(),
      database
        .prepare(
          `SELECT id, product_id, name, base_price_cents, extra_topping_price_cents,
                  included_topping_units_bps, active, display_order
           FROM product_variations WHERE active = 1 ORDER BY display_order, name`,
        )
        .all(),
      database
        .prepare(
          `SELECT id, name, kitchen_label, is_meat, has_halal_version,
                  halal_display_name, halal_available, halal_cost_cents, display_order
           FROM toppings WHERE active = 1 ORDER BY display_order, name`,
        )
        .all(),
      listSettings(),
    ]);
  return Response.json(
    {
      categories: categoryResult.results,
      products: productResult.results.map((product) => ({
        ...product,
        configuration: safeJson(product.configuration_json as string, {}),
        configuration_json: undefined,
      })),
      variations: variationResult.results,
      toppings: toppingResult.results,
      settings,
    },
    {
      headers: {
        "cache-control": "public, max-age=30, stale-while-revalidate=120",
      },
    },
  );
}
