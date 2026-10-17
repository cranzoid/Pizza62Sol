/**
 * What may be written to the voice event log.
 *
 * The agent is instructed never to take a card, and no tool accepts one — but
 * a caller can read their card number out anyway, and speech-to-text will
 * faithfully write it into whatever the model sends next ("notes", a
 * confirmation utterance). So everything logged passes through here first:
 *
 * - any run of 13 to 19 digits (allowing spaces and dashes between them) is a
 *   possible card number and is replaced, whatever field it is in;
 * - a 3–4 digit code after "cvv", "cvc" or "security code", and an expiry after
 *   "exp"/"expiry", are replaced;
 * - phone numbers keep their last four digits, enough to tell two calls apart
 *   in a log and not enough to ring anyone.
 *
 * Applied to logs and to the stored confirmation utterance. It is a net, not
 * the only defence: the tools never ask for payment details at all.
 */

const CARD_RUN = /\b(?:\d[ -]?){12,18}\d\b/g;
const SECURITY_CODE = /\b(cvv2?|cvc2?|security\s*code|card\s*code)\b[^0-9]{0,12}\d{3,4}\b/gi;
const EXPIRY = /\b(exp(?:iry|ires|iration)?(?:\s*date)?)\b[^0-9]{0,12}\d{1,2}\s*[/-]\s*\d{2,4}\b/gi;

/** Free text with anything card-like removed. */
export function redactText(value: string): string {
  return value
    .replace(CARD_RUN, "[redacted number]")
    .replace(SECURITY_CODE, (_match, label: string) => `${label} [redacted]`)
    .replace(EXPIRY, (_match, label: string) => `${label} [redacted]`);
}

/** True when text carries something that looks like a card number, security code or expiry. */
export function containsPaymentDetails(value: string): boolean {
  return redactText(value) !== value;
}

const PHONE_SHAPED = /(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]?\d{3}[ .-]?(\d{4})\b/g;

/** Free text with card-like numbers removed and phone-shaped numbers cut to their last four digits. */
export function redactForLogText(value: string): string {
  return redactText(value).replace(PHONE_SHAPED, (_match, last: string) => `…${last}`);
}

/** A phone number reduced to its last four digits. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : "…";
}

const PHONE_KEYS = new Set(["phone", "callerPhone", "customerPhone", "customer_phone", "caller_phone", "customerPhoneToConfirm"]);

/** A deep copy safe to log: card-like text removed everywhere, phone numbers masked. */
export function redactForLog(value: unknown, key = ""): unknown {
  if (typeof value === "string") return PHONE_KEYS.has(key) ? maskPhone(value) : redactForLogText(value);
  if (typeof value === "number" && PHONE_KEYS.has(key)) return maskPhone(String(value));
  if (Array.isArray(value)) return value.map((entry) => redactForLog(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([field, entry]) => [field, redactForLog(entry, field)]));
  }
  return value;
}
