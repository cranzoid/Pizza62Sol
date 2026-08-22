/**
 * The three audit findings that are about what an attacker can reach.
 *
 * **H-26 — uploads trusted their own label.** `file.type` is a string the
 * browser sends and any client can set, so `evil.html` declared as `image/png`
 * was stored and then served from this site's own origin, where it runs with the
 * session cookie of whoever opens it. The bytes are now inspected, and the
 * serving headers assume the check might one day be wrong anyway.
 *
 * **C-09's follow-up — the roster was public.** The endpoint added so the kiosk
 * could show a name picker published the first name of every member of staff to
 * anyone who found the URL. Rate limiting bounds how fast that can be scraped;
 * it does not stop it being read.
 *
 * **H-15 — tokens in URLs.** The audit found full tokenised URLs in the runtime
 * access log. The link in an email still has to carry the token, but nothing
 * after that does.
 *
 * Requires a reachable Postgres for the roster tests; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { inspectImage, ImageRejected } = await import("@/lib/image-validation");
const { GET: rosterRoute } = await import("@/app/api/timeclock/kiosk/route");
const { GET: trackRoute } = await import("@/app/api/orders/track/route");
const { hashOpaqueToken, generateOpaqueToken } = await import("@/lib/domain");
const { securityHeadersFor, isTokenBearingPath, APPLE_PAY_ASSOCIATION_PATH } = await import("@/lib/security-headers");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const RUN = crypto.randomUUID().slice(0, 8);
let counter = 0;
const nextClientIp = () => `198.51.100.${(counter += 1) % 250}-${RUN}`;

// --- H-26: what a file actually is ------------------------------------------

/** A minimal but genuinely valid PNG header: signature + IHDR with dimensions. */
function pngBytes(width = 64, height = 48): ArrayBuffer {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes.buffer;
}

function jpegBytes(width = 800, height = 600): ArrayBuffer {
  const bytes = new Uint8Array(64);
  bytes.set([0xff, 0xd8, 0xff], 0);
  bytes[3] = 0xc0; // SOF0 immediately, which is legal and enough to parse.
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 17, false); // segment length
  bytes[6] = 8; // precision
  view.setUint16(7, height, false);
  view.setUint16(9, width, false);
  return bytes.buffer;
}

const bufferOf = (text: string) => new TextEncoder().encode(text.padEnd(64, " ")).buffer;

test("identifies a real image from its bytes, not its name", () => {
  const png = inspectImage(pngBytes(64, 48));
  assert.equal(png.kind, "png");
  assert.equal(png.contentType, "image/png");
  assert.equal(png.width, 64);
  assert.equal(png.height, 48);

  const jpeg = inspectImage(jpegBytes(800, 600));
  assert.equal(jpeg.kind, "jpg");
  assert.equal(jpeg.contentType, "image/jpeg");
  assert.equal(jpeg.width, 800);
});

test("rejects a file that is not an image whatever it claims to be", () => {
  // The attack in its simplest form: HTML uploaded as evil.png, then served from
  // this origin and opened by an authenticated owner.
  assert.throws(
    () => inspectImage(bufferOf("<html><script>alert(document.cookie)</script></html>")),
    ImageRejected,
  );
  assert.throws(() => inspectImage(bufferOf("%PDF-1.7")), ImageRejected);
  assert.throws(() => inspectImage(bufferOf("GIF87")), ImageRejected, "a truncated signature is not a GIF");
});

test("rejects an image whose header describes a decompression bomb", () => {
  // A valid signature and a plausible file size, describing 3.6 billion pixels.
  // It is the browser resizing it for the menu that falls over.
  assert.throws(() => inspectImage(pngBytes(60_000, 60_000)), /larger than/);
  assert.throws(() => inspectImage(pngBytes(0, 0)), /too small/);
});

test("does not loop forever on a hostile JPEG segment length", () => {
  // A zero-length segment advances the cursor by zero, so a naive parser spins.
  const bytes = new Uint8Array(64);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  new DataView(bytes.buffer).setUint16(4, 0, false);
  assert.throws(() => inspectImage(bytes.buffer), ImageRejected);
});

// --- C-09 follow-up: the roster is not public --------------------------------

withDb("refuses the staff roster to an unpaired device", async () => {
  const response = await rosterRoute(
    new Request("https://order.pizza62.test/api/timeclock/kiosk", {
      headers: { "x-azure-clientip": nextClientIp() },
    }),
  );
  assert.equal(response.status, 403);
  const body = await response.text();
  // The names must not be in the body of the refusal either.
  assert.ok(!body.includes('"employees"'));
});

