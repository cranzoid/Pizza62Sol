/**
 * The Clover payment contract (R1.3).
 *
 * Two things are worth testing here and they fail in opposite directions.
 *
 * The **checkout call** is where money is decided. The property that matters is
 * not that the request is well formed but that the amount Clover is asked to
 * charge is exactly the amount this application priced — every other guard in
 * the order pipeline is worthless if the last hop can charge something else. So
 * the assertions are about the total, the absence of a tax rate, and tips being
 * off, not about JSON shape for its own sake.
 *
 * The **webhook signature** is the only thing standing between an attacker and
 * marking arbitrary orders paid. Its tests are therefore mostly negative: each
 * one is a way in that must stay closed.
 *
 * `fetch` is stubbed, so these run offline and need no database.
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

const {
  createCloverCheckout,
  verifyCloverSignature,
  cloverApiBase,
  cloverCheckoutConfigured,
  CloverNotConfiguredError,
} = await import("@/lib/clover");

const SECRET = "test-webhook-signing-secret";

const ORDER = {
  orderNumber: "P62-1042",
  customerName: "Ada Lovelace",
  customerEmail: "ada@example.test",
  customerPhone: "905-555-0142",
  totalCents: 2032,
  summary: "2x Poutine",
};

const realFetch = globalThis.fetch;

type Captured = { url: string; headers: Headers; body: Record<string, unknown> };

/** Stubs fetch with a canned Clover response and records what was sent. */
const stubClover = (body: unknown, status = 200): { calls: Captured[] } => {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
};

const configure = () => {
  process.env.CLOVER_MERCHANT_ID = "TESTMERCHANT123";
  process.env.CLOVER_API_TOKEN = "test-private-token";
};

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.CLOVER_MERCHANT_ID;
  delete process.env.CLOVER_API_TOKEN;
  delete process.env.CLOVER_ENVIRONMENT;
});

const OK_RESPONSE = {
  href: "https://checkout.clover.com/session/abc",
  checkoutSessionId: "sess-abc-123",
  createdTime: 1_700_000_000_000,
  expirationTime: 1_700_000_900_000,
};

// --- environment ------------------------------------------------------------

test("defaults to the sandbox host, and only production opts out", () => {
  // Defaulting the safe way round: a missing or misspelled value must send test
  // traffic to the sandbox, never live traffic at a real merchant.
  assert.equal(cloverApiBase(), "https://apisandbox.dev.clover.com");
  process.env.CLOVER_ENVIRONMENT = "typo";
  assert.equal(cloverApiBase(), "https://apisandbox.dev.clover.com");
  process.env.CLOVER_ENVIRONMENT = "production";
  assert.equal(cloverApiBase(), "https://api.clover.com");
});

test("reports itself unconfigured until both credentials are present", () => {
  assert.equal(cloverCheckoutConfigured(), false);
  process.env.CLOVER_MERCHANT_ID = "TESTMERCHANT123";
  assert.equal(cloverCheckoutConfigured(), false, "merchant id alone is not enough");
  process.env.CLOVER_API_TOKEN = "test-private-token";
  assert.equal(cloverCheckoutConfigured(), true);
});

test("treats a blank credential as absent", () => {
  // An unset Key Vault secret arrives as an empty string, not as undefined. If
  // that counted as configured, the customer would be offered online payment
  // and then handed a 502 at the last step.
  process.env.CLOVER_MERCHANT_ID = "   ";
  process.env.CLOVER_API_TOKEN = "test-private-token";
  assert.equal(cloverCheckoutConfigured(), false);
});

// --- creating a checkout session --------------------------------------------

test("charges exactly the server-priced total, as one untaxed line item", async () => {
  configure();
  const { calls } = stubClover(OK_RESPONSE);
  await createCloverCheckout(ORDER);

  const cart = calls[0].body.shoppingCart as { lineItems: Array<Record<string, unknown>> };
  assert.equal(cart.lineItems.length, 1);
  assert.equal(cart.lineItems[0].price, 2032, "the charge must equal total_cents");
  assert.equal(cart.lineItems[0].unitQty, 1);

  // The regression these two guard: total_cents already contains tax, the
  // delivery fee and the tip. Declaring a tax rate would have Clover tax the
  // whole thing again, and enabling tips would collect a second one that no
  // order row knows about — either way the customer is charged an amount this
  // application never priced and cannot reconcile or refund against.
  assert.equal(cart.lineItems[0].taxRates, undefined, "no tax rate: tax is already in the total");
  assert.deepEqual(calls[0].body.tips, { enabled: false }, "the tip is already in the total");
});

test("sends the documented endpoint, headers and customer fields", async () => {
  configure();
  const { calls } = stubClover(OK_RESPONSE);
  await createCloverCheckout(ORDER);

  assert.equal(calls[0].url, "https://apisandbox.dev.clover.com/invoicingcheckoutservice/v1/checkouts");
  assert.equal(calls[0].headers.get("x-clover-merchant-id"), "TESTMERCHANT123");
  assert.equal(calls[0].headers.get("authorization"), "Bearer test-private-token");
  assert.deepEqual(calls[0].body.customer, {
    email: "ada@example.test",
    firstName: "Ada",
    lastName: "Lovelace",
    phoneNumber: "905-555-0142",
  });
});

test("puts everything after the first space in the surname", async () => {
  configure();
  const { calls } = stubClover(OK_RESPONSE);
  await createCloverCheckout({ ...ORDER, customerName: "Ada King  Lovelace" });
  const customer = calls[0].body.customer as Record<string, string>;
  assert.equal(customer.firstName, "Ada");
  assert.equal(customer.lastName, "King  Lovelace");
});

