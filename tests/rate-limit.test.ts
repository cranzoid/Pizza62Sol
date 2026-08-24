/**
 * Rate limiter behaviour.
 *
 * The limiter decides whether a caller may place an order, log in, or submit
 * feedback, so both halves of it are load-bearing: the identity it buckets on,
 * and the counter it keeps. The counter is now a single `ON CONFLICT DO UPDATE
 * … RETURNING` statement so that concurrent replicas cannot all read the same
 * pre-increment value and all pass — which means the SQL has to be exercised
 * against a real Postgres, not just typechecked.
 *
 * Requires a reachable Postgres; skipped otherwise, like the driver suite.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { enforceRateLimit, resolveClientIdentity, RateLimitError } = await import("@/lib/security");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const requestFrom = (headers: Record<string, string>) =>
  new Request("https://order.pizza62.test/api/orders", { headers });

// --- identity ---------------------------------------------------------------

test("prefers the Front Door client IP over the forwarded chain", () => {
  // With Front Door in front, the ingress appends Front Door's own edge address
  // to X-Forwarded-For. Trusting that would put every visitor in one bucket.
  const identity = resolveClientIdentity(
    requestFrom({
      "x-azure-clientip": "203.0.113.7",
      "x-forwarded-for": "203.0.113.7, 10.20.0.4",
    }),
  );
  assert.equal(identity, "203.0.113.7");
});

test("takes the last forwarded hop, not the first", () => {
  // The leftmost entry is whatever the caller sent. Trusting it lets anyone mint
  // an unlimited number of buckets by varying a header.
  const identity = resolveClientIdentity(
    requestFrom({ "x-forwarded-for": "1.2.3.4, 198.51.100.9" }),
  );
  assert.equal(identity, "198.51.100.9");
});

test("strips a port from the forwarded address", () => {
  const identity = resolveClientIdentity(requestFrom({ "x-forwarded-for": "198.51.100.9:41234" }));
  assert.equal(identity, "198.51.100.9");
});

test("reports no identity when nothing trustworthy is present", () => {
  assert.equal(resolveClientIdentity(requestFrom({})), null);
});

// --- counting ---------------------------------------------------------------

withDb("allows exactly the budgeted number of attempts, then denies", async () => {
  const scope = `test-budget-${Date.now()}`;
  const request = requestFrom({ "x-azure-clientip": "203.0.113.21" });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await enforceRateLimit(request, scope, 3, 60_000);
  }

  await assert.rejects(() => enforceRateLimit(request, scope, 3, 60_000), RateLimitError);
});

withDb("buckets each client address separately", async () => {
  const scope = `test-isolation-${Date.now()}`;
  const first = requestFrom({ "x-azure-clientip": "203.0.113.31" });
  const second = requestFrom({ "x-azure-clientip": "203.0.113.32" });

  await enforceRateLimit(first, scope, 1, 60_000);
  await assert.rejects(() => enforceRateLimit(first, scope, 1, 60_000), RateLimitError);

  // The regression this guards: one visitor exhausting the budget for everyone.
  await enforceRateLimit(second, scope, 1, 60_000);
});

withDb("keeps separate budgets per scope", async () => {
  const scope = `test-scope-${Date.now()}`;
  const request = requestFrom({ "x-azure-clientip": "203.0.113.41" });

  await enforceRateLimit(request, `${scope}-login`, 1, 60_000);
  await enforceRateLimit(request, `${scope}-orders`, 1, 60_000);
  await assert.rejects(() => enforceRateLimit(request, `${scope}-login`, 1, 60_000), RateLimitError);
});

withDb("starts a fresh window once the old one has elapsed", async () => {
  const scope = `test-window-${Date.now()}`;
  const request = requestFrom({ "x-azure-clientip": "203.0.113.51" });

  // A zero-length window is always already expired, so the reset arm of the
  // CASE runs on every call and the caller is never denied.
  await enforceRateLimit(request, scope, 1, 0);
  await enforceRateLimit(request, scope, 1, 0);
  await enforceRateLimit(request, scope, 1, 0);
});

withDb("counts concurrent attempts exactly once each", async () => {
  // The regression this guards: the previous read-then-write pair let N parallel
  // requests all observe the same pre-increment count and all pass. On Container
  // Apps those requests land on different replicas, so only the database can
  // settle it.
  const scope = `test-concurrent-${Date.now()}`;
  const request = requestFrom({ "x-azure-clientip": "203.0.113.61" });

  const outcomes = await Promise.allSettled(
    Array.from({ length: 10 }, () => enforceRateLimit(request, scope, 4, 60_000)),
  );

  const allowed = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
  assert.equal(allowed, 4, "exactly the budgeted number of concurrent attempts should be allowed");
});

withDb("fails closed behind a proxy when no trusted header is present", async () => {
  // The deployment asserts that an ingress always stamps the client address, so
  // a request without one bypassed it and cannot be identified. Serving it on a
  // shared key is what the old "local" fallback did.
  const previous = process.env.TRUST_PROXY_HEADERS;
  process.env.TRUST_PROXY_HEADERS = "true";
  try {
    await assert.rejects(
      () => enforceRateLimit(requestFrom({}), `test-closed-${Date.now()}`, 5, 60_000),
      RateLimitError,
    );
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = previous;
  }
});

withDb("serves direct callers on a fixed identity when no proxy is declared", async () => {
  // Local runs and tests have no proxy in front of them; refusing every request
  // would make the app impossible to run outside Azure.
  const previous = process.env.TRUST_PROXY_HEADERS;
  delete process.env.TRUST_PROXY_HEADERS;
  try {
    await enforceRateLimit(requestFrom({}), `test-direct-${Date.now()}`, 2, 60_000);
  } finally {
    if (previous !== undefined) process.env.TRUST_PROXY_HEADERS = previous;
  }
});
