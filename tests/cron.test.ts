/**
 * The background-work endpoint.
 *
 * On Container Apps the outbox sweeper, the payment reaper and the re-call sweep
 * were three scheduled Jobs. App Service has no equivalent, so they became one
 * authenticated endpoint a Logic App calls on a recurrence — which means the
 * work that keeps orders from being silently lost is now reachable over HTTP.
 *
 * So the tests are mostly about the door:
 *
 * - **It fails closed with no secret configured.** An open endpoint that
 *   dispatches notifications and places calls is a way to make the restaurant's
 *   phone ring from the internet, and "we have not set it up yet" is exactly
 *   when that would happen.
 * - **One failing sweep does not stop the others.** A Postgres hiccup in the
 *   reaper must not silence every notification for as long as it lasts — the
 *   notifications are the part customers can see.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { POST: cronRoute } = await import("@/app/api/cron/tick/route");
const { clearIntegrationSecretCache } = await import("@/lib/integration-secrets");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const SECRET = "cron-secret-for-tests-0123456789";

afterEach(() => {
  delete process.env.CRON_SECRET;
  clearIntegrationSecretCache();
});

const tick = (authorization?: string) =>
  cronRoute(
    new Request("https://order.pizza62.test/api/cron/tick", {
      method: "POST",
      headers: authorization ? { authorization } : {},
    }),
  );

withDb("refuses to run when no secret is configured", async () => {
  // The dangerous default. Anything other than failing closed means a fresh
  // deployment has an unauthenticated endpoint that can phone the restaurant.
  delete process.env.CRON_SECRET;
  clearIntegrationSecretCache();
  assert.equal((await tick(`Bearer ${SECRET}`)).status, 401);
  assert.equal((await tick()).status, 401);
});

withDb("refuses a missing, wrong or empty secret", async () => {
  process.env.CRON_SECRET = SECRET;
  clearIntegrationSecretCache();
  assert.equal((await tick()).status, 401);
  assert.equal((await tick("Bearer wrong-secret")).status, 401);
  assert.equal((await tick("Bearer ")).status, 401);
  // A prefix of the real secret must not pass — the comparison checks length
  // first, and then every character.
  assert.equal((await tick(`Bearer ${SECRET.slice(0, -1)}`)).status, 401);
});

withDb("accepts the secret with or without the Bearer prefix", async () => {
  // Logic App HTTP actions are hand-configured, and both forms get typed.
  process.env.CRON_SECRET = SECRET;
  clearIntegrationSecretCache();
  assert.equal((await tick(`Bearer ${SECRET}`)).status, 200);
  assert.equal((await tick(SECRET)).status, 200);
});

withDb("runs all three sweeps and reports what each did", async () => {
  process.env.CRON_SECRET = SECRET;
  clearIntegrationSecretCache();
  const response = await tick(`Bearer ${SECRET}`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.deepEqual(body.failures, []);
  // Each sweep reports separately, so a persistently idle one is visible in the
  // Logic App run history rather than hidden behind an overall "ok".
  assert.ok(body.outbox);
  assert.ok(body.payments);
  assert.ok(body.unacknowledged);
  assert.equal(typeof body.durationMs, "number");
});

withDb("is safe to run twice in a row", async () => {
  // It is called every minute, and a slow tick can overlap the next one. Every
  // mutation is guarded on the state it expects, so this must be a no-op.
  process.env.CRON_SECRET = SECRET;
  clearIntegrationSecretCache();
  assert.equal((await tick(`Bearer ${SECRET}`)).status, 200);
  const second = await tick(`Bearer ${SECRET}`);
  assert.equal(second.status, 200);
  assert.equal(((await second.json()) as { ok: boolean }).ok, true);
});
