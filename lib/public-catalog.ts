import { ensureDatabase, getD1, listSettings, safeJson } from "@/db/runtime";
import {
  cloverApiBase,
  cloverCheckoutConfigured,
  cloverIframeEnabled,
  cloverMerchantId,
  cloverPublicToken,
} from "@/lib/clover";
import { loadActiveClosures } from "@/lib/closures";
import { readIntegrationSecret } from "@/lib/integration-secrets";
import type { PublicCatalog } from "@/lib/catalog-types";
import { publicGiveaway } from "@/lib/giveaway";
import { loadGiveaway } from "@/lib/giveaway-store";

/** Settings an anonymous storefront visitor is allowed to read. */
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

/** Fields within otherwise-public settings that are actually used in public. */
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
  operations: ["halfToppingUnitsBps"],
};

export function publicSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const published: Record<string, unknown> = {};
  for (const key of PUBLIC_SETTING_KEYS) {
    const record = settings[key] as { value: unknown } | undefined;
    if (!record) continue;
    const fields = PUBLIC_SETTING_FIELDS[key];
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

/**
 * One source for the public catalogue used by both the API and the initial HTML.
 * Keeping these together prevents crawlers from seeing a different menu from
 * customers after hydration.
 */
export async function loadPublicCatalog(): Promise<PublicCatalog> {
  await ensureDatabase();
  const database = getD1();
  const [categoryResult, productResult, variationResult, toppingResult, settings] = await Promise.all([
    database
      .prepare("SELECT id, name, slug, description, display_order FROM categories WHERE active = 1 ORDER BY display_order, name")
      .all(),
    database
      .prepare(
        `SELECT id, category_id, name, slug, description, product_type, image_url,
                base_price_cents, taxable, pickup_eligible, delivery_eligible,
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
        `SELECT id, name, kitchen_label, is_meat, display_order
         FROM toppings WHERE active = 1 ORDER BY display_order, name`,
      )
      .all(),
    listSettings(),
  ]);

  const products = productResult.results.map((product) => ({
    ...(product as { id: string; category_id: string }), configuration: safeJson<Record<string, unknown>>(product.configuration_json as string, {}), configuration_json: undefined,
  })).filter((product) => !product.configuration.staffOnly);
  const publicIds = new Set(products.map((product) => product["id"]));
  return {
    categories: categoryResult.results.filter((category) => products.some((product) => product["category_id"] === category.id)),
    products,
    variations: variationResult.results.filter((variation) => publicIds.has(String(variation.product_id))),
    toppings: toppingResult.results,
    settings: publicSettings(settings),
    closures: await loadActiveClosures(),
    // Only while it is running, and only what a visitor may know. A failure to
    // read it must never take the menu down with it.
    giveaway: publicGiveaway(await loadGiveaway().catch(() => null), Date.now()),
    integrations: {
      clover: await cloverCheckoutConfigured(),
      cloverIframe: (await cloverIframeEnabled())
        ? {
            enabled: true,
            publicToken: await cloverPublicToken(),
            merchantId: await cloverMerchantId(),
            sandbox: (await cloverApiBase()).includes("sandbox"),
          }
        : { enabled: false },
      email: (await readIntegrationSecret("EMAIL_API_KEY")) !== null,
    },
  } as unknown as PublicCatalog;
}
