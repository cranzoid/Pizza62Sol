/**
 * Notification configuration, and the rules about what may be sent on what.
 *
 * Two of these are policy rather than plumbing, and both exist because getting
 * them wrong has consequences outside this codebase.
 *
 * **Customer SMS is off unless explicitly enabled.** The Twilio number is a
 * local Canadian long code, not a toll-free or registered A2P number. Canadian
 * carriers filter application-to-person traffic from unregistered long codes, so
 * customer SMS would be delivered unpredictably — and silently. Treating it as a
 * working channel would mean orders that the customer believes were confirmed
 * and never were. Email is the durable copy; SMS is opt-in and additive.
 *
 * **The restaurant is the only party this system ever calls.** Calling customers
 * would pull the project into CRTC/CASL consent obligations it has not met.
 */
import { env } from "@/lib/runtime-env";

function value(name: string): string | undefined {
  const raw = (env as unknown as Record<string, string | undefined>)[name];
  return raw && raw.trim() ? raw.trim() : undefined;
}

function flag(name: string): boolean {
  return value(name)?.toLowerCase() === "true";
}

export type EmailConfig = { apiKey: string; from: string; provider: string };
export type TwilioConfig = { accountSid: string; authToken: string; fromNumber: string };

export function emailConfig(): EmailConfig | null {
  const apiKey = value("EMAIL_API_KEY");
  const from = value("EMAIL_FROM");
  if (!apiKey || !from) return null;
  return { apiKey, from, provider: value("EMAIL_PROVIDER") ?? "sendgrid" };
}

export function twilioConfig(): TwilioConfig | null {
  const accountSid = value("TWILIO_ACCOUNT_SID");
  const authToken = value("TWILIO_AUTH_TOKEN");
  const fromNumber = value("TWILIO_FROM_NUMBER");
  if (!accountSid || !authToken || !fromNumber) return null;
  return { accountSid, authToken, fromNumber };
}

/**
 * The number the restaurant is called and texted on.
 *
 * Deliberately its own variable rather than the public `business.phone` setting:
 * the number customers call and the number that should ring in the kitchen at
 * 9pm are not necessarily the same, and the owner is asked for this one
 * separately.
 */
export function restaurantAlertNumber(): string | null {
  return value("RESTAURANT_ALERT_PHONE") ?? null;
}

/** See the module header — off unless the owner has a registered number. */
export function customerSmsEnabled(): boolean {
  return flag("CUSTOMER_SMS_ENABLED");
}

/**
 * Absolute base URL for links and Twilio callbacks.
 *
 * The dispatcher has no incoming request to derive an origin from — it runs as a
 * cron job — and Twilio has to be handed a URL it can reach from the public
 * internet for the `<Gather>` callback. Terraform sets this to the Container App
 * FQDN.
 */
export function publicBaseUrl(): string | null {
  const raw = value("PUBLIC_BASE_URL");
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

/** How many times the restaurant is called before the attempt is given up on. */
export function voiceRetryLimit(): number {
  const parsed = Number(value("VOICE_RETRY_LIMIT") ?? "3");
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 10 ? parsed : 3;
}

/** Minutes between re-calls while an order is still unacknowledged. */
export function voiceRetryMinutes(): number {
  const parsed = Number(value("VOICE_RETRY_MINUTES") ?? "2");
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 60 ? parsed : 2;
}

/**
 * True when at least one channel can actually deliver.
 *
 * Used to decide whether a newly written outbox row is `pending` (a dispatcher
 * will take it) or `pending_provider_setup` (parked until credentials exist, so
 * it is not retried and failed thousands of times in the meantime).
 */
export function anyProviderConfigured(): boolean {
  return emailConfig() !== null || twilioConfig() !== null;
}
