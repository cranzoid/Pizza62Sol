/**
 * The Integrations screen: where the owner connects Clover, Twilio and email.
 *
 * This exists so that going live is not a developer task. Every credential here
 * arrives after the software does — usually while sitting in the restaurant with
 * the owner — and requiring an Azure login and a container restart to paste them
 * in would make that true forever.
 *
 * Three rules shape the route:
 *
 * 1. **Values go in and never come back out.** `GET` returns whether a key is
 *    set, which side it came from, and a four-character tail; it never returns a
 *    secret. The screen's job is to confirm *that* something is configured and to
 *    replace it, not to read it back.
 * 2. **Owner or `manage_settings`, and every change is audited** — with the key
 *    name and the actor, never the value.
 * 3. **A test send is part of the flow, not a nicety.** A credential that is
 *    present but wrong looks identical to one that is right until an order
 *    arrives, and the first order of the day is the worst time to find out.
 */
import { AuthError, authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getSetting, writeAudit } from "@/db/runtime";
import { hasPermission } from "@/lib/domain";
import { logFailure } from "@/lib/log";
import {
  INTEGRATION_SECRET_KEYS,
  clearIntegrationSecretCache,
  describeIntegrationSecrets,
  encryptionConfigured,
  readIntegrationSecret,
  writeIntegrationSecret,
  type IntegrationSecretKey,
} from "@/lib/integration-secrets";
import { cloverCheckoutConfigured, cloverWebhookConfigured } from "@/lib/clover";
import { emailConfig, publicBaseUrl, twilioConfig } from "@/lib/notifications/config";
import {
  ChannelNotConfiguredError,
  placeAcknowledgementCall,
  sendEmail,
  sendSms,
} from "@/lib/notifications/channels";

const KEYS = new Set<string>(INTEGRATION_SECRET_KEYS);

/**
 * Values that are choices, not free text. Validated here rather than trusted,
 * because `CLOVER_ENVIRONMENT: "prod"` would silently mean sandbox — the default
 * is deliberately the safe one, which also makes a typo invisible.
 */
const ENUMERATED: Record<string, readonly string[]> = {
  CLOVER_ENVIRONMENT: ["sandbox", "production"],
  EMAIL_PROVIDER: ["resend", "sendgrid"],
  CUSTOMER_SMS_ENABLED: ["true", "false"],
};

/** E.164, which is what Twilio requires and what a North American number is not by default. */
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Throws `AuthError` specifically: `authErrorResponse` maps that to a status and
 * *rethrows* anything else, so a hand-rolled error object here would surface as
 * an unhandled 500 rather than the 403 it is.
 */
async function requireOwnerOrSettings(request: Request) {
  const user = await requireStaff(request, "view_orders");
  if (user.role !== "owner" && !hasPermission(user.role, user.permissions, "manage_settings")) {
    throw new AuthError(403, "Only the owner can change integration credentials.");
  }
  return user;
}

