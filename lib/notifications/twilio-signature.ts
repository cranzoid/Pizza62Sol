import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio signs `URL + sorted(key + value)` with HMAC-SHA1, base64-encoded.
 *
 * The URL must be exactly the one Twilio requested, query string included —
 * which is why the ack callback carries `?order=` rather than putting the id in
 * the body: it has to be part of the signed material either way, and in the URL
 * it cannot be swapped without breaking the signature.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const material = Object.keys(params)
    .sort()
    .reduce((accumulator, key) => accumulator + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(material, "utf8")).digest("base64");
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  header: string | null,
): boolean {
  if (!header) return false;
  const expected = twilioSignature(authToken, url, params);
  const provided = Buffer.from(header);
  const computed = Buffer.from(expected);
  return provided.length === computed.length && timingSafeEqual(provided, computed);
}
