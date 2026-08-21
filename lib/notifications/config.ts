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
 *
 * ## Why every getter is async
 *
 * These used to read `process.env` synchronously. Credentials now come from
 * `lib/integration-secrets.ts` — the encrypted store the owner can write to from
 * the admin screen — which needs a database read, so the whole surface is
 * promise-returning. The store caches for 30 seconds and falls back to the
 * environment, so this is not a query per message.
 */
import {
  readIntegrationFlag,
  readIntegrationSecret,
  readIntegrationSecrets,
} from "@/lib/integration-secrets";

/**
 * `provider` selects the transport in `channels.ts`.
 *
 * Resend is the default because its free tier (3,000/month, 100/day) covers a
 * single restaurant's confirmations outright, where SendGrid no longer offers
 * one. Both are implemented; switching is a settings change, not a deploy.
 */
export type EmailConfig = { apiKey: string; from: string; provider: "resend" | "sendgrid" };
export type TwilioConfig = { accountSid: string; authToken: string; fromNumber: string };

function normalizeProvider(raw: string | null): "resend" | "sendgrid" {
  return raw?.toLowerCase() === "sendgrid" ? "sendgrid" : "resend";
}

export async function emailConfig(): Promise<EmailConfig | null> {
  const values = await readIntegrationSecrets(["EMAIL_API_KEY", "EMAIL_FROM", "EMAIL_PROVIDER"] as const);
  if (!values.EMAIL_API_KEY || !values.EMAIL_FROM) return null;
  return {
    apiKey: values.EMAIL_API_KEY,
    from: values.EMAIL_FROM,
    provider: normalizeProvider(values.EMAIL_PROVIDER),
  };
}

export async function twilioConfig(): Promise<TwilioConfig | null> {
  const values = await readIntegrationSecrets([
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_FROM_NUMBER",
  ] as const);
  if (!values.TWILIO_ACCOUNT_SID || !values.TWILIO_AUTH_TOKEN || !values.TWILIO_FROM_NUMBER) return null;
  return {
    accountSid: values.TWILIO_ACCOUNT_SID,
    authToken: values.TWILIO_AUTH_TOKEN,
    fromNumber: values.TWILIO_FROM_NUMBER,
  };
}

/**
 * The number the restaurant is called and texted on.
 *
 * Deliberately its own setting rather than the public `business.phone`: the
 * number customers call and the number that should ring in the kitchen at 9pm
 * are not necessarily the same, and the owner is asked for this one separately.
 */
export async function restaurantAlertNumber(): Promise<string | null> {
  return readIntegrationSecret("RESTAURANT_ALERT_PHONE");
}

/** See the module header — off unless the owner has a registered number. */
export async function customerSmsEnabled(): Promise<boolean> {
  return readIntegrationFlag("CUSTOMER_SMS_ENABLED");
}

/**
 * Absolute base URL for links and Twilio callbacks.
 *
 * The dispatcher has no incoming request to derive an origin from — it runs on a
 * timer — and Twilio has to be handed a URL it can reach from the public
 * internet for the `<Gather>` callback. Terraform sets this to the App Service
 * hostname; the owner can override it once a custom domain is live.
 */
export async function publicBaseUrl(): Promise<string | null> {
  const raw = await readIntegrationSecret("PUBLIC_BASE_URL");
  return raw ? raw.replace(/\/+$/, "") : null;
}

async function boundedNumber(key: "VOICE_RETRY_LIMIT" | "VOICE_RETRY_MINUTES", fallback: number, max: number) {
  const parsed = Number((await readIntegrationSecret(key)) ?? String(fallback));
  return Number.isInteger(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

/** How many times the restaurant is called before the attempt is given up on. */
export async function voiceRetryLimit(): Promise<number> {
  return boundedNumber("VOICE_RETRY_LIMIT", 3, 10);
}

/** Minutes between re-calls while an order is still unacknowledged. */
export async function voiceRetryMinutes(): Promise<number> {
  return boundedNumber("VOICE_RETRY_MINUTES", 2, 60);
}

/**
 * True when at least one channel can actually deliver.
 *
 * Used to decide whether a newly written outbox row is `pending` (a dispatcher
 * will take it) or `pending_provider_setup` (parked until credentials exist, so
 * it is not retried and failed thousands of times in the meantime).
 */
export async function anyProviderConfigured(): Promise<boolean> {
  const [email, twilio] = await Promise.all([emailConfig(), twilioConfig()]);
  return email !== null || twilio !== null;
}
