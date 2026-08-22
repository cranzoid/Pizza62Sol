/**
 * Third-party credentials the owner can set from the admin screen.
 *
 * Why this exists at all: the Clover merchant ID, the Twilio token and the email
 * API key all arrive *after* the software does, usually while sitting with the
 * owner in the restaurant. Requiring an Azure login and a container restart to
 * paste them in makes that a developer task forever. Storing them here makes it
 * a five-minute job on the Integrations tab.
 *
 * ## The security shape
 *
 * Values are AES-256-GCM ciphertext under `SETTINGS_ENCRYPTION_KEY`, which lives
 * in Key Vault and is injected as an app setting — it is deliberately *not* in
 * the database. So a stolen database backup yields ciphertext and nothing else;
 * an attacker needs both the dump and the app's identity. GCM rather than CBC
 * because it authenticates: a tampered ciphertext fails to decrypt instead of
 * decrypting to something else.
 *
 * `hint` (last four characters, in clear) is stored on purpose. The admin screen
 * has to show *which* key is configured without showing the key, and deriving
 * that would otherwise mean decrypting every secret on every page load.
 *
 * ## Precedence: database first, environment second
 *
 * The database wins when a value is present there, because that is the surface
 * the owner just typed into — silently ignoring their input in favour of a stale
 * environment variable is the worst possible behaviour. The environment is the
 * fallback, which keeps three things working: a deployment that sets everything
 * in Key Vault and never touches the admin screen, local development with a
 * `.env.local`, and the offline test suites that set `process.env.CLOVER_*`
 * directly and must not need a database.
 *
 * A database that is unreachable is therefore not an error here — it falls back
 * to the environment and logs once. Payment credentials failing closed on a
 * transient database blip would take checkout down for no reason.
 */
import { getD1 } from "@/db/runtime";
import { env } from "@/lib/runtime-env";

/** Everything the owner can set from the Integrations tab. */
export const INTEGRATION_SECRET_KEYS = [
  "CLOVER_MERCHANT_ID",
  "CLOVER_API_TOKEN",
  // The browser half of the iframe key. It is designed to be public — it ships
  // in the page and identifies the merchant to Clover's SDK — but it is stored
  // and rotated with the others rather than hard-coded, because it changes when
  // the merchant regenerates the pair.
  "CLOVER_PUBLIC_TOKEN",
  "CLOVER_WEBHOOK_SECRET",
  "CLOVER_ENVIRONMENT",
  // Routes checkout through the inline card form instead of Clover's hosted
  // page. A stored flag rather than a build-time constant so it can be turned
  // off from the Integrations tab in the middle of a bad dinner service,
  // without a deploy.
  "CLOVER_IFRAME_ENABLED",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "RESTAURANT_ALERT_PHONE",
  "EMAIL_PROVIDER",
  "EMAIL_API_KEY",
  "EMAIL_FROM",
  "CUSTOMER_SMS_ENABLED",
  "VOICE_RETRY_LIMIT",
  "VOICE_RETRY_MINUTES",
  "PUBLIC_BASE_URL",
  // Shared with the Logic App that drives /api/cron/tick. Not a third-party
  // credential, but it belongs to the same "set once, rotate occasionally"
  // lifecycle and there is no reason for a second storage mechanism.
  "CRON_SECRET",
] as const;

export type IntegrationSecretKey = (typeof INTEGRATION_SECRET_KEYS)[number];

const KEY_SET = new Set<string>(INTEGRATION_SECRET_KEYS);

/**
 * Not every one of these is really a secret — `CLOVER_ENVIRONMENT` and
 * `EMAIL_FROM` are configuration. They are encrypted anyway rather than split
 * across two tables: one storage path is one thing to get right, and the cost of
 * encrypting a non-secret is nothing.
 *
 * These, though, are safe to echo back to an authenticated owner in full,
 * because seeing them is how you check them. Anything not listed is masked.
 */
const READABLE_IN_FULL = new Set<string>([
  "CLOVER_ENVIRONMENT",
  "CLOVER_MERCHANT_ID",
  "CLOVER_PUBLIC_TOKEN",
  "CLOVER_IFRAME_ENABLED",
  "TWILIO_FROM_NUMBER",
  "RESTAURANT_ALERT_PHONE",
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "CUSTOMER_SMS_ENABLED",
  "VOICE_RETRY_LIMIT",
  "VOICE_RETRY_MINUTES",
  "PUBLIC_BASE_URL",
]);

