-- Marketing attribution on the order row.
--
-- Generated from db/schema.ts. Meta and Google ads send traffic here with
-- campaign parameters on the URL; until now those were captured in the browser
-- and attached to analytics events only, so no order could be traced back to
-- the ad that paid for it. This column is that link: the sanitised first and
-- last campaign touch, as JSON (see lib/attribution.ts).
--
-- Nullable and additive. Orders taken before this deploys, and every walk-in or
-- phone order after it, simply have no attribution — which is the truth, not a
-- gap to backfill.

ALTER TABLE "orders" ADD COLUMN "attribution_json" text;
