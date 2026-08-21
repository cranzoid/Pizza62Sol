/**
 * Clover Hosted Checkout — the payment provider, replacing Stripe.
 *
 * Two halves, deliberately in one module so the webhook route and the order
 * service share a single definition of the contract:
 *
 *   createCloverCheckout()  starts a hosted session and returns its id + URL
 *   verifyCloverSignature() authenticates the webhook that reports the outcome
 *
 * Three properties of Clover shape everything downstream and are worth stating
 * once, here, rather than rediscovering them at each call site:
 *
 * 1. **Sessions expire after 15 minutes** (Stripe's lasted 24 hours). An order
 *    left in `awaiting_payment` is therefore dead within the hour, not the day,
 *    which is what `scripts/reap-payments.ts` exists to clean up.
 * 2. **There is no metadata passthrough.** Stripe carried our order id on the
 *    session and handed it back on the webhook; Clover does not. The mapping
 *    from checkout session to order lives in `payments.provider_reference`,
 *    written immediately after the session is created, and the webhook looks the
 *    order up through it.
 * 3. **Return URLs are configured per-merchant in the Clover dashboard, not per
 *    session.** So the success URL cannot carry `?order=…&token=…`; the browser
 *    stashes those before redirecting and recovers them at `/order/return`.
 */
import { readIntegrationSecret, readIntegrationSecrets } from "@/lib/integration-secrets";

const SANDBOX_BASE = "https://apisandbox.dev.clover.com";
const PRODUCTION_BASE = "https://api.clover.com";

/** Webhook timestamps older than this are refused as replays. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Credentials come from the encrypted store, which reads the database first and
 * the environment second — so the owner can paste them into the Integrations
 * tab, and a Key-Vault-only deployment keeps working unchanged. That makes every
 * getter below async; they were synchronous env reads before.
 */
async function secret(name: string): Promise<string | undefined> {
  return (await readIntegrationSecret(name)) ?? undefined;
}

/**
 * Sandbox unless `CLOVER_ENVIRONMENT` explicitly says production.
 *
 * Defaulting the *safe* way round matters: an unset or misspelled value should
 * send test traffic to the sandbox, never live traffic to a real merchant.
 */
export async function cloverApiBase(): Promise<string> {
  return (await secret("CLOVER_ENVIRONMENT"))?.toLowerCase() === "production"
    ? PRODUCTION_BASE
    : SANDBOX_BASE;
}

/** True once both values Hosted Checkout needs to make a call are present. */
export async function cloverCheckoutConfigured(): Promise<boolean> {
  const values = await readIntegrationSecrets(["CLOVER_MERCHANT_ID", "CLOVER_API_TOKEN"] as const);
  return Boolean(values.CLOVER_MERCHANT_ID && values.CLOVER_API_TOKEN);
}

export async function cloverWebhookConfigured(): Promise<boolean> {
  return Boolean(await secret("CLOVER_WEBHOOK_SECRET"));
}

export async function cloverMerchantId(): Promise<string | undefined> {
  return secret("CLOVER_MERCHANT_ID");
}

/** The signing secret the webhook route authenticates deliveries against. */
export async function cloverWebhookSecret(): Promise<string | undefined> {
  return secret("CLOVER_WEBHOOK_SECRET");
}

export type CloverCheckoutSession = {
  checkoutSessionId: string;
  href: string;
  expirationTime: number | null;
};

/**
 * Splits a single collected name into the two fields Clover asks for.
 *
 * The checkout form collects one "Full name", so there is nothing more precise
 * available. Everything after the first space becomes the surname, and a
 * single-word name leaves `lastName` empty rather than duplicating the first.
 */
function splitName(fullName: string): { firstName: string; lastName: string } {
  const trimmed = fullName.trim();
  const boundary = trimmed.indexOf(" ");
  if (boundary === -1) return { firstName: trimmed, lastName: "" };
  return { firstName: trimmed.slice(0, boundary), lastName: trimmed.slice(boundary + 1).trim() };
}