/**
 * Short-lived process cache — over the *database lookup only*, never over the
 * resolved value.
 *
 * The reason for a cache at all: the dispatcher reads Twilio credentials once
 * per outbox row and the webhook reads the signing secret on every delivery, so
 * an uncached read would put a query in front of each. Thirty seconds bounds how
 * long a credential change takes to propagate — long enough to be useful, short
 * enough that an owner who pastes a corrected token sees it work before they
 * think it is broken. Writes clear the entry immediately, so the delay only
 * applies across replicas.
 *
 * The reason it caches the *lookup* rather than the *answer*: reading an
 * environment variable costs nothing, so there is no benefit to caching that
 * half — and real harm in doing so. A cached env value goes stale in exactly the
 * situation where staleness is most confusing: a process whose environment
 * changed under it. That is every test that sets `process.env.CLOVER_*` between
 * two assertions, and it silently produced the *previous* answer.
 *
 * So the map stores what the database said (including "nothing"), and the
 * environment fallback is re-read on every call.
 */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { stored: string | null; expiresAt: number }>();
let databaseWarned = false;

type SecretRow = { cipher_text: string; iv: string; auth_tag: string };

function environmentValue(name: string): string | null {
  const raw = (env as unknown as Record<string, string | undefined>)[name];
  return raw && raw.trim() ? raw.trim() : null;
}

/**
 * The AES key, or null when none is configured.
 *
 * Accepts base64 or hex so whichever form `openssl rand` produced can be pasted
 * in without conversion. Anything that does not decode to exactly 32 bytes is
 * rejected rather than padded — a short key silently accepted is a weak key.
 */
function masterKey(): Buffer | null {
  const raw = environmentValue("SETTINGS_ENCRYPTION_KEY");
  if (!raw) return null;
  const decoded = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return decoded.length === 32 ? decoded : null;
}

export function encryptionConfigured(): boolean {
  return masterKey() !== null;
}

async function nodeCrypto() {
  return await import("node:crypto");
}

/** Reads the stored row, or null when there is none or the database is away. */
async function readRow(name: string): Promise<SecretRow | null> {
  try {
    return await getD1()
      .prepare("SELECT cipher_text, iv, auth_tag FROM integration_secrets WHERE key = ?")
      .bind(name)
      .first<SecretRow>();
  } catch (error) {
    // Deliberately not fatal — see the module header. Warn once so a genuinely
    // broken database is visible without one log line per notification.
    if (!databaseWarned) {
      databaseWarned = true;
      console.warn(
        `[integration-secrets] falling back to environment variables: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return null;
  }
}

/**
 * The one read path. Database first, environment second, null if neither has it.
 *
 * Returns null rather than throwing on a decryption failure: a corrupted row
 * should degrade to "this integration is not configured", which every caller
 * already handles, rather than taking down the route that asked.
 */
export async function readIntegrationSecret(name: IntegrationSecretKey | string): Promise<string | null> {
  return (await storedValue(name)) ?? environmentValue(name);
}

/** The decrypted database value, or null. Cached; see the note on `cache`. */
async function storedValue(name: string): Promise<string | null> {
  const cached = cache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.stored;

  let stored: string | null = null;
  const key = masterKey();
  if (key) {
    const row = await readRow(name);
    if (row) {
      try {
        const { createDecipheriv } = await nodeCrypto();
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
        decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
        const plain = Buffer.concat([
          decipher.update(Buffer.from(row.cipher_text, "base64")),
          decipher.final(),
        ]).toString("utf8");
        stored = plain.trim() ? plain.trim() : null;
      } catch (error) {
        // Authentication failure means the ciphertext or the key is wrong. Degrade
        // to "not configured", which every caller already handles, rather than
        // taking down the route that asked for it.
        console.error(
          `[integration-secrets] ${name} failed to decrypt — treating as unset: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        stored = null;
      }
    }
  }
  cache.set(name, { stored, expiresAt: Date.now() + CACHE_TTL_MS });
  return stored;
}

