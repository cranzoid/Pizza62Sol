import assert from "node:assert/strict";
import test from "node:test";

import { restaurantStructuredData, serializeJsonLd } from "@/lib/seo";

test("builds Restaurant and live Menu structured data from public settings", () => {
  const data = restaurantStructuredData({
    categories: [{ id: "pizza", name: "Pizza" }],
    products: [{
      id: "large-pepperoni",
      category_id: "pizza",
      name: "Large Pepperoni",
      description: "A fresh large pepperoni pizza.",
      base_price_cents: 1799,
      sold_out: 0,
      setup_required: 0,
    }],
    settings: {
      business: { value: {
        name: "Pizza 62",
        phone: "(905) 547-5777",
        currency: "CAD",
        address: "55 Parkdale Ave N, Hamilton, ON L8H 5W7",
        latitude: 43.23779,
        longitude: -79.79189,
      } },
      content: { value: { seoDescription: "Hamilton pizza for pickup and delivery." } },
      hours: { value: [{ weekday: 1, openMinute: 660, closeMinute: 1320 }] },
    },
  }, "https://pizza62.ca");

  const graph = data["@graph"] as Array<Record<string, unknown>>;
  const restaurant = graph.find((entry) => entry["@type"] === "Restaurant")!;
  const menu = graph.find((entry) => entry["@type"] === "Menu")!;
  assert.deepEqual(restaurant.address, {
    "@type": "PostalAddress",
    streetAddress: "55 Parkdale Ave N",
    addressLocality: "Hamilton",
    addressRegion: "ON",
    postalCode: "L8H 5W7",
    addressCountry: "CA",
  });
  assert.deepEqual(restaurant.openingHoursSpecification, [{
    "@type": "OpeningHoursSpecification",
    dayOfWeek: "Monday",
    opens: "11:00",
    closes: "22:00",
  }]);
  const section = (menu.hasMenuSection as Array<Record<string, unknown>>)[0];
  const item = (section.hasMenuItem as Array<Record<string, unknown>>)[0];
  assert.equal(item.name, "Large Pepperoni");
  assert.equal((item.offers as Record<string, unknown>).price, "17.99");
});

test("escapes editor text that could terminate a JSON-LD script", () => {
  const serialized = serializeJsonLd({ name: "</script><script>alert(1)</script>" });
  assert.ok(!serialized.includes("<script>"));
  assert.match(serialized, /\\u003c\/script>/);
});
