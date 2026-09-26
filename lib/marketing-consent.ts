/**
 * Who may be sent marketing email, and the unsubscribe link every one carries.
 *
 * **Why this exists.** An order confirmation is a transactional message; a
 * "the giveaway is on, come and order" email to someone who ordered in June is
 * a commercial electronic message under Canada's Anti-Spam Legislation (CASL).
 * Past customers are fine to write to — a purchase in the last two years is
 * implied consent — but every such message must identify the sender, give a
 * postal address, and carry an unsubscribe that works and is honoured. The
 * email template supplies the first two; this file is the third.
 *
 * **The link carries a signature, not a stored token.** `e` is the address and
 * `t` is an HMAC of it under a key that lives in the database. Nothing has to be
 * written per recipient before a send, a link cannot be edited to unsubscribe
 * somebody else, and one that is forwarded unsubscribes only the person it was
 * sent to. The worst anyone holding the key could do is unsubscribe people.
 *
 * **Visiting the link does not unsubscribe.** It opens a page with a button.
 * Corporate mail filters (Outlook Safe Links, Mimecast) fetch every link in a
 * message to scan it, and a GET that acted would unsubscribe people who never
 * clicked. The one-click path mail clients use (RFC 8058) is a POST, which
 * scanners do not send.
 *
 * **An opt-out is permanent here.** Importing a customer list never clears
 * one, and nothing in this codebase sends marketing to an address that has it.
 */
import { getD1 } from "@/db/runtime";

const KEY_SETTING = "marketingUnsubscribeKey";

let cachedKey: Promise<CryptoKey> | null = null;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): string | null {
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * The signing key, created on first use.
 *
 * Kept in `settings` rather than the environment so it is the same on both
 * slots and survives a restart without anyone provisioning it. The insert
 * ignores a conflict, so two processes racing to create it agree on whichever
 * committed first.
 */
async function signingKey(): Promise<CryptoKey> {
  cachedKey ??= (async () => {
    const fresh = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    await getD1()
      .prepare("INSERT INTO settings (key, value_json, version, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT (key) DO NOTHING")
      .bind(KEY_SETTING, JSON.stringify({ key: fresh }), Date.now())
      .run();
    const row = await getD1()
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .bind(KEY_SETTING)
      .first<{ value_json: string }>();
    const secret = (JSON.parse(row?.value_json ?? "{}") as { key?: string }).key;
    if (!secret) throw new Error("The unsubscribe signing key could not be created.");
    return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  })();
  try {
    return await cachedKey;
  } catch (error) {
    cachedKey = null;
    throw error;
  }
}

/** Settings rows that must never be shown on a staff screen. */
export const PRIVATE_SETTING_KEYS = new Set([KEY_SETTING]);

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export async function unsubscribeToken(email: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await signingKey(), new TextEncoder().encode(normalizeEmail(email)));
  // 128 bits is far more than enough to make guessing pointless.
  return base64Url(new Uint8Array(signature)).slice(0, 22);
}

/** The query string both the page and the one-click endpoint accept. */
export async function unsubscribeQuery(email: string): Promise<string> {
  const clean = normalizeEmail(email);
  return `e=${base64Url(new TextEncoder().encode(clean))}&t=${await unsubscribeToken(clean)}`;
}

/** The address a valid link was issued to, or null for anything else. */
export async function verifyUnsubscribe(encodedEmail: string | null, token: string | null): Promise<string | null> {
  if (!encodedEmail || !token || token.length !== 22) return null;
  const email = fromBase64Url(encodedEmail);
  if (!email || email.length > 254 || !email.includes("@")) return null;
  const expected = await unsubscribeToken(email);
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ token.charCodeAt(index);
  }
  return difference === 0 ? normalizeEmail(email) : null;
}

/**
 * Records that an address wants no more marketing email.
 *
 * Upserts into `customer_contacts` so the opt-out survives whatever else
 * happens to the address. The earliest opt-out time is kept: it is the date
 * the obligation began.
 */
export async function recordOptOut(email: string, now: number = Date.now()): Promise<void> {
  const clean = normalizeEmail(email);
  if (!clean) return;
  await getD1()
    .prepare(
      `INSERT INTO customer_contacts (id, email, name, source, marketing_opt_out_at, created_at, updated_at)
       VALUES (?, ?, '', 'unsubscribe', ?, ?, ?)
       ON CONFLICT (email) WHERE email IS NOT NULL DO UPDATE SET
         marketing_opt_out_at = COALESCE(customer_contacts.marketing_opt_out_at, EXCLUDED.marketing_opt_out_at),
         updated_at = EXCLUDED.updated_at`,
    )
    .bind(crypto.randomUUID(), clean, now, now, now)
    .run();
}

export async function isOptedOut(email: string): Promise<boolean> {
  const row = await getD1()
    .prepare("SELECT 1 AS present FROM customer_contacts WHERE email = ? AND marketing_opt_out_at IS NOT NULL")
    .bind(normalizeEmail(email))
    .first<{ present: number }>();
  return Boolean(row);
}