/**
 * Creates a hosted checkout session for an already-priced order.
 *
 * **The cart is sent as one line item for the order's final total, with tips
 * disabled and no tax rate.** That is deliberate and load-bearing, not laziness:
 *
 * - Every price in this application is computed server-side and re-checked
 *   before the order row is written. If we itemised the cart and attached a tax
 *   rate, Clover would recompute tax itself, and the amount actually charged
 *   would be whatever Clover arrived at rather than the amount stored on the
 *   order. `total_cents` is the number the kitchen, the receipt, the refund
 *   ceiling and the reconciliation all use — the customer must be charged
 *   exactly it.
 * - `totalCents` already contains tax, the delivery fee and the tip. Declaring a
 *   tax rate on top would tax the whole thing a second time.
 * - `tips.enabled: false` for the same reason: the tip was chosen in our own
 *   checkout and is already inside the total. Clover's tip screen would collect
 *   a second one that no order record knows about.
 *
 * The itemisation the customer needs to recognise the charge goes in the line
 * item's `note` instead, where it cannot affect arithmetic.
 */
export async function createCloverCheckout(input: {
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  totalCents: number;
  summary: string;
}): Promise<CloverCheckoutSession> {
  const { CLOVER_MERCHANT_ID: merchantId, CLOVER_API_TOKEN: apiToken } = await readIntegrationSecrets([
    "CLOVER_MERCHANT_ID",
    "CLOVER_API_TOKEN",
  ] as const);
  if (!merchantId || !apiToken) {
    throw new CloverNotConfiguredError();
  }
  if (!Number.isInteger(input.totalCents) || input.totalCents <= 0) {
    throw new Error(`Refusing to start a checkout for a non-positive total (${input.totalCents})`);
  }
  const { firstName, lastName } = splitName(input.customerName);
  const response = await fetch(`${await cloverApiBase()}/invoicingcheckoutservice/v1/checkouts`, {
    method: "POST",
    headers: {
      "X-Clover-Merchant-Id": merchantId,
      authorization: `Bearer ${apiToken}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      customer: {
        email: input.customerEmail,
        firstName,
        lastName,
        phoneNumber: input.customerPhone,
      },
      tips: { enabled: false },
      shoppingCart: {
        lineItems: [
          {
            name: `Pizza 62 order ${input.orderNumber}`,
            price: input.totalCents,
            unitQty: 1,
            note: input.summary.slice(0, 250),
          },
        ],
      },
    }),
  });
  const body = (await response.json().catch(() => null)) as
    | { href?: string; checkoutSessionId?: string; expirationTime?: number; message?: string; error?: string }
    | null;
  if (!response.ok || !body?.checkoutSessionId || !body.href) {
    const detail = body?.message ?? body?.error ?? `HTTP ${response.status}`;
    throw new Error(`Clover checkout session could not be created: ${detail}`);
  }
  return {
    checkoutSessionId: body.checkoutSessionId,
    href: body.href,
    expirationTime: typeof body.expirationTime === "number" ? body.expirationTime : null,
  };
}

/** Distinguishes "no credentials yet" from "Clover refused the call". */
export class CloverNotConfiguredError extends Error {
  constructor() {
    super("Clover Hosted Checkout is not configured");
  }
}

/** Constant-time comparison of two hex digests of equal length. */
export function equalHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Verifies `Clover-Signature: t=<unix-seconds>,v1=<hex hmac>`.
 *
 * The MAC is HMAC-SHA256 over `` `${t}.${rawBody}` `` under the signing secret
 * generated in the Clover dashboard. Binding the timestamp into the signed
 * string is what makes the freshness check meaningful — an attacker replaying a
 * captured body cannot move `t` forward without invalidating `v1`.
 *
 * `rawBody` must be the exact bytes received. Re-serialising the parsed JSON
 * changes key order and whitespace and the MAC will not match.
 */
export async function verifyCloverSignature(
  rawBody: string,
  header: string | null,
  signingSecret: string,
  now: number = Date.now(),
): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(",").map((entry) => entry.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1] ?? "";
  const signatures = parts
    .filter(([key, value]) => key === "v1" && typeof value === "string" && value.length > 0)
    .map(([, value]) => value as string);
  if (!signatures.length) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)),
  );
  const expected = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return signatures.some((signature) => equalHex(signature.toLowerCase(), expected));
}

export type CloverWebhookEvent = {
  /** Clover's payment UUID. */
  id?: string;
  merchantId?: string;
  /** The checkout session UUID — our join key back to `payments.provider_reference`. */
  data?: string;
  status?: string;
  type?: string;
};
