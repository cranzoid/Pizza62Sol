// C-01 / H-06b: server-side delivery geography.
//
// Order creation resolves a delivery address to a coordinate, and
// lib/domain.validateDelivery then measures the straight-line distance from the
// immutable store origin against the owner-configured radius. An address that
// cannot be resolved is treated as unverified and the order is blocked with a
// call-the-store message rather than reaching the payment provider.
//
// There are two resolvers, in order:
//
// 1. Azure Maps, geocoding the full street address. This is the accurate one.
//
// 2. A table of Hamilton-area Forward Sortation Area centroids — the first three
//    characters of the postal code. This was the only resolver, and it is far
//    too coarse to decide eligibility: every address in an FSA collapses to one
//    point kilometres wide, so a customer who mistypes a digit into a
//    neighbouring FSA passes the radius check, and a genuine address near the
//    edge can be refused because its FSA's centre happens to sit outside.
//
// The fallback is kept rather than deleted on purpose. If Azure Maps is
// unreachable, refusing every delivery order would be a worse failure than
// checking coarsely — the radius is a guard rail, and the store can still
// decline by phone. What is *not* tolerated is a match Azure Maps rejects: an
// address it cannot find is far more likely mistyped than real, so that returns
// null and blocks.

export type GeoPoint = { latitude: number; longitude: number };

export type DeliveryAddress = {
  line1: string;
  unit?: string;
  city: string;
  province: string;
  postalCode: string;
};

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

/** The coarse fallback, and the only resolver used when Azure Maps is not configured. */
export function resolveFsaCentroid(postalCode: string): GeoPoint | null {
  const fsa = postalCode.replace(/\s+/g, "").slice(0, 3).toUpperCase();
  return FSA_CENTROIDS[fsa] ?? null;
}

/**
 * Azure Maps returns a confidence band per result. "Low" means it matched
 * something loosely — often just the town — which is exactly the case an FSA
 * centroid already covers badly, so it is not treated as a resolution.
 */
const ACCEPTED_CONFIDENCE = new Set(["High", "Medium"]);

// A delivery address should never take longer than this to resolve; the customer
// is waiting on a checkout button. On timeout we fall back rather than fail.
const GEOCODE_TIMEOUT_MS = 2500;

type AzureMapsResult = {
  position?: { lat?: number; lon?: number };
  matchConfidence?: { confidence?: string; score?: number };
  address?: { countrySubdivisionCode?: string; municipality?: string; postalCode?: string };
  type?: string;
};

function mapsConfigured(): boolean {
  return Boolean(process.env.AZURE_MAPS_CLIENT_ID || process.env.AZURE_MAPS_SUBSCRIPTION_KEY);
}

async function mapsAuthHeaders(): Promise<Record<string, string> | null> {
  const subscriptionKey = process.env.AZURE_MAPS_SUBSCRIPTION_KEY;
  // A subscription key is the local and CI path. Production uses the Container
  // App's managed identity, so no Maps key is held as a secret.
  if (subscriptionKey) return { "subscription-key": subscriptionKey };

  const clientId = process.env.AZURE_MAPS_CLIENT_ID;
  if (!clientId) return null;

  // Imported lazily so that a deployment without Azure Maps — and every test —
  // never loads the Azure identity stack.
  const { DefaultAzureCredential } = await import("@azure/identity");
  const token = await new DefaultAzureCredential().getToken("https://atlas.microsoft.com/.default");
  if (!token) return null;
  return { Authorization: `Bearer ${token.token}`, "x-ms-client-id": clientId };
}

async function geocodeWithAzureMaps(address: DeliveryAddress): Promise<GeoPoint | null | "unavailable"> {
  let headers: Record<string, string> | null;
  try {
    headers = await mapsAuthHeaders();
  } catch {
    return "unavailable";
  }
  if (!headers) return "unavailable";

  // The unit is deliberately omitted: apartment numbers confuse the geocoder and
  // do not change the coordinate for a radius check.
  const query = `${address.line1}, ${address.city}, ${address.province} ${address.postalCode}`;
  const url = new URL("https://atlas.microsoft.com/search/address/json");
  url.searchParams.set("api-version", "1.0");
  url.searchParams.set("query", query);
  url.searchParams.set("countrySet", "CA");
  url.searchParams.set("limit", "1");

  try {
    const response = await fetch(url, {
      headers: { ...headers, accept: "application/json" },
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
    });
    if (!response.ok) return "unavailable";
    const payload = (await response.json()) as { results?: AzureMapsResult[] };
    const best = payload.results?.[0];
    if (!best?.position || typeof best.position.lat !== "number" || typeof best.position.lon !== "number") {
      // Azure Maps answered and found nothing. That is a real signal, not an
      // outage: the address is very likely mistyped, so block rather than fall
      // back to a centroid that would wave it through.
      return null;
    }
    const confidence = best.matchConfidence?.confidence;
    if (confidence && !ACCEPTED_CONFIDENCE.has(confidence)) return null;
    return { latitude: best.position.lat, longitude: best.position.lon };
  } catch {
    // Network error, timeout, or malformed response.
    return "unavailable";
  }
}

/**
 * Resolves a delivery address to a coordinate, or null if it cannot be trusted.
 *
 * Returning null blocks the order at the call site in lib/order-service.
 */
export async function resolveDeliveryPoint(address: DeliveryAddress): Promise<GeoPoint | null> {
  if (mapsConfigured()) {
    const geocoded = await geocodeWithAzureMaps(address);
    if (geocoded !== "unavailable") return geocoded;
    // Fall through to the centroid table only when Maps could not answer at all.
  }
  return resolveFsaCentroid(address.postalCode);
}
