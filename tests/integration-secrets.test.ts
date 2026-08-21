/**
 * The encrypted credential store, and the email provider switch it feeds.
 *
 * This module is the reason the owner can configure Clover and Twilio without an
 * Azure login, so the properties worth pinning are the ones that make that safe
 * rather than merely convenient:
 *
 * - **Ciphertext at rest.** A database dump must not contain a Clover token, so
 *   the stored column is asserted not to equal — or contain — the plaintext.
 * - **Tampering is detected.** GCM authenticates; a modified ciphertext must fail
 *   to decrypt rather than decrypt to something else. And it must degrade to
 *   "not configured", not throw, because the alternative is a corrupted row
 *   taking down checkout.
 * - **Precedence is database-then-environment, and reversible.** Getting this
 *   backwards means the owner types a corrected token into the admin screen and
 *   a stale environment variable silently wins.
 * - **Plaintext never leaves.** The admin screen must be able to say *that* a key
 *   is set without being able to say what it is.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const {
  readIntegrationSecret,
  writeIntegrationSecret,
  describeIntegrationSecrets,
  clearIntegrationSecretCache,
  encryptionConfigured,
} = await import("@/lib/integration-secrets");
const { sendEmail } = await import("@/lib/notifications/channels");
const { emailConfig } = await import("@/lib/notifications/config");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

// A real 32-byte key, base64. Test-only; nothing outside this file uses it.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const realFetch = globalThis.fetch;

before(() => {
  process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY;
  clearIntegrationSecretCache();
});

/** Every test starts from no stored rows and no leftover environment values. */
async function reset(): Promise<void> {
  if (reachable) await getPool().query("DELETE FROM integration_secrets");
  for (const name of ["CLOVER_API_TOKEN", "CLOVER_MERCHANT_ID", "EMAIL_API_KEY", "EMAIL_FROM", "EMAIL_PROVIDER"]) {
    delete process.env[name];
  }
  process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY;
  clearIntegrationSecretCache();
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  await reset();
});

test("recognises a valid key and rejects a wrong-length one", () => {
  process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY;
  assert.equal(encryptionConfigured(), true);
  // Short keys are refused rather than padded — a padded key is a weak key.
  process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
  assert.equal(encryptionConfigured(), false);
  delete process.env.SETTINGS_ENCRYPTION_KEY;
  assert.equal(encryptionConfigured(), false);
  process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY;
});

withDb("stores ciphertext, not the credential", async () => {
  await reset();
  await writeIntegrationSecret("CLOVER_API_TOKEN", "super-secret-clover-token", "owner-1");

  const stored = await getPool().query<{ cipher_text: string; hint: string }>(
    "SELECT cipher_text, hint FROM integration_secrets WHERE key = 'CLOVER_API_TOKEN'",
  );
  assert.equal(stored.rows.length, 1);
  assert.notEqual(stored.rows[0].cipher_text, "super-secret-clover-token");
  assert.ok(
    !stored.rows[0].cipher_text.includes("clover-token"),
    "the plaintext must not be recoverable from the stored column",
  );
  // The hint is the last four characters, and only those.
  assert.equal(stored.rows[0].hint, "oken");

  clearIntegrationSecretCache();
  assert.equal(await readIntegrationSecret("CLOVER_API_TOKEN"), "super-secret-clover-token");
});

withDb("a fresh IV per write, so the same value never encrypts identically", async () => {
  await reset();
  await writeIntegrationSecret("CLOVER_API_TOKEN", "identical-value", "owner-1");
  const first = await getPool().query<{ cipher_text: string }>(
    "SELECT cipher_text FROM integration_secrets WHERE key = 'CLOVER_API_TOKEN'",
  );
  await writeIntegrationSecret("CLOVER_API_TOKEN", "identical-value", "owner-1");
  const second = await getPool().query<{ cipher_text: string }>(
    "SELECT cipher_text FROM integration_secrets WHERE key = 'CLOVER_API_TOKEN'",
  );
  // GCM's security collapses under IV reuse, and these rows are rewritten on
  // every rotation — so identical plaintext must still produce distinct rows.
  assert.notEqual(first.rows[0].cipher_text, second.rows[0].cipher_text);
});

withDb("the database wins over the environment, and deleting reveals it again", async () => {
  await reset();
  process.env.CLOVER_MERCHANT_ID = "FROM-ENVIRONMENT";
  clearIntegrationSecretCache();
  assert.equal(await readIntegrationSecret("CLOVER_MERCHANT_ID"), "FROM-ENVIRONMENT");

  // What the owner just typed must win. The opposite would mean their correction
  // is silently ignored in favour of a value they cannot see.
  await writeIntegrationSecret("CLOVER_MERCHANT_ID", "FROM-DATABASE", "owner-1");
  assert.equal(await readIntegrationSecret("CLOVER_MERCHANT_ID"), "FROM-DATABASE");

  // Clearing the field is the only way to "unset" it, and it must fall back
  // rather than leave a blank that reads as configured.
  await writeIntegrationSecret("CLOVER_MERCHANT_ID", "", "owner-1");
  assert.equal(await readIntegrationSecret("CLOVER_MERCHANT_ID"), "FROM-ENVIRONMENT");
});

