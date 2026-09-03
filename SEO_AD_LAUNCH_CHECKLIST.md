# SEO and advertising launch checklist

The code is ready, but third-party accounts must be connected after review. None
of the steps below should be performed on the staging slot.

## Before deployment

- Confirm the title and search description in **Admin → Website → Search & sharing**.
- Confirm the restaurant name, phone, address, coordinates, hours, Facebook URL,
  and Instagram URL. Those values feed visible content and Restaurant JSON-LD.
- Add the Meta Pixel numeric ID as `meta_pixel_id` in `infra/terraform.tfvars`.
- Add the GA4 web stream ID as `ga4_measurement_id`.
- If using a native Google Ads website conversion, add `google_ads_id` (`AW-...`)
  and its purchase `google_ads_conversion_label`. Alternatively, import the GA4
  `purchase` key event into Google Ads and leave the direct Ads fields blank.
- Add the Search Console verification token as `google_site_verification`.

## After the reviewed deployment

- Open the home page in a private browser. Verify that no request goes to Meta or
  Google before a consent choice.
- Choose **Allow measurement** and verify `PageView`, `ViewContent`, `AddToCart`,
  `InitiateCheckout`, and `Purchase` in Meta Events Manager Test Events.
- Verify `view_item`, `add_to_cart`, `begin_checkout`, and `purchase` in GA4
  DebugView. The `purchase` event must contain CAD value and a unique `P62-...`
  transaction ID.
- Place one pay-at-store test order and one Clover test order. Refresh the return
  page and confirm neither platform counts the same order twice.
- Validate the home page in Google's Rich Results Test and confirm the Restaurant
  address, hours, coordinates, menu sections, products, prices, and availability.
- Add `https://pizza62.ca/sitemap.xml` in Google Search Console and Bing Webmaster
  Tools, then request indexing for the home page.
- Confirm the Google Business Profile website/order URL is `https://pizza62.ca/`
  and that its name, address, phone, and hours match the website exactly.
- Confirm the former Wix paths `/menu`, `/online-ordering`, `/cart-page`,
  `/my-orders`, and `/my-subscriptions` redirect to their new equivalents.
- Use campaign URLs with consistent `utm_source`, `utm_medium`, `utm_campaign`,
  and `utm_content` values. Google and Meta click IDs are also retained for the
  first-party funnel report.

## Conversion definitions

Treat a confirmed `purchase` as the primary sales conversion. Bag additions,
checkout starts, and phone clicks are useful diagnostics or secondary conversions;
do not include all of them as primary bidding goals, or campaigns will optimize
for activity instead of orders.
