/**
 * The three delivery channels, behind one small interface.
 *
 * Each adapter does exactly one thing: hand a rendered message to a provider and
 * report whether it left. None of them decide *what* to send or *whether* to
 * send it — that is the dispatcher's and the renderer's job. Keeping them this
 * thin is what makes swapping SendGrid for anything else a new file rather than
 * a rewrite.
 *
 * The distinction every adapter makes is between a **retryable** failure and a
 * **permanent** one, because the dispatcher treats them completely differently:
 * a retryable failure goes back on the queue with backoff, a permanent one is
 * marked failed and stops consuming attempts. A 500 from SendGrid is worth
 * retrying; a malformed recipient address will never succeed no matter how many
 * times it is tried, and retrying it just delays every message behind it.
 */
import { emailConfig, twilioConfig, type TwilioConfig } from "@/lib/notifications/config";

export class ChannelError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

/** Not configured is not a failure — it is a reason to park, not to retry. */
export class ChannelNotConfiguredError extends Error {
  constructor(channel: string) {
    super(`${channel} is not configured`);
  }
}

/**
 * 4xx is the provider telling us the request itself is wrong, so repeating it
 * verbatim cannot help. 429 is the exception: it means "not now", not "not ever".
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// --- email (SendGrid) -------------------------------------------------------

export async function sendEmail(input: {
  to: string;
  subject: string;
  text: string;
}): Promise<{ provider: string; reference: string | null }> {
  const config = emailConfig();
  if (!config) throw new ChannelNotConfiguredError("Email");

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: input.to }] }],
      from: { email: config.from, name: "Pizza 62" },
      subject: input.subject,
      content: [{ type: "text/plain", value: input.text }],
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ChannelError(
      `SendGrid ${response.status}: ${detail.slice(0, 200)}`,
      isRetryableStatus(response.status),
    );
  }
  // SendGrid accepts asynchronously and returns 202 with an empty body; the
  // message id is in a header, and is the only handle for later support queries.
  return { provider: "sendgrid", reference: response.headers.get("x-message-id") };
}

// --- Twilio shared ----------------------------------------------------------

function twilioAuthHeader(config: TwilioConfig): string {
  return `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`;
}

async function postToTwilio(
  config: TwilioConfig,
  resource: "Messages" | "Calls",
  form: Record<string, string>,
): Promise<{ provider: string; reference: string | null }> {
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/${resource}.json`,
    {
      method: "POST",
      headers: {
        authorization: twilioAuthHeader(config),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form),
    },
  );
  const body = (await response.json().catch(() => null)) as
    | { sid?: string; message?: string; code?: number }
    | null;
  if (!response.ok) {
    throw new ChannelError(
      `Twilio ${resource} ${response.status}${body?.code ? ` (${body.code})` : ""}: ${(body?.message ?? "").slice(0, 200)}`,
      isRetryableStatus(response.status),
    );
  }
  return { provider: "twilio", reference: body?.sid ?? null };
}

// --- SMS (Programmable Messaging) -------------------------------------------

export async function sendSms(input: { to: string; body: string }): Promise<{
  provider: string;
  reference: string | null;
}> {
  const config = twilioConfig();
  if (!config) throw new ChannelNotConfiguredError("SMS");
  return postToTwilio(config, "Messages", {
    To: input.to,
    From: config.fromNumber,
    // Twilio splits anything longer into segments and bills each one; the
    // renderer keeps bodies short, and this is the backstop.
    Body: input.body.slice(0, 1500),
  });
}

// --- voice (Programmable Voice) ---------------------------------------------

/**
 * Places a call that reads a message and waits for a keypress.
 *
 * The TwiML is passed inline rather than by URL. Twilio supports both, but a URL
 * would mean exposing a second public endpoint whose only job is to render
 * static text, and that endpoint would have to be reachable and correct before
 * any call could work at all. Inline TwiML removes that dependency — the only
 * endpoint Twilio needs to reach is the `<Gather>` callback, which has real work
 * to do.
 */
export async function placeAcknowledgementCall(input: {
  to: string;
  say: string;
  ackCallbackUrl: string;
}): Promise<{ provider: string; reference: string | null }> {
  const config = twilioConfig();
  if (!config) throw new ChannelNotConfiguredError("Voice");
  return postToTwilio(config, "Calls", {
    To: input.to,
    From: config.fromNumber,
    Twiml: acknowledgementTwiml(input.say, input.ackCallbackUrl),
  });
}

/** XML text nodes must not carry raw markup characters. */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function acknowledgementTwiml(say: string, ackCallbackUrl: string): string {
  const spoken = escapeXml(say);
  // The message is repeated inside the <Gather> as well as before it: whoever
  // picks up may have missed the first reading, and a kitchen is loud. If the
  // gather times out with no keypress, the call ends and the order stays
  // unacknowledged — which is what causes the next re-call.
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `<Say voice="alice" language="en-CA">${spoken}</Say>`,
    `<Gather numDigits="1" timeout="10" action="${escapeXml(ackCallbackUrl)}" method="POST">`,
    '<Say voice="alice" language="en-CA">Press 1 to acknowledge this order.</Say>',
    "</Gather>",
    '<Say voice="alice" language="en-CA">No key was pressed. We will call again shortly.</Say>',
    "</Response>",
  ].join("");
}
