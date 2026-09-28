/**
 * Twilio's inbound-SMS webhook: where replies to our texts arrive.
 *
 * It exists for one job — honouring STOP. A marketing text is a commercial
 * electronic message under CASL, and the unsubscribe it promises ("Reply STOP
 * to opt out") has to work and be recorded here, not only inside Twilio: the
 * audience query and the dispatcher both read `customer_contacts.sms_opt_out_at`,
 * and a STOP that only Twilio knew about would leave us queueing texts to a
 * number that asked us not to.
 *
 * Publicly reachable, so it verifies Twilio's signature before writing
 * anything — otherwise anyone could opt a stranger out, or back in.
 *
 * The keyword lists are Twilio's own defaults, so the behaviour matches what
 * Twilio's Advanced Opt-Out would do if it were on. When it *is* on, Twilio
 * replies to the keyword itself and this endpoint's reply is dropped, but the
 * request still arrives and the opt-out is still recorded.
 */
import { ensureDatabase, getSetting } from "@/db/runtime";
import { verifyTwilioSignature } from "@/app/api/notifications/voice/ack/route";
import { escapeXml } from "@/lib/notifications/channels";
import { twilioConfig } from "@/lib/notifications/config";
import { recordSmsOptIn, recordSmsOptOut } from "@/lib/marketing-consent";

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);

export type SmsKeyword = "stop" | "start" | "help" | null;

/** Only a message that is *just* the keyword counts — "stop by at 6?" is not an opt-out. */
export function smsKeyword(body: string): SmsKeyword {
  const word = body.trim().replace(/[.!]+$/, "").toUpperCase();
  if (STOP_WORDS.has(word)) return "stop";
  if (START_WORDS.has(word)) return "start";
  if (HELP_WORDS.has(word)) return "help";
  return null;
}

function reply(message: string | null): Response {
  const inner = message ? `<Message>${escapeXml(message)}</Message>` : "";
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    headers: { "content-type": "text/xml" },
  });
}

export async function POST(request: Request) {
  const config = await twilioConfig();
  if (!config) return new Response("SMS is not configured.", { status: 503 });

  const raw = await request.text();
  const params = Object.fromEntries(new URLSearchParams(raw));
  if (!verifyTwilioSignature(config.authToken, request.url, params, request.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature.", { status: 403 });
  }

  const from = params.From ?? "";
  const keyword = smsKeyword(params.Body ?? "");
  // Anything that is not a keyword is a person talking to a number nobody
  // reads. An empty response sends nothing back rather than an auto-reply.
  if (!keyword) return reply(null);

  await ensureDatabase();
  if (keyword === "stop") {
    await recordSmsOptOut(from);
    return reply("Pizza 62: you're unsubscribed and won't get any more marketing texts from us. Reply START to resubscribe.");
  }
  if (keyword === "start") {
    await recordSmsOptIn(from);
    return reply("Pizza 62: you're resubscribed to offers by text. Reply STOP any time to opt out.");
  }
  const business = await getSetting<{ phone?: string }>("business").catch(() => ({ phone: undefined }));
  return reply(
    `Pizza 62, 55 Parkdale Ave N, Hamilton. Questions? Call ${business.phone?.trim() || "(905) 547-5777"}. Reply STOP to opt out of texts.`,
  );
}
