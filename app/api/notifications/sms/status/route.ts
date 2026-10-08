/** Signed Twilio delivery receipts. Provider acceptance alone is not delivery. */
import { getD1 } from "@/db/runtime";
import { verifyTwilioSignature } from "@/app/api/notifications/voice/ack/route";
import { twilioConfig } from "@/lib/notifications/config";

const STATES = ["accepted", "queued", "sending", "sent", "failed", "undelivered", "delivered"];

export async function POST(request: Request) {
  const config = await twilioConfig();
  if (!config) return new Response("SMS is not configured.", { status: 503 });
  const params = Object.fromEntries(new URLSearchParams(await request.text()));
  if (!verifyTwilioSignature(config.authToken, request.url, params, request.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature.", { status: 403 });
  }
  const id = new URL(request.url).searchParams.get("id");
  const status = params.MessageStatus;
  if (!id || !params.MessageSid || !STATES.includes(status)) return new Response(null, { status: 204 });
  // A delayed 'sent' receipt cannot undo 'delivered' or a terminal failure.
  await getD1().prepare(`UPDATE notification_outbox SET provider_reference = ?, delivery_status = ?, delivery_error = ?, updated_at = ?
    WHERE id = ? AND kind = 'giveaway_nudge_sms'
      AND (provider_reference IS NULL OR provider_reference = ?)
      AND (delivery_status IS NULL OR array_position(?::text[], delivery_status) <= array_position(?::text[], ?))`)
    .bind(params.MessageSid, status, params.ErrorCode ? `Twilio error ${params.ErrorCode.slice(0, 20)}` : null,
      Date.now(), id, params.MessageSid, STATES, STATES, status).run();
  return new Response(null, { status: 204 });
}