/** Convenience for the several flags stored as the string "true". */
export async function readIntegrationFlag(name: IntegrationSecretKey): Promise<boolean> {
  return (await readIntegrationSecret(name))?.toLowerCase() === "true";
}

/** Reads several at once without serialising the round trips. */
export async function readIntegrationSecrets<T extends readonly string[]>(
  names: T,
): Promise<Record<T[number], string | null>> {
  const values = await Promise.all(names.map((name) => readIntegrationSecret(name)));
  return Object.fromEntries(names.map((name, index) => [name, values[index]])) as Record<
    T[number],
    string | null
  >;
}

/**
 * Stores a credential. An empty value deletes the row so the environment
 * fallback becomes visible again, which is the only way to "unset" it.
 */
export async function writeIntegrationSecret(
  name: IntegrationSecretKey,
  value: string,
  actorId: string,
): Promise<void> {
  if (!KEY_SET.has(name)) throw new Error(`${name} is not a configurable integration credential.`);
  const key = masterKey();
  if (!key) {
    throw new Error(
      "SETTINGS_ENCRYPTION_KEY is not configured, so credentials cannot be stored. Set it in Key Vault first.",
    );
  }
  const trimmed = value.trim();
  cache.delete(name);

  if (!trimmed) {
    await getD1().prepare("DELETE FROM integration_secrets WHERE key = ?").bind(name).run();
    return;
  }
  if (trimmed.length > 4096) throw new Error("That value is too long to be a credential.");

  const { createCipheriv, randomBytes } = await nodeCrypto();
  // 96-bit IV, fresh per write: GCM's security collapses if one is reused under
  // the same key, and these rows are rewritten whenever a credential rotates.
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const cipherText = Buffer.concat([cipher.update(trimmed, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const now = Date.now();

  await getD1()
    .prepare(
      `INSERT INTO integration_secrets (key, cipher_text, iv, auth_tag, hint, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         cipher_text = excluded.cipher_text, iv = excluded.iv, auth_tag = excluded.auth_tag,
         hint = excluded.hint, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(
      name,
      cipherText.toString("base64"),
      iv.toString("base64"),
      authTag.toString("base64"),
      trimmed.slice(-4),
      actorId,
      now,
    )
    .run();
}

export type IntegrationSecretStatus = {
  key: string;
  configured: boolean;
  /** "database" when the owner set it here, "environment" when Key Vault did. */
  source: "database" | "environment" | "unset";
  /** Full value for non-sensitive settings, `••••1234` otherwise. */
  display: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
};

/**
 * What the admin screen renders. Never returns a masked secret's plaintext —
 * the point of the screen is to confirm *that* something is set, and to replace
 * it, not to read it back out.
 */
export async function describeIntegrationSecrets(): Promise<IntegrationSecretStatus[]> {
  let rows: Array<{ key: string; hint: string; updated_by: string; updated_at: number }> = [];
  try {
    const result = await getD1()
      .prepare("SELECT key, hint, updated_by, updated_at FROM integration_secrets")
      .all<{ key: string; hint: string; updated_by: string; updated_at: number }>();
    rows = result.results;
  } catch {
    rows = [];
  }
  const stored = new Map(rows.map((row) => [row.key, row]));

  return Promise.all(
    INTEGRATION_SECRET_KEYS.map(async (key) => {
      const row = stored.get(key);
      const fromEnvironment = environmentValue(key);
      const configured = Boolean(row) || Boolean(fromEnvironment);
      const source: IntegrationSecretStatus["source"] = row
        ? "database"
        : fromEnvironment
          ? "environment"
          : "unset";

      let display: string | null = null;
      if (configured) {
        if (READABLE_IN_FULL.has(key)) {
          display = await readIntegrationSecret(key);
        } else if (row?.hint) {
          display = `••••${row.hint}`;
        } else {
          display = "••••••••";
        }
      }
      return {
        key,
        configured,
        source,
        display,
        updatedAt: row ? Number(row.updated_at) : null,
        updatedBy: row?.updated_by ?? null,
      };
    }),
  );
}

/** Drops the process cache. Exported for tests and for the admin save path. */
export function clearIntegrationSecretCache(): void {
  cache.clear();
}