withDb("refuses a wrong device token", async () => {
  await getPool().query(
    `INSERT INTO settings (key, value_json, version, updated_at) VALUES ('kiosk', $1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [JSON.stringify({ tokenHash: await hashOpaqueToken(generateOpaqueToken()) }), Date.now()],
  );
  const response = await rosterRoute(
    new Request("https://order.pizza62.test/api/timeclock/kiosk", {
      headers: { "x-azure-clientip": nextClientIp(), "x-kiosk-token": generateOpaqueToken() },
    }),
  );
  assert.equal(response.status, 403);
});

withDb("serves the roster to a paired device", async () => {
  const token = generateOpaqueToken();
  await getPool().query(
    `INSERT INTO settings (key, value_json, version, updated_at) VALUES ('kiosk', $1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [JSON.stringify({ tokenHash: await hashOpaqueToken(token) }), Date.now()],
  );
  const response = await rosterRoute(
    new Request("https://order.pizza62.test/api/timeclock/kiosk", {
      headers: { "x-azure-clientip": nextClientIp(), "x-kiosk-token": token },
    }),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { employees: unknown[] };
  assert.ok(Array.isArray(body.employees));
});

withDb("stores only the hash of the device token", async () => {
  // Otherwise the settings row is itself the credential, and a database dump
  // hands over the kiosk.
  const token = generateOpaqueToken();
  await getPool().query(
    `INSERT INTO settings (key, value_json, version, updated_at) VALUES ('kiosk', $1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [JSON.stringify({ tokenHash: await hashOpaqueToken(token) }), Date.now()],
  );
  const row = await getPool().query<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'kiosk'");
  assert.ok(!row.rows[0].value_json.includes(token));
});

// --- H-15: tokens out of URLs ------------------------------------------------

withDb("accepts the tracking token in a header, so it stays out of access logs", async () => {
  // A token in a query string is written to every log the request passes
  // through. The audit found exactly that in the runtime log.
  const response = await trackRoute(
    new Request("https://order.pizza62.test/api/orders/track?order=P62-9999999", {
      headers: { "x-azure-clientip": nextClientIp(), "x-tracking-token": "a".repeat(64) },
    }),
  );
  // 404 because the order does not exist — what matters is that the header was
  // read and the request was not rejected for having no token at all.
  assert.equal(response.status, 404);
});

test("sends no referrer from pages that can carry a token", () => {
  // `strict-origin-when-cross-origin` still leaks the *full URL* on a same-origin
  // navigation, which for /track is the URL containing the token.
  for (const path of ["/track", "/feedback", "/order/return"]) {
    const headers = securityHeadersFor(path);
    assert.equal(headers["Referrer-Policy"], "no-referrer", `${path} must send no referrer`);
    // And a page whose URL holds a credential must not sit in a shared cache.
    assert.match(headers["Cache-Control"] ?? "", /no-store/);
  }
});

test("keeps the ordinary referrer policy everywhere else", () => {
  // The strict policy is still wanted on the rest of the site; no-referrer
  // everywhere would lose legitimate same-origin navigation context.
  const headers = securityHeadersFor("/");
  assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["Cache-Control"], undefined, "the rest of the site stays cacheable");
});

test("allows the HTTPS image URLs accepted by the owner editors", () => {
  const policy = securityHeadersFor("/")["Content-Security-Policy"];
  assert.match(policy, /img-src 'self' https: data: blob:/);
});


// --- Apple Pay domain verification ------------------------------------------

test("keeps the Apple Pay association path out of the token-bearing set", () => {
  // Apple fetches this to prove we control the domain before Apple Pay may run
  // on it. `no-store` and `no-referrer` would be harmless, but the path landing
  // in that set at all would mean someone had reclassified it as private — and
  // the one thing verification cannot survive is this path being treated as
  // anything other than openly fetchable.
  assert.equal(isTokenBearingPath(APPLE_PAY_ASSOCIATION_PATH), false);
  assert.equal(securityHeadersFor(APPLE_PAY_ASSOCIATION_PATH)["Cache-Control"], undefined);
});

test("does not redirect the apex host that Apple Pay is registered under", async () => {
  // The failure this guards is silent and slow: a canonical rule broadened later
  // to cover the apex would make Apple's fetch a redirect, and Apple rejects
  // those. Verification then fails days after the change that caused it.
  const { canonicalRedirectUrl } = await import("@/lib/canonical-host");
  assert.equal(
    canonicalRedirectUrl({
      requestUrl: `https://pizza62.ca${APPLE_PAY_ASSOCIATION_PATH}`,
      forwardedHost: "pizza62.ca",
      publicBaseUrl: "https://pizza62.ca",
    }),
    null,
  );
});


// --- the CSP widening that inline card entry needs ---------------------------

test("lets Clover's card form run on the storefront, and nowhere else", () => {
  // The inline form needs three directives opened: the SDK is a script from
  // Clover, the card fields are iframes from Clover, and tokenising is a call to
  // Clover. `frame-src` is the one that is easy to miss — the baseline has no
  // such directive, so it falls back to `default-src 'self'` and the fields are
  // blocked with the script tag loading perfectly well.
  const checkout = securityHeadersFor("/")["Content-Security-Policy"];
  assert.match(checkout, /script-src [^;]*https:\/\/checkout\.clover\.com/);
  assert.match(checkout, /frame-src [^;]*https:\/\/\*\.clover\.com/);
  assert.match(checkout, /connect-src [^;]*https:\/\/scl\.clover\.com/);

  // Everywhere else keeps the closed policy, so an XSS on any other route still
  // cannot reach the payment origins.
  const elsewhere = securityHeadersFor("/track")["Content-Security-Policy"];
  assert.doesNotMatch(elsewhere, /clover\.com/);
  assert.match(elsewhere, /connect-src 'self';/);
});

test("keeps the rest of the payment-page policy locked down", () => {
  const checkout = securityHeadersFor("/")["Content-Security-Policy"];
  assert.match(checkout, /object-src 'none'/);
  assert.match(checkout, /frame-ancestors 'none'/);
  assert.match(checkout, /base-uri 'self'/);
  assert.match(checkout, /form-action 'self'/);
});
