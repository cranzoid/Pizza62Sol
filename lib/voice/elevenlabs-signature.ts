import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC over timestamp + '.' + the untouched bytes; tolerate delivery delay, not future replay. */
export function verifyElevenLabsSignature(secret: string, raw: Uint8Array, header: string | null, now = Date.now()): boolean {
  if (!secret || !header) return false;
  const parts = header.split(",").map((part) => part.trim());
  const timestamps = parts.filter((part) => part.startsWith("t="));
  const signatures = parts.filter((part) => part.startsWith("v0="));
  if (timestamps.length !== 1 || signatures.length < 1) return false;
  const timestamp = timestamps[0].slice(2);
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const age = now - Number(timestamp) * 1000;
  if (age > 30 * 60_000 || age < -60_000) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest();
  return signatures.some((part) => {
    const digest = part.slice(3);
    if (!/^[0-9a-fA-F]{64}$/.test(digest)) return false;
    return timingSafeEqual(expected, Buffer.from(digest, "hex"));
  });
}
