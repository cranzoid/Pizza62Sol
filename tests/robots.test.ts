import assert from "node:assert/strict";
import test from "node:test";

import robots from "@/app/robots";

test("blocks every crawler on a non-indexable slot", () => {
  const previous = process.env.SEO_INDEXABLE;
  process.env.SEO_INDEXABLE = "false";
  try {
    const result = robots();
    assert.deepEqual(result.rules, [{ userAgent: "*", disallow: "/" }]);
    assert.equal(result.sitemap, undefined);
  } finally {
    if (previous === undefined) delete process.env.SEO_INDEXABLE;
    else process.env.SEO_INDEXABLE = previous;
  }
});

test("publishes the public routes only on the indexable production host", () => {
  const previous = process.env.SEO_INDEXABLE;
  const previousBase = process.env.PUBLIC_BASE_URL;
  process.env.SEO_INDEXABLE = "true";
  process.env.PUBLIC_BASE_URL = "https://pizza62.ca";
  try {
    const result = robots();
    assert.equal(result.sitemap, "https://pizza62.ca/sitemap.xml");
    assert.equal(result.host, "https://pizza62.ca");
    assert.deepEqual(result.rules, [
      {
        userAgent: "*",
        allow: "/",
        // `/gift-cards` itself is public and in the sitemap; the two paths
        // below are its private half — a balance form has nothing to index and
        // a payment return page carries a session id.
        disallow: [
          "/admin",
          "/kitchen",
          "/employee",
          "/kiosk",
          "/track",
          "/feedback",
          "/order/",
          "/gift-cards/balance",
          "/gift-cards/return",
          "/api/",
        ],
      },
    ]);
  } finally {
    if (previous === undefined) delete process.env.SEO_INDEXABLE;
    else process.env.SEO_INDEXABLE = previous;
    if (previousBase === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previousBase;
  }
});
