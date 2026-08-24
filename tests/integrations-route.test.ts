/**
 * The Integrations admin route.
 *
 * This route accepts payment and messaging credentials over HTTP and stores
 * them, so its tests are mostly about what must *not* happen: an employee must
 * not reach it, a stored secret must not come back out, and a malformed value
 * must not be accepted and then fail silently at 9pm on a Friday.
 *
 * The validation tests are not pedantry. `CLOVER_ENVIRONMENT: "prod"` is the
 * expensive one — the environment defaults to sandbox precisely so a typo is
 * safe, which also makes a typo invisible. It has to be rejected at the door.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { createPasswordHash } = await import("@/lib/auth");
const { POST: loginRoute } = await import("@/app/api/auth/login/route");
const { GET: integrationsGet, POST: integrationsPost } = await import("@/app/api/admin/integrations/route");
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

// Trap 7: rate-limit budgets live in the database and outlive a test run, so
// client identities are seeded per run rather than from a bare counter.
const RUN = crypto.randomUUID().slice(0, 8);
let counter = 0;
const nextClientIp = () => `198.51.100.${(counter += 1) % 250}-${RUN}`;

const PASSWORD = "Correct Horse Battery Staple 62";
const TEST_KEY = Buffer.alloc(32, 11).toString("base64");

before(() => {
  process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY;
  clearIntegrationSecretCache();
});

afterEach(async () => {
  if (reachable) {
    await getPool().query("DELETE FROM integration_secrets");
    await getPool().query("DELETE FROM audit_log WHERE target_type = 'integration_secret'");
  }
  process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY;
  clearIntegrationSecretCache();
});

async function signedInAs(role: "owner" | "manager" | "employee", permissions: string[] = []): Promise<string> {
  const id = crypto.randomUUID();
  const email = `int-${id}@example.test`;
  const hash = await createPasswordHash(PASSWORD);
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_users
     (id, email, name, role, password_hash, password_salt, password_iterations, permissions_json, active, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$9)`,
    [id, email, "Integrations Tester", role, hash.hash, hash.salt, hash.iterations, JSON.stringify(permissions), now],
  );
  const response = await loginRoute(
    new Request("https://order.pizza62.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-azure-clientip": nextClientIp() },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  assert.equal(response.status, 200, "the test operator should be able to sign in");
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

const get = (cookie: string) =>
  integrationsGet(new Request("https://order.pizza62.test/api/admin/integrations", { headers: { cookie } }));

const post = (cookie: string, body: unknown) =>
  integrationsPost(
    new Request("https://order.pizza62.test/api/admin/integrations", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

// --- who may reach it -------------------------------------------------------

withDb("refuses an unauthenticated caller", async () => {
  assert.equal((await get("")).status, 401);
  assert.equal((await post("", { action: "secret.set", key: "CLOVER_API_TOKEN", value: "x" })).status, 401);
});

withDb("refuses an employee who can see orders but not manage settings", async () => {
  // The distinction that matters: `view_orders` gets you the dashboard, and must
  // not get you the payment credentials behind it.
  const cookie = await signedInAs("employee", ["view_orders"]);
  assert.equal((await get(cookie)).status, 403);
  assert.equal(
    (await post(cookie, { action: "secret.set", key: "CLOVER_API_TOKEN", value: "x" })).status,
    403,
  );
});

withDb("admits a manager holding manage_settings", async () => {
  const cookie = await signedInAs("manager", ["view_orders", "manage_settings"]);
  assert.equal((await get(cookie)).status, 200);
});

// --- what comes back --------------------------------------------------------

withDb("never returns a stored secret, only that one exists", async () => {
  const cookie = await signedInAs("owner");
  const saved = await post(cookie, {
    action: "secret.set",
    key: "CLOVER_API_TOKEN",
    value: "clover-private-token-abcd",
  });
  assert.equal(saved.status, 200);

  const response = await get(cookie);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!body.includes("clover-private-token-abcd"), "the response must not carry the credential");
  assert.ok(body.includes("••••abcd"), "but it must show enough to identify which credential is stored");
});

withDb("reports readiness in terms of what works, not which variable is set", async () => {
  const cookie = await signedInAs("owner");
  await post(cookie, { action: "secret.set", key: "CLOVER_MERCHANT_ID", value: "MERCHANT1" });
  await post(cookie, { action: "secret.set", key: "CLOVER_API_TOKEN", value: "token" });

  const half = (await (await get(cookie)).json()) as { readiness: Record<string, unknown> };
  // A session you can create but no way to trust the payment notice: money can
  // be taken and never confirmed, so this is deliberately not "ready".
  assert.equal(half.readiness.cloverCheckout, true);
  assert.equal(half.readiness.cloverWebhook, false);
  assert.equal(half.readiness.onlinePayment, false);

  await post(cookie, { action: "secret.set", key: "CLOVER_WEBHOOK_SECRET", value: "signing-secret" });
  const full = (await (await get(cookie)).json()) as { readiness: Record<string, unknown> };
  assert.equal(full.readiness.onlinePayment, true);
});

withDb("builds the dashboard callback URLs from the public base URL", async () => {
  const cookie = await signedInAs("owner");
  await post(cookie, { action: "secret.set", key: "PUBLIC_BASE_URL", value: "https://order.pizza62.ca" });
  const body = (await (await get(cookie)).json()) as { callbacks: Record<string, string> | null };
  assert.deepEqual(body.callbacks, {
    cloverWebhook: "https://order.pizza62.ca/api/payments/clover/webhook",
    cloverReturn: "https://order.pizza62.ca/order/return",
    twilioVoiceAck: "https://order.pizza62.ca/api/notifications/voice/ack",
  });
});

// --- validation -------------------------------------------------------------

withDb("rejects values that would fail silently rather than loudly", async () => {
  const cookie = await signedInAs("owner");
  const rejected = async (key: string, value: string) => {
    const response = await post(cookie, { action: "secret.set", key, value });
    assert.equal(response.status, 400, `${key}=${value} should have been refused`);
  };

  // The expensive one: anything but "production" means sandbox, so a typo here
  // is a store that believes it is live and is quietly taking test cards.
  await rejected("CLOVER_ENVIRONMENT", "prod");
  await rejected("EMAIL_PROVIDER", "mailchimp");
  // Twilio requires E.164. A local-format number is accepted by nothing.
  await rejected("TWILIO_FROM_NUMBER", "905-547-5777");
  await rejected("RESTAURANT_ALERT_PHONE", "9055475777");
  await rejected("TWILIO_ACCOUNT_SID", "not-a-sid");
  await rejected("EMAIL_FROM", "not-an-address");
  await rejected("PUBLIC_BASE_URL", "order.pizza62.ca");
  await rejected("VOICE_RETRY_LIMIT", "many");
});

withDb("accepts the correct forms of the values it just refused", async () => {
  const cookie = await signedInAs("owner");
  const accepted = async (key: string, value: string) => {
    const response = await post(cookie, { action: "secret.set", key, value });
    assert.equal(response.status, 200, `${key}=${value} should have been accepted`);
  };
  await accepted("CLOVER_ENVIRONMENT", "production");
  await accepted("EMAIL_PROVIDER", "sendgrid");
  await accepted("TWILIO_FROM_NUMBER", "+19055550100");
  await accepted("TWILIO_ACCOUNT_SID", `AC${"a".repeat(32)}`);
  await accepted("EMAIL_FROM", "orders@pizza62.ca");
  await accepted("PUBLIC_BASE_URL", "https://order.pizza62.ca");
  await accepted("VOICE_RETRY_LIMIT", "5");
});

withDb("refuses to write anything that is not a known credential", async () => {
  const cookie = await signedInAs("owner");
  // The store rejects this too, but the route must not depend on that — an
  // arbitrary key reaching the writer is how a settings screen becomes a
  // write-anywhere primitive.
  const response = await post(cookie, { action: "secret.set", key: "DATABASE_URL", value: "postgres://evil" });
  assert.equal(response.status, 400);
});

withDb("refuses to store credentials when there is no encryption key", async () => {
  const cookie = await signedInAs("owner");
  delete process.env.SETTINGS_ENCRYPTION_KEY;
  clearIntegrationSecretCache();
  const response = await post(cookie, { action: "secret.set", key: "CLOVER_API_TOKEN", value: "x" });
  assert.equal(response.status, 409, "storing a secret with nothing to encrypt it with must fail closed");
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /SETTINGS_ENCRYPTION_KEY/);
  process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY;
});

withDb("records who changed a credential, and never the value", async () => {
  const cookie = await signedInAs("owner");
  await post(cookie, { action: "secret.set", key: "CLOVER_API_TOKEN", value: "audit-me-please" });

  const audit = await getPool().query<{ action: string; target_id: string; next_json: string | null }>(
    "SELECT action, target_id, next_json FROM audit_log WHERE target_type = 'integration_secret' ORDER BY created_at DESC LIMIT 1",
  );
  assert.equal(audit.rows[0].action, "integration.secret.set");
  assert.equal(audit.rows[0].target_id, "CLOVER_API_TOKEN");
  // An audit trail containing the credential defeats encrypting it at rest.
  assert.ok(!JSON.stringify(audit.rows[0]).includes("audit-me-please"));
});

withDb("clearing a credential is audited distinctly from setting one", async () => {
  const cookie = await signedInAs("owner");
  await post(cookie, { action: "secret.set", key: "CLOVER_API_TOKEN", value: "temporary" });
  await post(cookie, { action: "secret.set", key: "CLOVER_API_TOKEN", value: "" });
  const audit = await getPool().query<{ action: string }>(
    `SELECT action FROM audit_log
     WHERE target_type = 'integration_secret' AND target_id = 'CLOVER_API_TOKEN'
     ORDER BY action`,
  );
  assert.deepEqual(
    audit.rows.map((row) => row.action),
    ["integration.secret.cleared", "integration.secret.set"],
  );
});

withDb("will not run a test send for a channel with no credentials", async () => {
  const cookie = await signedInAs("owner");
  const response = await post(cookie, { action: "test.email" });
  // 409, not 502: nothing failed, there is simply nothing configured yet.
  assert.equal(response.status, 409);
});
