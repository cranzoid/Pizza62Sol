import { ensureDatabase, getD1, listSettings, safeJson } from "@/db/runtime";
import {
  cloverApiBase,
  cloverCheckoutConfigured,
  cloverIframeEnabled,
  cloverMerchantId,
  cloverPublicToken,
} from "@/lib/clover";
import { readIntegrationSecret } from "@/lib/integration-secrets";
import { loadActiveClosures } from "@/lib/closures";

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
      // H-08: sent to the browser so the store banner can say *why* it is shut
      // and when it reopens, rather than falling back to the weekly schedule and
      // telling a customer the store opens at 11 on a day it is closed all day.
      closures: await loadActiveClosures(),
      // These gate what the customer is offered — an un-awaited Promise here
      // serialises to `{}`, which is truthy in the browser, so online payment
      // would look available with no credentials behind it.
      integrations: {
        clover: await cloverCheckoutConfigured(),
        // The browser half of the Clover key, plus whether inline card entry is
        // the active path. Sent to every visitor by design: the token identifies
        // the merchant to Clover's SDK and cannot move money on its own.
        // `enabled` is false until both halves are configured *and* the flag is
        // set, so a half-configured account keeps the hosted checkout.
        cloverIframe: (await cloverIframeEnabled())
          ? {
              enabled: true,
              publicToken: await cloverPublicToken(),
              merchantId: await cloverMerchantId(),
              // Selects which of Clover's two SDK hosts the browser loads.
              sandbox: (await cloverApiBase()).includes("sandbox"),
            }
          : { enabled: false },
        email: (await readIntegrationSecret("EMAIL_API_KEY")) !== null,
      },
    },
    {
      headers: {
        "cache-control": "public, max-age=30, stale-while-revalidate=120",
      },
    },
  );
}
