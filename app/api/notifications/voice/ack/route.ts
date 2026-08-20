/**
 * Twilio's `<Gather>` callback — the restaurant pressing 1 to acknowledge.
 *
 * This is the only endpoint Twilio calls, and it is publicly reachable, so it
 * verifies Twilio's own signature before writing anything. Without that check
 * anyone who guessed the URL could silence the escalation calls for an order the
 * kitchen has never seen — which is precisely the failure the calls exist to
 * prevent.
 *
 * It writes `orders.acknowledged_at`, the same field the Acknowledge button on
 * the staff dashboard writes. One field, two ways to set it, no second state to
 * keep in sync: acknowledging on the kitchen screen stops the phone ringing, and
 * pressing 1 clears the banner on the screen.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { ensureDatabase, getD1 } from "@/db/runtime";
import { twilioConfig } from "@/lib/notifications/config";

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

/** TwiML, since Twilio reads the response of a Gather callback as more TwiML. */
function say(message: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice" language="en-CA">${message}</Say></Response>`,
    { headers: { "content-type": "text/xml" } },
  );
}

export async function POST(request: Request) {
  const config = twilioConfig();
  if (!config) return new Response("Voice is not configured.", { status: 503 });

  const raw = await request.text();
  const params = Object.fromEntries(new URLSearchParams(raw));

  // The URL Twilio signed is the one it was given, which is built from
  // PUBLIC_BASE_URL — not necessarily what the ingress reports here. Signing
  // over the request URL as received is correct when they agree and is what
  // Twilio documents; a mismatch shows up as a rejected signature rather than as
  // a silently accepted forgery.
  if (!verifyTwilioSignature(config.authToken, request.url, params, request.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature.", { status: 403 });
  }

  const orderId = new URL(request.url).searchParams.get("order") ?? "";
  const digits = params.Digits ?? "";
  if (digits !== "1") {
    // Any other key is treated as "not acknowledged", so the sweep will call
    // again. Saying so out loud is better than a silent hang-up.
    return say("No acknowledgement received. We will call again shortly.");
  }
  if (!orderId) return say("That order could not be identified.");

  await ensureDatabase();
  const now = Date.now();
  const result = await getD1()
    .prepare("UPDATE orders SET acknowledged_at = ?, updated_at = ? WHERE id = ? AND acknowledged_at IS NULL")
    .bind(now, now, orderId)
    .run();

  if (result.meta.changes) {
    await getD1()
      .prepare(
        `INSERT INTO order_events (id, order_id, previous_status, next_status, actor_type, actor_id, note, created_at)
         SELECT ?, id, status, status, 'restaurant', NULL, 'Acknowledged by phone', ? FROM orders WHERE id = ?`,
      )
      .bind(crypto.randomUUID(), now, orderId)
      .run();
  }
  return say("Thank you. The order is acknowledged.");
}