test("leaves the surname empty for a single-word name rather than duplicating it", async () => {
  configure();
  const { calls } = stubClover(OK_RESPONSE);
  await createCloverCheckout({ ...ORDER, customerName: "Prince" });
  const customer = calls[0].body.customer as Record<string, string>;
  assert.deepEqual([customer.firstName, customer.lastName], ["Prince", ""]);
});

test("returns the session id the webhook will later be matched on", async () => {
  configure();
  stubClover(OK_RESPONSE);
  const session = await createCloverCheckout(ORDER);
  // Clover has no metadata passthrough, so this id is the only link from the
  // payment back to the order. Losing it strands the order in awaiting_payment.
  assert.equal(session.checkoutSessionId, "sess-abc-123");
  assert.equal(session.href, "https://checkout.clover.com/session/abc");
});

test("refuses to start a checkout when it has no credentials", async () => {
  await assert.rejects(() => createCloverCheckout(ORDER), CloverNotConfiguredError);
});

test("refuses a non-positive total instead of asking Clover to charge it", async () => {
  configure();
  stubClover(OK_RESPONSE);
  await assert.rejects(() => createCloverCheckout({ ...ORDER, totalCents: 0 }), /non-positive/);
  await assert.rejects(() => createCloverCheckout({ ...ORDER, totalCents: -1 }), /non-positive/);
});

test("treats a 2xx without a session id as a failure, not a success", async () => {
  // The order must not be handed a checkout URL that does not exist, and the
  // caller's catch is what cancels it and releases the idempotency key.
  configure();
  stubClover({ href: "https://checkout.clover.com/session/abc" });
  await assert.rejects(() => createCloverCheckout(ORDER), /could not be created/);
});

test("surfaces Clover's own message when it rejects the call", async () => {
  configure();
  stubClover({ message: "401 Unauthorized" }, 401);
  await assert.rejects(() => createCloverCheckout(ORDER), /401 Unauthorized/);
});

// --- webhook signatures -----------------------------------------------------

const sign = async (body: string, timestampSeconds: number, secret = SECRET) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestampSeconds}.${body}`)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const header = async (body: string, atSeconds: number, secret = SECRET) =>
  `t=${atSeconds},v1=${await sign(body, atSeconds, secret)}`;

const NOW = 1_700_000_000_000;
const NOW_SECONDS = NOW / 1000;
const BODY = JSON.stringify({ id: "pay-1", merchantId: "M1", data: "sess-abc-123", status: "APPROVED", type: "PAYMENT" });

test("accepts a correctly signed, fresh event", async () => {
  assert.equal(await verifyCloverSignature(BODY, await header(BODY, NOW_SECONDS), SECRET, NOW), true);
});

test("rejects a body altered after signing", async () => {
  // The attack this closes: replaying a captured signature over a payload whose
  // `data` now names someone else's checkout session.
  const signature = await header(BODY, NOW_SECONDS);
  const tampered = BODY.replace("sess-abc-123", "sess-someone-else");
  assert.equal(await verifyCloverSignature(tampered, signature, SECRET, NOW), false);
});

test("rejects a signature made with a different secret", async () => {
  const forged = await header(BODY, NOW_SECONDS, "not-the-signing-secret");
  assert.equal(await verifyCloverSignature(BODY, forged, SECRET, NOW), false);
});

test("rejects a stale event in either direction", async () => {
  // Beyond the tolerance in both directions: a captured event replayed later,
  // and one dated into the future to outlive the window.
  const old = await header(BODY, NOW_SECONDS - 3600);
  const future = await header(BODY, NOW_SECONDS + 3600);
  assert.equal(await verifyCloverSignature(BODY, old, SECRET, NOW), false);
  assert.equal(await verifyCloverSignature(BODY, future, SECRET, NOW), false);
});

test("accepts an event just inside the freshness window", async () => {
  const recent = await header(BODY, NOW_SECONDS - 250);
  assert.equal(await verifyCloverSignature(BODY, recent, SECRET, NOW), true);
});

test("rejects a missing, empty or malformed signature header", async () => {
  const valid = await sign(BODY, NOW_SECONDS);
  for (const candidate of [
    null,
    "",
    "garbage",
    `v1=${valid}`, // no timestamp, so freshness cannot be established
    `t=${NOW_SECONDS}`, // no MAC at all
    `t=not-a-number,v1=${valid}`,
    `t=${NOW_SECONDS},v1=`,
  ]) {
    assert.equal(
      await verifyCloverSignature(BODY, candidate, SECRET, NOW),
      false,
      `expected rejection for ${JSON.stringify(candidate)}`,
    );
  }
});

test("moving the timestamp forward invalidates the signature", async () => {
  // Why binding `t` into the signed string matters: without it an attacker could
  // keep a captured MAC alive indefinitely just by advancing the timestamp.
  const valid = await sign(BODY, NOW_SECONDS - 3600);
  assert.equal(await verifyCloverSignature(BODY, `t=${NOW_SECONDS},v1=${valid}`, SECRET, NOW), false);
});

test("accepts the signature when several v1 values are offered", async () => {
  // Providers send more than one MAC during a secret rotation; matching any is
  // correct, and it must not depend on which position the live one is in.
  const valid = await sign(BODY, NOW_SECONDS);
  assert.equal(
    await verifyCloverSignature(BODY, `t=${NOW_SECONDS},v1=${"0".repeat(64)},v1=${valid}`, SECRET, NOW),
    true,
  );
});

test("compares hex case-insensitively", async () => {
  const valid = await sign(BODY, NOW_SECONDS);
  assert.equal(
    await verifyCloverSignature(BODY, `t=${NOW_SECONDS},v1=${valid.toUpperCase()}`, SECRET, NOW),
    true,
  );
});
