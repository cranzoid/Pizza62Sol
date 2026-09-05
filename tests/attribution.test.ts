/**
 * Marketing attribution — the sanitiser and the classification.
 *
 * Two properties are worth pinning here, and they are the two that would cost
 * real money to get wrong:
 *
 * **Nothing but campaign labels reaches the order row.** The value arrives from
 * localStorage on a device we do not control, is written into `orders`, is read
 * back onto a staff screen and is exported into a spreadsheet. An unexpected key
 * would travel that whole path.
 *
 * **A Meta click is recognised as a Meta click.** The restaurant is deciding
 * whether to keep paying for those clicks. A `fbclid` misfiled as "Direct" is an
 * ad crediting itself with nothing; a direct visit filed as "Meta Ads" is worse.
 *
 * Pure functions, no database — this suite runs everywhere.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  attributionChannel,
  normalizeAttribution,
  normalizeTouch,
  orderSourceLabel,
  parseAttribution,
  touchChannel,
  touchLabel,
  touchRows,
  touchesDiffer,
} from "@/lib/attribution";

test("keeps only the known campaign fields", () => {
  const touch = normalizeTouch({
    utm_source: "facebook",
    utm_campaign: "game-day",
    fbclid: "IwAR-abc",
    landing_path: "/",
    // None of these are campaign labels, and none may reach an order row.
    customer_email: "ada@example.test",
    password: "hunter2",
    address: "55 Parkdale Ave N",
  });
  assert.deepEqual(touch, {
    utm_source: "facebook",
    utm_campaign: "game-day",
    fbclid: "IwAR-abc",
    landing_path: "/",
  });
});

test("trims, bounds and drops empty values", () => {
  const touch = normalizeTouch({
    utm_source: "  meta  ",
    utm_medium: "   ",
    utm_campaign: "x".repeat(400),
    landing_path: `/${"y".repeat(400)}`,
    utm_term: 42,
  });
  assert.equal(touch?.utm_source, "meta");
  assert.equal(touch?.utm_medium, undefined, "a whitespace-only value is not a value");
  assert.equal(touch?.utm_campaign?.length, 160);
  assert.equal(touch?.landing_path?.length, 300);
  assert.equal(touch?.utm_term, undefined, "a non-string is not coerced into a label");
});

test("a touch carrying only a timestamp is nothing at all", () => {
  assert.equal(normalizeTouch({ captured_at: "2026-09-06T12:00:00.000Z" }), null);
  assert.equal(normalizeTouch({}), null);
  assert.equal(normalizeTouch(null), null);
  assert.equal(normalizeTouch("utm_source=facebook"), null);
});

test("accepts both the two-touch shape and a bare touch from an older tab", () => {
  const both = normalizeAttribution({ first: { utm_source: "google" }, last: { utm_source: "facebook" } });
  assert.deepEqual(both, { first: { utm_source: "google" }, last: { utm_source: "facebook" } });

  // A tab still running the previous build posts one flat object. It is the
  // visit that placed the order, so it is the last touch.
  const legacy = normalizeAttribution({ utm_source: "facebook", utm_campaign: "spring" });
  assert.deepEqual(legacy, { last: { utm_source: "facebook", utm_campaign: "spring" } });

  assert.equal(normalizeAttribution({ first: {}, last: {} }), null);
  assert.equal(normalizeAttribution(undefined), null);
  assert.equal(normalizeAttribution([{ utm_source: "facebook" }]), null);
});

test("reads a stored column back, and survives a corrupt one", () => {
  assert.deepEqual(parseAttribution('{"last":{"utm_source":"facebook"}}'), { last: { utm_source: "facebook" } });
  assert.equal(parseAttribution("not json"), null);
  assert.equal(parseAttribution(null), null);
});

test("recognises the platforms the restaurant actually buys clicks from", () => {
  assert.equal(touchChannel({ fbclid: "IwAR-abc" }), "meta_ads");
  assert.equal(touchChannel({ utm_source: "facebook", utm_medium: "cpc" }), "meta_ads");
  assert.equal(touchChannel({ utm_source: "instagram", utm_medium: "paid_social" }), "meta_ads");
  assert.equal(touchChannel({ gclid: "Cj0KCQ" }), "google_ads");
  assert.equal(touchChannel({ utm_source: "google", utm_medium: "cpc" }), "google_ads");
  assert.equal(touchChannel({ wbraid: "abc" }), "google_ads");
});

test("does not promote organic traffic into paid traffic", () => {
  // An Instagram post the restaurant wrote itself, tagged by hand.
  assert.equal(touchChannel({ utm_source: "instagram", utm_medium: "social" }), "social");
  // Someone arriving from a Google search result, with no campaign at all.
  assert.equal(touchChannel({ referrer_origin: "https://www.google.com", landing_path: "/" }), "organic_search");
  assert.equal(touchChannel({ referrer_origin: "https://www.hamiltonfoodblog.test" }), "referral");
  assert.equal(touchChannel({ landing_path: "/" }), "direct");
  assert.equal(touchChannel(null), "direct");
});

test("a click id outranks the utm labels typed alongside it", () => {
  // Ad links are hand-built and get mislabelled; the click id is written by the
  // platform itself and is the evidence.
  assert.equal(touchChannel({ gclid: "Cj0KCQ", utm_source: "newsletter", utm_medium: "email" }), "google_ads");
  assert.equal(touchChannel({ fbclid: "IwAR", utm_source: "google", utm_medium: "organic" }), "meta_ads");
});

test("labels an order by the visit that placed it", () => {
  const attribution = {
    first: { utm_source: "google", utm_medium: "cpc", utm_campaign: "always-on" },
    last: { fbclid: "IwAR", utm_campaign: "game-day-2026" },
  };
  assert.equal(attributionChannel(attribution), "meta_ads");
  assert.equal(touchLabel(attribution.last), "Meta Ads · game-day-2026");
  assert.equal(orderSourceLabel(attribution, "online"), "Meta Ads · game-day-2026");
  assert.equal(touchesDiffer(attribution), true);
});

test("a staff-entered order is named as one rather than called Direct", () => {
  assert.equal(orderSourceLabel(null, "phone"), "Phone order");
  assert.equal(orderSourceLabel(null, "walk_in"), "Walk-in");
  assert.equal(orderSourceLabel(null, "online"), "Direct");
  // The channel wins even if a till order somehow carried campaign labels.
  assert.equal(orderSourceLabel({ last: { fbclid: "IwAR" } }, "phone"), "Phone order");
});

test("one repeated visit is not shown as two", () => {
  const touch = { utm_source: "facebook", utm_campaign: "game-day" };
  assert.equal(touchesDiffer({ first: { ...touch, captured_at: "1" }, last: { ...touch, captured_at: "2" } }), false);
  assert.equal(touchesDiffer({ last: touch }), false);
  assert.equal(touchesDiffer(null), false);
});

test("renders every stored field with a label a person can read", () => {
  const rows = touchRows({ utm_source: "facebook", utm_campaign: "game-day", fbclid: "IwAR", landing_path: "/" });
  assert.deepEqual(rows, [
    { label: "Source", value: "facebook" },
    { label: "Campaign", value: "game-day" },
    { label: "Meta click id", value: "IwAR" },
    { label: "Landed on", value: "/" },
  ]);
  assert.deepEqual(touchRows(null), []);
});