function validate(key: IntegrationSecretKey, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const allowed = ENUMERATED[key];
  if (allowed && !allowed.includes(trimmed.toLowerCase())) {
    throw new Error(`${key} must be one of: ${allowed.join(", ")}.`);
  }
  if ((key === "TWILIO_FROM_NUMBER" || key === "RESTAURANT_ALERT_PHONE") && !E164.test(trimmed)) {
    throw new Error(`${key} must be in E.164 form, like +19055475777.`);
  }
  if (key === "EMAIL_FROM" && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(trimmed)) {
    throw new Error("The sender address must be a valid email address.");
  }
  if (key === "PUBLIC_BASE_URL" && !/^https:\/\/[^\s/]+/.test(trimmed)) {
    throw new Error("The public base URL must be an absolute https:// origin.");
  }
  if (key === "TWILIO_ACCOUNT_SID" && !/^AC[0-9a-fA-F]{32}$/.test(trimmed)) {
    throw new Error("A Twilio Account SID starts with AC followed by 32 hex characters.");
  }
  if ((key === "VOICE_RETRY_LIMIT" || key === "VOICE_RETRY_MINUTES") && !/^\d{1,2}$/.test(trimmed)) {
    throw new Error(`${key} must be a small whole number.`);
  }
  return allowed ? trimmed.toLowerCase() : trimmed;
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    await requireOwnerOrSettings(request);

    const [secrets, base, checkout, webhook, email, twilio, business] = await Promise.all([
      describeIntegrationSecrets(),
      publicBaseUrl(),
      cloverCheckoutConfigured(),
      cloverWebhookConfigured(),
      emailConfig(),
      twilioConfig(),
      getSetting<{ email?: string }>("business").catch(() => ({ email: undefined })),
    ]);

    // The exact strings the owner has to paste into someone else's dashboard.
    // Getting these wrong is the single most common way an integration is
    // "configured" and still does not work, so they are generated rather than
    // written down in a runbook that can drift from the routes.
    const callbacks = base
      ? {
          cloverWebhook: `${base}/api/payments/clover/webhook`,
          cloverReturn: `${base}/order/return`,
          twilioVoiceAck: `${base}/api/notifications/voice/ack`,
        }
      : null;

    return Response.json({
      encryptionConfigured: encryptionConfigured(),
      secrets,
      callbacks,
      readiness: {
        // Card payment needs both halves: a session you can create and a webhook
        // you can trust. One without the other takes money and never confirms it.
        onlinePayment: checkout && webhook,
        cloverCheckout: checkout,
        cloverWebhook: webhook,
        email: email !== null,
        emailProvider: email?.provider ?? null,
        sms: twilio !== null,
        voice: twilio !== null && base !== null,
        restaurantEmail: Boolean(business.email),
        // The address itself, not just whether one exists. "The restaurant is
        // emailed about new orders ✓" is not an answer to "which inbox?", and the
        // owner cannot confirm a setting they cannot see.
        restaurantEmailAddress: business.email?.trim() || null,
        publicBaseUrl: base,
      },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

type Body =
  | { action: "secret.set"; key?: string; value?: string }
  | { action: "test.email"; to?: string }
  | { action: "test.sms"; to?: string }
  | { action: "test.voice"; to?: string };

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireOwnerOrSettings(request);
    const body = (await request.json()) as Body;

    if (body.action === "secret.set") {
      const key = String(body.key ?? "");
      if (!KEYS.has(key)) {
        return Response.json({ error: "That is not a configurable credential." }, { status: 400 });
      }
      if (!encryptionConfigured()) {
        return Response.json(
          {
            error:
              "SETTINGS_ENCRYPTION_KEY is not set on this deployment, so credentials cannot be stored here yet.",
          },
          { status: 409 },
        );
      }
      let value: string;
      try {
        value = validate(key as IntegrationSecretKey, String(body.value ?? ""));
      } catch (error) {
        return Response.json({ error: (error as Error).message }, { status: 400 });
      }

      await writeIntegrationSecret(key as IntegrationSecretKey, value, user.id);
      clearIntegrationSecretCache();
      // The key name and who changed it, never the value — an audit log that
      // contains the credential defeats encrypting it in the first place.
      await writeAudit({
        actorId: user.id,
        action: value ? "integration.secret.set" : "integration.secret.cleared",
        targetType: "integration_secret",
        targetId: key,
      });
      return Response.json({ ok: true, secrets: await describeIntegrationSecrets() });
    }

    // --- test sends ---------------------------------------------------------
    // Deliberately real. The point is to prove the credential works end to end,
    // which nothing short of an actual delivery does.

    if (body.action === "test.email") {
      const business = await getSetting<{ email?: string }>("business").catch(() => ({ email: undefined }));
      const to = String(body.to ?? business.email ?? "").trim();
      if (!to) return Response.json({ error: "No address to send the test to." }, { status: 400 });
      try {
        const result = await sendEmail({
          to,
          subject: "Pizza 62 — test email",
          text: "This is a test from the Pizza 62 admin Integrations screen. If you can read this, order confirmations will reach customers.",
        });
        return Response.json({ ok: true, provider: result.provider, reference: result.reference });
      } catch (error) {
        return testFailure("email", error);
      }
    }

    if (body.action === "test.sms") {
      const to = String(body.to ?? (await readIntegrationSecret("RESTAURANT_ALERT_PHONE")) ?? "").trim();
      if (!E164.test(to)) {
        return Response.json({ error: "Give a destination number in E.164 form, like +19055475777." }, { status: 400 });
      }
      try {
        const result = await sendSms({ to, body: "Pizza 62 test message. SMS is working." });
        return Response.json({ ok: true, provider: result.provider, reference: result.reference });
      } catch (error) {
        return testFailure("SMS", error);
      }
    }

    if (body.action === "test.voice") {
      const to = String(body.to ?? (await readIntegrationSecret("RESTAURANT_ALERT_PHONE")) ?? "").trim();
      const base = await publicBaseUrl();
      if (!E164.test(to)) {
        return Response.json({ error: "Give a destination number in E.164 form, like +19055475777." }, { status: 400 });
      }
      if (!base) {
        return Response.json(
          { error: "Set PUBLIC_BASE_URL first — Twilio needs a reachable URL for the keypress callback." },
          { status: 409 },
        );
      }
      try {
        const result = await placeAcknowledgementCall({
          to,
          say: "This is a test call from Pizza 62. If you can hear this, order alerts will reach the kitchen.",
          // `order=test` is not a real order id, so the callback will not
          // acknowledge anything. The call itself is what is being tested.
          ackCallbackUrl: `${base}/api/notifications/voice/ack?order=test`,
        });
        return Response.json({ ok: true, provider: result.provider, reference: result.reference });
      } catch (error) {
        return testFailure("voice", error);
      }
    }

    return Response.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    return authErrorResponse(error);
  }
}

/**
 * A failed test is information, not an incident — the provider's own message is
 * the most useful thing on the screen ("from address not verified", "invalid
 * token"), so it is passed through rather than replaced with a generic error.
 */
function testFailure(channel: string, error: unknown): Response {
  if (error instanceof ChannelNotConfiguredError) {
    return Response.json({ error: `${channel} has no credentials yet.` }, { status: 409 });
  }
  const reference = logFailure(`integrations.test.${channel}`, error);
  return Response.json(
    {
      error: error instanceof Error ? error.message : `The ${channel} test failed.`,
      reference,
    },
    { status: 502 },
  );
}
