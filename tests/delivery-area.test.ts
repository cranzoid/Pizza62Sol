/**
 * Delivery-address resolution (H-06b).
 *
 * The interesting behaviour is not the happy path but what happens when Azure
 * Maps does not give a clean answer, because the two failure modes must be
 * handled in opposite directions:
 *
 * - Maps is unreachable  -> fall back to the coarse FSA centroid. Refusing every
 *                           delivery order during a Maps outage is worse than
 *                           checking imprecisely.
 * - Maps found nothing   -> block. Maps answering "no such address" is evidence
 *                           the address is mistyped, and falling back to a
 *                           centroid would wave exactly that case through - the
 *                           bug this change exists to fix.
 *
 * `fetch` is stubbed rather than calling the live service, so these run offline.
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

const { resolveDeliveryPoint, resolveFsaCentroid } = await import("@/lib/delivery-area");

const ADDRESS = {
  line1: "55 Parkdale Ave N",
  city: "Hamilton",
  province: "ON",
  postalCode: "L8H 5W7",
};

const realFetch = globalThis.fetch;

const stubFetch = (handler: () => Promise<Response> | Response) => {
  globalThis.fetch = (async () => handler()) as typeof fetch;
};

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.AZURE_MAPS_SUBSCRIPTION_KEY;
  delete process.env.AZURE_MAPS_CLIENT_ID;
});

const mapsResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("falls back to the FSA centroid when Azure Maps is not configured", async () => {
  const point = await resolveDeliveryPoint(ADDRESS);
  assert.deepEqual(point, resolveFsaCentroid("L8H 5W7"));
});

test("uses the geocoded coordinate when Azure Maps resolves the address", async () => {
  process.env.AZURE_MAPS_SUBSCRIPTION_KEY = "test-key";
  stubFetch(() =>
    mapsResponse({
      results: [{ position: { lat: 43.2557, lon: -79.8011 }, matchConfidence: { confidence: "High" } }],
    }),
  );
  const point = await resolveDeliveryPoint(ADDRESS);
  assert.deepEqual(point, { latitude: 43.2557, longitude: -79.8011 });

  // The whole point of the change: the answer is the actual address, not the
  // FSA's centre.
  assert.notDeepEqual(point, resolveFsaCentroid("L8H 5W7"));
});

test("blocks when Azure Maps finds no such address", async () => {
  process.env.AZURE_MAPS_SUBSCRIPTION_KEY = "test-key";
  stubFetch(() => mapsResponse({ results: [] }));

  // This is the regression the fix targets. Under the old resolver a mistyped
  // postal code still landed on some FSA centroid and passed the radius check.
  assert.equal(await resolveDeliveryPoint(ADDRESS), null);
});

test("blocks a low-confidence match rather than trusting it", async () => {
  process.env.AZURE_MAPS_SUBSCRIPTION_KEY = "test-key";
  stubFetch(() =>
    mapsResponse({
      results: [{ position: { lat: 43.9, lon: -79.1 }, matchConfidence: { confidence: "Low" } }],
    }),
  );
  assert.equal(await resolveDeliveryPoint(ADDRESS), null);
});

test("falls back to the centroid when Azure Maps errors", async () => {
  process.env.AZURE_MAPS_SUBSCRIPTION_KEY = "test-key";
  stubFetch(() => mapsResponse({ error: "service unavailable" }, 503));
  assert.deepEqual(await resolveDeliveryPoint(ADDRESS), resolveFsaCentroid("L8H 5W7"));
});

test("falls back to the centroid when the Azure Maps call throws", async () => {
  process.env.AZURE_MAPS_SUBSCRIPTION_KEY = "test-key";
  stubFetch(() => {
    throw new Error("network down");
  });
  assert.deepEqual(await resolveDeliveryPoint(ADDRESS), resolveFsaCentroid("L8H 5W7"));
});

test("an out-of-area postal code still resolves to nothing without Maps", async () => {
  assert.equal(await resolveDeliveryPoint({ ...ADDRESS, postalCode: "K1A 0B1" }), null);
});