withDb("a tampered ciphertext reads as unset rather than throwing", async () => {
  await reset();
  await writeIntegrationSecret("CLOVER_API_TOKEN", "authentic-token", "owner-1");
  // Flip the stored ciphertext. GCM must refuse it — the failure mode that
  // matters is that it does not decrypt to some other string.
  await getPool().query(
    "UPDATE integration_secrets SET cipher_text = $1 WHERE key = 'CLOVER_API_TOKEN'",
    [Buffer.from("not the real ciphertext at all").toString("base64")],
  );
  clearIntegrationSecretCache();
  assert.equal(await readIntegrationSecret("CLOVER_API_TOKEN"), null);

  // And it degrades to the environment fallback rather than taking the caller
  // down: a corrupted row must not break checkout for everyone.
  process.env.CLOVER_API_TOKEN = "environment-token";
  clearIntegrationSecretCache();
  assert.equal(await readIntegrationSecret("CLOVER_API_TOKEN"), "environment-token");
});

withDb("never returns a sensitive value to the admin screen", async () => {
  await reset();
  await writeIntegrationSecret("CLOVER_API_TOKEN", "super-secret-clover-token", "owner-1");
  await writeIntegrationSecret("CLOVER_ENVIRONMENT", "sandbox", "owner-1");

  const described = await describeIntegrationSecrets();
  const token = described.find((entry) => entry.key === "CLOVER_API_TOKEN");
  assert.ok(token);
  assert.equal(token.configured, true);
  assert.equal(token.source, "database");
  assert.equal(token.display, "••••oken");
  assert.ok(!JSON.stringify(described).includes("super-secret-clover-token"));

  // Non-secret configuration is shown in full, because checking it is the point.
  const environment = described.find((entry) => entry.key === "CLOVER_ENVIRONMENT");
  assert.equal(environment?.display, "sandbox");

  // And an unset key reports itself unset rather than pretending.
  const unset = described.find((entry) => entry.key === "TWILIO_AUTH_TOKEN");
  assert.equal(unset?.configured, false);
  assert.equal(unset?.source, "unset");
  assert.equal(unset?.display, null);
});

withDb("reports which side a value came from", async () => {
  await reset();
  process.env.EMAIL_FROM = "orders@pizza62.test";
  clearIntegrationSecretCache();
  const described = await describeIntegrationSecrets();
  const from = described.find((entry) => entry.key === "EMAIL_FROM");
  assert.equal(from?.source, "environment");
  assert.equal(from?.configured, true);
});

withDb("refuses to store a credential with no encryption key configured", async () => {
  await reset();
  delete process.env.SETTINGS_ENCRYPTION_KEY;
  clearIntegrationSecretCache();
  await assert.rejects(
    () => writeIntegrationSecret("CLOVER_API_TOKEN", "x", "owner-1"),
    /SETTINGS_ENCRYPTION_KEY is not configured/,
  );
  // Reads still work off the environment, so a deployment that never sets the
  // key keeps functioning exactly as it did before this module existed.
  process.env.CLOVER_API_TOKEN = "environment-token";
  clearIntegrationSecretCache();
  assert.equal(await readIntegrationSecret("CLOVER_API_TOKEN"), "environment-token");
  process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY;
});

test("refuses a key that is not a configurable credential", async () => {
  await assert.rejects(
    () => writeIntegrationSecret("DATABASE_URL" as never, "postgres://evil", "owner-1"),
    /not a configurable integration credential/,
  );
});

// --- the email provider switch ----------------------------------------------

/** Captures the outbound provider call instead of making it. */
function stubEmail(): { calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ id: "msg-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

test("defaults to Resend, including for an unrecognised provider name", async () => {
  process.env.EMAIL_API_KEY = "key";
  process.env.EMAIL_FROM = "orders@pizza62.test";
  clearIntegrationSecretCache();
  assert.equal((await emailConfig())?.provider, "resend");

  process.env.EMAIL_PROVIDER = "mailgun-typo";
  clearIntegrationSecretCache();
  assert.equal((await emailConfig())?.provider, "resend", "an unknown provider must not silently disable email");

  const { calls } = stubEmail();
  const result = await sendEmail({ to: "a@b.test", subject: "s", text: "t" });
  assert.equal(result.provider, "resend");
  assert.ok(calls[0].url.includes("api.resend.com"));
  assert.equal(result.reference, "msg-1");
});

test("routes to SendGrid when the owner selects it", async () => {
  process.env.EMAIL_API_KEY = "key";
  process.env.EMAIL_FROM = "orders@pizza62.test";
  process.env.EMAIL_PROVIDER = "SendGrid";
  clearIntegrationSecretCache();
  assert.equal((await emailConfig())?.provider, "sendgrid", "the setting is matched case-insensitively");

  const { calls } = stubEmail();
  const result = await sendEmail({ to: "a@b.test", subject: "s", text: "t" });
  assert.equal(result.provider, "sendgrid");
  assert.ok(calls[0].url.includes("api.sendgrid.com"));
});

test("reports email unconfigured until both the key and the sender are present", async () => {
  process.env.EMAIL_API_KEY = "key";
  clearIntegrationSecretCache();
  assert.equal(await emailConfig(), null, "an API key with no From address cannot send");
  process.env.EMAIL_FROM = "orders@pizza62.test";
  clearIntegrationSecretCache();
  assert.notEqual(await emailConfig(), null);
});
