import { readIntegrationSecret } from "@/lib/integration-secrets";
import { verifyTwilioSignature } from "@/lib/notifications/twilio-signature";

export const CALL_SID = /^CA[0-9a-fA-F]{32}$/;

/** Read a bounded body even when Content-Length is absent or untrusted. */
export async function voiceWebhookBody(request: Request, limit: number): Promise<Buffer | Response> {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return new Response("Webhook too large.", { status: 413 });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** All signed fields are included; duplicate fields are ambiguous and refused. */
export async function signedTwilioForm(request: Request): Promise<Record<string, string> | Response> {
  const token = await readIntegrationSecret("TWILIO_AUTH_TOKEN");
  if (!token) return new Response("Voice is not configured.", { status: 503 });
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/x-www-form-urlencoded") {
    return new Response("Expected a Twilio form.", { status: 415 });
  }
  const raw = await voiceWebhookBody(request, 16_384);
  if (raw instanceof Response) return raw;
  const form = new URLSearchParams(raw.toString("utf8"));
  const params = Object.fromEntries(form);
  if ([...form.keys()].length !== Object.keys(params).length) return new Response("Duplicate form fields.", { status: 400 });
  // Exact URL, including query, as in the existing acknowledgement webhook.
  // Never build the signing URL from caller-controlled proxy headers.
  if (!verifyTwilioSignature(token, request.url, params, request.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature.", { status: 403 });
  }
  return params;
}

export function voiceXml(xml: string): Response {
  return new Response(xml, { headers: { "content-type": "text/xml", "cache-control": "no-store" } });
}

export function voiceFallback(): Response {
  return voiceXml('<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice" language="en-CA">Sorry, the automated assistant is temporarily unavailable. Please try again.</Say><Hangup/></Response>');
}
