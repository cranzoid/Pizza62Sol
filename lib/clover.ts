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
 * 3. **Return URLs must be sent per session, or the customer is never sent
 *    back.** This module previously asserted the opposite — that Clover only
 *    supports a single return URL configured per-merchant in the dashboard — and
 *    so sent none at all. Clover accepts `redirectUrls` on the create-checkout
 *    call; with neither that nor a dashboard entry, a customer who pays is
 *    simply left sitting on Clover's receipt page. Where both exist the
 *    dashboard wins, so an entry there silently overrides what is sent here.
 */
import { readIntegrationFlag, readIntegrationSecret, readIntegrationSecrets } from "@/lib/integration-secrets";
import { publicBaseUrl } from "@/lib/notifications/config";

const SANDBOX_BASE = "https://apisandbox.dev.clover.com";
const PRODUCTION_BASE = "https://api.clover.com";

/**
 * The Ecommerce API lives on a *different* host from Hosted Checkout.
 *
 * Charges go to `scl.clover.com`, not `api.clover.com`. Getting this wrong
 * produces a 404 that reads like a bad path rather than a bad host, so the two
 * pairs are kept side by side here where the difference is visible.
 */
const ECOMMERCE_SANDBOX_BASE = "https://scl-sandbox.dev.clover.com";
const ECOMMERCE_PRODUCTION_BASE = "https://scl.clover.com";

/** Everything is priced and charged in Canadian dollars. */
const CURRENCY = "cad";

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
  return (await cloverIsProduction()) ? PRODUCTION_BASE : SANDBOX_BASE;
}

/** Same rule, same safe default, for the Ecommerce (charges) host. */
export async function cloverEcommerceBase(): Promise<string> {
  return (await cloverIsProduction()) ? ECOMMERCE_PRODUCTION_BASE : ECOMMERCE_SANDBOX_BASE;
}

async function cloverIsProduction(): Promise<boolean> {
  return (await secret("CLOVER_ENVIRONMENT"))?.toLowerCase() === "production";
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

/**
 * The browser half of the key pair, which the card form needs to talk to Clover.
 *
 * Public by design — it ships inside the checkout page to every visitor and only
 * identifies the merchant to Clover's SDK. It cannot move money on its own; the
 * token it produces is worthless without the private token that charges it.
 */
export async function cloverPublicToken(): Promise<string | undefined> {
  return secret("CLOVER_PUBLIC_TOKEN");
}

/**
 * True once the inline card form has everything it needs.
 *
 * Deliberately stricter than `cloverCheckoutConfigured()`: the iframe needs the
 * public token *and* the private one, because the browser tokenises the card and
 * the server then charges that token. Half-configured means a customer can type
 * a card in and have the charge fail, which is worse than never offering it.
 */
export async function cloverIframeConfigured(): Promise<boolean> {
  const values = await readIntegrationSecrets([
    "CLOVER_MERCHANT_ID",
    "CLOVER_API_TOKEN",
    "CLOVER_PUBLIC_TOKEN",
  ] as const);
  return Boolean(values.CLOVER_MERCHANT_ID && values.CLOVER_API_TOKEN && values.CLOVER_PUBLIC_TOKEN);
}

/**
 * Whether inline card entry is the primary path.
 *
 * Separate from `cloverIframeConfigured()` so the credentials can be in place
 * and verified before any customer is routed through the new flow — and so
 * turning it back off is a single field on the Integrations tab rather than a
 * deploy. Hosted Checkout remains behind it either way.
 */
export async function cloverIframeEnabled(): Promise<boolean> {
  return (await readIntegrationFlag("CLOVER_IFRAME_ENABLED")) && (await cloverIframeConfigured());
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
  // Where Clover sends the customer once the card clears. Omitted entirely when
  // no base URL is configured rather than guessed at from the request host: a
  // wrong absolute URL here strands every paying customer on Clover's receipt
  // page, and `publicBaseUrl()` is the one value that is known to be right.
  //
  // `{CHECKOUT_SESSION_ID}` is Clover's own substitution token. It is used in
  // preference to the order number because the value it expands to is the
  // session UUID already stored in `payments.provider_reference` — a
  // non-guessable key that a return-page lookup can be built on later, where a
  // sequential order number in a URL would be enumerable.
  const baseUrl = await publicBaseUrl();
  const redirectUrls = baseUrl
    ? {
        success: `${baseUrl}/order/return?session_id={CHECKOUT_SESSION_ID}`,
        failure: `${baseUrl}/order/return?status=failed`,
      }
    : undefined;
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
      ...(redirectUrls ? { redirectUrls } : {}),
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

export type CloverChargeResult = {
  /** Clover's charge id, stored as the payment's provider reference. */
  chargeId: string;
  status: string;
  amountCents: number;
};

/**
 * Raised when Clover refuses the card. Distinct from a transport or config
 * failure because it is the customer's problem to solve, not ours: the message
 * is shown to them and the order stays payable rather than being cancelled.
 */
export class CloverDeclinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloverDeclinedError";
  }
}

