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
  process.env.SEO_INDEXABLE = "true";
  try {
    const result = robots();
    assert.equal(result.sitemap, "https://pizza62.ca/sitemap.xml");
    assert.deepEqual(result.rules, [
      { userAgent: "*", allow: "/", disallow: ["/admin", "/kitchen", "/employee", "/track", "/feedback", "/api/"] },
    ]);
  } finally {
    if (previous === undefined) delete process.env.SEO_INDEXABLE;
    else process.env.SEO_INDEXABLE = previous;
  }
});
