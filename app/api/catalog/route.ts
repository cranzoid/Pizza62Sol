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

/**
 * What an anonymous visitor is allowed to read.
 *
 * `listSettings()` returns the whole settings table, and this endpoint is
 * unauthenticated — so every row in it was a public document. That included
 * `alerts.developerEmails`, the restaurant's own `business.email`, and the
 * `dataMigration:*` bookkeeping markers, none of which the storefront reads.
 * None of them is a credential, but an address that otherwise only appears
 * behind the admin login should not be readable by anyone who knows the URL.
 *
 * An allow-list rather than a deny-list, deliberately: a settings key added
 * later stays private until somebody decides it should not be, instead of
 * shipping to every visitor the moment it is seeded.
 */
const PUBLIC_SETTING_KEYS = [
  "business",
  "ordering",
  "delivery",
  "taxAndTips",
  "content",
  "hours",
  "featureFlags",
  "operations",
] as const;

/**
 * Two of those keys carry fields the storefront never reads.
 *
 * `business.email` is where new-order alerts are sent, not a contact address
 * for customers — the site shows the phone number. `operations` is mostly
 * back-office (payroll period, feedback delay, low-rating threshold); only the
 * halal notice and the half-topping rule are rendered to a customer.
 *
 * Keys absent from this map are published whole.
 */
const PUBLIC_SETTING_FIELDS: Record<string, readonly string[]> = {
  business: [
    "name",
    "phone",
    "locale",
    "currency",
    "timeZone",
    "address",
    "latitude",
    "longitude",
    "googleReviewUrl",
  ],
  operations: ["halalNotice", "halalSurchargeType", "halalSurchargeAmount", "halfToppingUnitsBps"],
};

function publicSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const published: Record<string, unknown> = {};
  for (const key of PUBLIC_SETTING_KEYS) {
    const record = settings[key] as { value: unknown } | undefined;
    if (!record) continue;
    const fields = PUBLIC_SETTING_FIELDS[key];
    // `hours` is an array, so only narrow the keys that are known objects.
    if (!fields || Array.isArray(record.value) || typeof record.value !== "object" || record.value === null) {
      published[key] = record;
      continue;
    }
    const source = record.value as Record<string, unknown>;
    published[key] = {
      ...record,
      value: Object.fromEntries(fields.filter((field) => field in source).map((field) => [field, source[field]])),
    };
  }
  return published;
}

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
      settings: publicSettings(settings),
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