/**
 * Charges a card token produced by the browser's iframe.
 *
 * This is the synchronous counterpart to `createCloverCheckout`, and the reason
 * the inline form is worth having: the outcome is known inside the request that
 * created the order, so an order is paid or it is not, decided once. There is no
 * `awaiting_payment` window for the reaper to cancel through, and no dependence
 * on a webhook arriving for the customer to be told what happened.
 *
 * Two things are load-bearing:
 *
 * - **The amount comes from the stored total, never the browser.** Same rule as
 *   Hosted Checkout, and it matters more here: the browser is now supplying the
 *   payment instrument too, so it must not also get to say what it is charged.
 * - **The idempotency key is required by Clover, and reused from the order's own
 *   checkout key.** A retried submission — a double tap, a flaky connection, a
 *   refresh mid-charge — resolves to the same charge at Clover instead of taking
 *   the money twice. Deriving it from the existing key rather than generating a
 *   fresh one is what makes that true across a browser retry, not just a
 *   server-side one.
 */
export async function createCloverCharge(input: {
  amountCents: number;
  sourceToken: string;
  idempotencyKey: string;
  orderNumber: string;
  customerEmail: string;
}): Promise<CloverChargeResult> {
  const { CLOVER_MERCHANT_ID: merchantId, CLOVER_API_TOKEN: apiToken } = await readIntegrationSecrets([
    "CLOVER_MERCHANT_ID",
    "CLOVER_API_TOKEN",
  ] as const);
  if (!merchantId || !apiToken) throw new CloverNotConfiguredError();
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error(`Refusing to charge a non-positive amount (${input.amountCents})`);
  }
  if (!input.sourceToken.trim()) throw new Error("Refusing to charge without a card token");

  const response = await fetch(`${await cloverEcommerceBase()}/v1/charges`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      accept: "application/json",
      "content-type": "application/json",
      "idempotency-key": input.idempotencyKey,
    },
    body: JSON.stringify({
      amount: input.amountCents,
      currency: CURRENCY,
      source: input.sourceToken,
      description: `Pizza 62 order ${input.orderNumber}`,
      receipt_email: input.customerEmail,
      // Clover's charge object does carry metadata, unlike a hosted checkout
      // session — so the order number travels with the payment and shows up in
      // the merchant dashboard next to it, which is what makes a refund
      // reconcilable by hand later.
      metadata: { orderNumber: input.orderNumber },
    }),
  });

  const body = (await response.json().catch(() => null)) as
    | {
        id?: string;
        status?: string;
        amount?: number;
        error?: { message?: string; code?: string; decline_code?: string };
        message?: string;
      }
    | null;

  if (!response.ok || !body?.id) {
    const detail = body?.error?.message ?? body?.message ?? `HTTP ${response.status}`;
    // 402 is Clover's "the card was refused". Anything else is our problem —
    // wrong credentials, a malformed request, Clover being down — and must not
    // be shown to the customer as though their card were at fault.
    if (response.status === 402) throw new CloverDeclinedError(detail);
    throw new Error(`Clover charge failed: ${detail}`);
  }

  // A charge that comes back in any state other than paid/succeeded has not
  // taken the money, and treating it as success would hand out free pizza.
  const status = (body.status ?? "").toLowerCase();
  if (status && !["paid", "succeeded", "captured"].includes(status)) {
    throw new CloverDeclinedError(`The payment was not completed (${status}).`);
  }

  return {
    chargeId: body.id,
    status: status || "paid",
    amountCents: typeof body.amount === "number" ? body.amount : input.amountCents,
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
