import { isWithinWeeklyAvailability, type WeeklyAvailability } from "@/lib/domain";

type SeoCategory = { id?: unknown; name?: unknown };
type SeoProduct = {
  id?: unknown;
  category_id?: unknown;
  name?: unknown;
  description?: unknown;
  image_url?: unknown;
  base_price_cents?: unknown;
  sold_out?: unknown;
  setup_required?: unknown;
  configuration?: unknown;
};

type SeoCatalog = {
  categories?: SeoCategory[];
  products?: SeoProduct[];
  settings?: Record<string, { value?: unknown }>;
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function publicOrigin(value?: string): string {
  try {
    const url = new URL(value || "https://pizza62.ca");
    return url.protocol === "https:" || url.hostname === "localhost" ? url.origin : "https://pizza62.ca";
  } catch {
    return "https://pizza62.ca";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanUrl(value: unknown): string | undefined {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function cleanAssetUrl(value: unknown, origin: string): string | undefined {
  try {
    const raw = String(value ?? "").trim();
    if (!raw) return undefined;
    const url = new URL(raw, origin);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function postalAddress(value: unknown) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(.*?),\s*([^,]+),\s*([A-Z]{2})\s+([A-Z]\d[A-Z]\s?\d[A-Z]\d)$/i);
  if (!match) return { "@type": "PostalAddress", streetAddress: text, addressCountry: "CA" };
  return {
    "@type": "PostalAddress",
    streetAddress: match[1],
    addressLocality: match[2],
    addressRegion: match[3].toUpperCase(),
    postalCode: match[4].toUpperCase(),
    addressCountry: "CA",
  };
}

function timeFromMinute(value: unknown): string | undefined {
  const minute = Number(value);
  if (!Number.isInteger(minute) || minute < 0 || minute > 1440) return undefined;
  const normalized = minute === 1440 ? 0 : minute;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

/** Builds only claims already visible in the live catalogue and business settings. */
export function restaurantStructuredData(catalog: SeoCatalog, configuredOrigin?: string) {
  const origin = publicOrigin(configuredOrigin);
  const settings = catalog.settings ?? {};
  const business = record(settings.business?.value);
  const content = record(settings.content?.value);
  const hours = Array.isArray(settings.hours?.value) ? settings.hours.value : [];
  const name = String(business.name ?? "Pizza 62");
  const phone = String(business.phone ?? "+19055475777");
  const restaurantId = `${origin}/#restaurant`;
  const menuId = `${origin}/#menu`;
  const categories = Array.isArray(catalog.categories) ? catalog.categories : [];
  const products = Array.isArray(catalog.products) ? catalog.products : [];
  const menuSections = categories.map((category) => {
    const categoryId = String(category.id ?? "");
    const items = products
      .filter((product) => String(product.category_id ?? "") === categoryId && !product.setup_required)
      .map((product) => {
        const image = cleanAssetUrl(product.image_url, origin);
        const availability = record(product.configuration).availability as WeeklyAvailability | undefined;
        const availableNow = isWithinWeeklyAvailability(availability);
        return {
          "@type": "MenuItem",
          identifier: String(product.id ?? ""),
          name: String(product.name ?? ""),
          description: String(product.description ?? ""),
          ...(image ? { image } : {}),
          offers: {
            "@type": "Offer",
            price: (Math.max(0, Number(product.base_price_cents) || 0) / 100).toFixed(2),
            priceCurrency: String(business.currency ?? "CAD"),
            availability: product.sold_out || !availableNow ? "https://schema.org/SoldOut" : "https://schema.org/InStock",
            url: `${origin}/#menu`,
          },
        };
      });
    return items.length ? { "@type": "MenuSection", name: String(category.name ?? "Menu"), hasMenuItem: items } : null;
  }).filter(Boolean);
  const openingHoursSpecification = hours.flatMap((entry) => {
    const row = record(entry);
    const day = DAYS[Number(row.weekday)];
    const opens = timeFromMinute(row.openMinute);
    const closes = timeFromMinute(row.closeMinute);
    return day && opens && closes
      ? [{ "@type": "OpeningHoursSpecification", dayOfWeek: day, opens, closes }]
      : [];
  });
  const sameAs = [cleanUrl(content.socialFacebook), cleanUrl(content.socialInstagram)].filter(Boolean);
  const latitude = Number(business.latitude);
  const longitude = Number(business.longitude);

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        url: `${origin}/`,
        name,
        inLanguage: String(business.locale ?? "en-CA"),
        publisher: { "@id": restaurantId },
      },
      {
        "@type": "Restaurant",
        "@id": restaurantId,
        url: `${origin}/`,
        name,
        description: String(content.seoDescription ?? "Order fresh pizza, wings and local deals for pickup or delivery in Hamilton, Ontario."),
        image: `${origin}/og.png`,
        logo: `${origin}/logo.png`,
        telephone: phone,
        priceRange: "$",
        servesCuisine: ["Pizza", "Italian-American"],
        currenciesAccepted: String(business.currency ?? "CAD"),
        address: postalAddress(business.address ?? "55 Parkdale Ave N, Hamilton, ON L8H 5W7"),
        ...(Number.isFinite(latitude) && Number.isFinite(longitude)
          ? { geo: { "@type": "GeoCoordinates", latitude, longitude } }
          : {}),
        ...(openingHoursSpecification.length ? { openingHoursSpecification } : {}),
        ...(sameAs.length ? { sameAs } : {}),
        hasMenu: { "@id": menuId },
        potentialAction: {
          "@type": "OrderAction",
          target: `${origin}/#menu`,
        },
      },
      {
        "@type": "Menu",
        "@id": menuId,
        name: `${name} menu`,
        url: `${origin}/#menu`,
        hasMenuSection: menuSections,
      },
    ],
  };
}

/** Prevent a stored editor value from ending the JSON-LD script element. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
