// C-01: server-side delivery geography.
//
// The app has no external geocoder in this environment, so we resolve a delivery
// address to an approximate coordinate using the Forward Sortation Area (the first
// three characters of the Canadian postal code) and a table of Hamilton-area FSA
// centroids. Order creation then uses lib/domain.validateDelivery to compute the
// straight-line distance from the immutable store origin and compare it to the
// owner-configured radius. Any postal code whose FSA is not in this table resolves
// to `null` and is treated as unverified — the order is blocked with a call-the-store
// message rather than reaching the payment provider.
//
// This is deliberately conservative: an FSA centroid is only an approximation, so
// the radius check should be treated as a guard rail, not a survey-grade boundary.
// Replacing `resolveDeliveryPoint` with a real geocoder later requires no changes to
// the order-service call site.

export type GeoPoint = { latitude: number; longitude: number };

// Approximate centroids for Hamilton and immediately adjacent FSAs. Coordinates are
// public-domain approximate FSA centres; refine against an authoritative source
// before relying on them for edge-of-radius decisions.
const FSA_CENTROIDS: Record<string, GeoPoint> = {
  L8E: { latitude: 43.2213, longitude: -79.7339 }, // Stoney Creek
  L8G: { latitude: 43.2073, longitude: -79.7590 }, // Stoney Creek Mountain
  L8H: { latitude: 43.2503, longitude: -79.7980 }, // Hamilton – Parkdale / east end (store FSA)
  L8J: { latitude: 43.1912, longitude: -79.7862 }, // Hamilton Mountain east
  L8K: { latitude: 43.2261, longitude: -79.8083 }, // Hamilton east Mountain
  L8L: { latitude: 43.2639, longitude: -79.8450 }, // Hamilton north/central
  L8M: { latitude: 43.2470, longitude: -79.8450 }, // Hamilton central
  L8N: { latitude: 43.2531, longitude: -79.8680 }, // Hamilton downtown
  L8P: { latitude: 43.2560, longitude: -79.8840 }, // Hamilton west/central
  L8R: { latitude: 43.2668, longitude: -79.8740 }, // Hamilton north
  L8S: { latitude: 43.2620, longitude: -79.9120 }, // Westdale / McMaster
  L8T: { latitude: 43.2090, longitude: -79.8450 }, // Hamilton Mountain
  L8V: { latitude: 43.2350, longitude: -79.8690 }, // Hamilton Mountain central
  L8W: { latitude: 43.1962, longitude: -79.8590 }, // Hamilton Mountain south
  L9A: { latitude: 43.2300, longitude: -79.8880 }, // Hamilton Mountain west
  L9C: { latitude: 43.2260, longitude: -79.9050 }, // Hamilton Mountain / Ancaster edge
  L9H: { latitude: 43.2670, longitude: -79.9550 }, // Dundas
};

export function resolveDeliveryPoint(postalCode: string): GeoPoint | null {
  const fsa = postalCode.replace(/\s+/g, "").slice(0, 3).toUpperCase();
  return FSA_CENTROIDS[fsa] ?? null;
}
