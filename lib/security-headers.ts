/**
 * The browser security headers, as data rather than as framework middleware.
 *
 * Separated from `middleware.ts` for two reasons. It is a policy, and a policy
 * should be readable and testable on its own — `middleware.ts` imports
 * `next/server`, which the plain Node loader the test suite runs under cannot
 * resolve, so the rules were previously unreachable from a test. And keeping the
 * middleware to "apply these" means the interesting part does not move when the
 * framework's middleware API does (it is already deprecated in favour of
 * `proxy.ts`).
 */

/**
 * H-16 / H-26: the baseline, applied to every response.
 *
 * CSP allows self-hosted assets plus HTTPS images accepted by the website/menu
 * editors, the inline styles and scripts the framework emits, and forbids
 * framing. `nosniff` also hardens owner-uploaded images.
 */
/**
 * Clover's origins, for the one page that runs its card form.
 *
 * Both environments are listed rather than derived from `CLOVER_ENVIRONMENT`,
 * because this module is pure data with no database access — and naming the
 * sandbox host costs nothing, since a policy is a permission to connect, not an
 * instruction to. The Apple host is there because Apple Pay renders its own
 * sheet from `applepay.cdn-apple.com` inside Clover's frame.
 */
/**
 * Google's reCAPTCHA, which Clover's SDK loads itself.
 *
 * Not optional and not obvious: the SDK injects
 * `https://www.google.com/recaptcha/api.js` during initialisation, so a policy
 * that names every Clover origin and omits this one still blocks the card form —
 * and it fails in the most misleading way available, because the SDK script
 * loads fine and only the initialisation inside it dies. That looked exactly
 * like Clover's hosted checkout "taking over", when it was the fallback
 * correctly firing on a form that had been blocked from starting.
 *
 * reCAPTCHA also renders in an iframe and calls home, so it needs all three
 * directives rather than just `script-src`.
 */
const RECAPTCHA_ORIGINS = "https://www.google.com https://www.gstatic.com";

const CLOVER_SCRIPT_ORIGINS = `https://checkout.clover.com https://checkout.sandbox.dev.clover.com ${RECAPTCHA_ORIGINS}`;
const CLOVER_FRAME_ORIGINS =
  `https://checkout.clover.com https://checkout.sandbox.dev.clover.com https://*.clover.com https://applepay.cdn-apple.com ${RECAPTCHA_ORIGINS}`;
const CLOVER_CONNECT_ORIGINS =
  `https://scl.clover.com https://scl-sandbox.dev.clover.com https://checkout.clover.com https://checkout.sandbox.dev.clover.com https://*.clover.com ${RECAPTCHA_ORIGINS}`;

// Loaded only after the visitor grants marketing measurement consent. They
// still have to be named in CSP up front: a CSP is a static permission boundary
// and cannot be widened after the response has reached the browser.
const MARKETING_SCRIPT_ORIGINS = "https://connect.facebook.net https://www.googletagmanager.com";
const MARKETING_CONNECT_ORIGINS = [
  "https://connect.facebook.net",
  "https://www.facebook.com",
  "https://www.google-analytics.com",
  "https://analytics.google.com",
  "https://region1.google-analytics.com",
  "https://www.googletagmanager.com",
  "https://www.googleadservices.com",
  "https://googleads.g.doubleclick.net",
].join(" ");

export const BASE_SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "img-src 'self' https: data: blob:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' ${MARKETING_SCRIPT_ORIGINS}`,
    // Clover Hosted Checkout is never called from the browser — the session is
    // created server-side and the customer is sent to Clover's own page by a
    // top-level navigation, which no directive here restricts. So unlike the
    // Stripe setup this replaces, neither connect-src nor form-action needs a
    // payment-provider origin.
    `connect-src 'self' ${MARKETING_CONNECT_ORIGINS}`,
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; "),
};

/**
 * H-15: pages that can be reached with a bearer token in the URL.
 *
 * The confirmation email links to `/track?order=…&token=…`, because email is the
 * private channel that makes handing out such a link reasonable in the first
 * place. What these paths need on top of the baseline is the recognition that
 * their *own URL* is a credential.
 */
const TOKEN_BEARING_PATHS = ["/track", "/feedback", "/order/return"];

export function isTokenBearingPath(pathname: string): boolean {
  return TOKEN_BEARING_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * Apple's domain-association file, which proves to Apple that we control
 * `pizza62.ca` before Apple Pay may run on it.
 *
 * It is a static file in `public/`, and it is served as
 * `application/octet-stream` because the static handler types an extensionless
 * file that way. That cannot be corrected from here: middleware runs (every
 * other header below is present on the response) but the static handler sets
 * `Content-Type` afterwards and wins. Two other routes were tried and rejected —
 * a route handler at this path 404s, because the router ignores directories
 * beginning with a dot, and reading the payload inside middleware would put a
 * filesystem call on every request to the site to fix a header Apple does not
 * document a requirement for.
 *
 * `text/plain` would be the tidier answer if it were reachable. Octet-stream is
 * what most static hosts serve this file as, and the documented verification
 * failures are 404s and redirects rather than content types — so if Apple ever
 * does reject it, the content type is the first thing to suspect and the fix is
 * to move this to a rewritten route.
 *
 * What the path does need, and has: no redirect, no auth, no 404. The
 * canonical-host redirect only rewrites the exact `www.` alias, so the apex this
 * is registered under is unaffected — see `lib/canonical-host.ts`. A broader
 * canonical rule added later would break verification silently.
 */
export const APPLE_PAY_ASSOCIATION_PATH = "/.well-known/apple-developer-merchantid-domain-association";

/**
 * The headers for one request path.
 *
 * On a token-bearing page:
 *
 * - **`no-referrer`.** The baseline `strict-origin-when-cross-origin` still
 *   sends the *full URL* on a same-origin navigation, which here is the URL
 *   containing the token. Every link on the page would carry it.
 * - **`no-store`.** A page whose address is a credential must not be held by a
 *   shared proxy, written to disk, or restored from the back/forward cache with
 *   the token still in it.
 *
 * The strict policy stays everywhere else: `no-referrer` site-wide would throw
 * away legitimate navigation context for no benefit.
 */
/**
 * The pages that host the inline card form.
 *
 * Only the storefront: the checkout is a modal on it, so that is the single
 * place Clover's SDK, its iframes and its API need to be reachable from. Keeping
 * the widening off every other route means an XSS anywhere else in the site
 * still cannot talk to the payment origins.
 */
function isPaymentPath(pathname: string): boolean {
  return pathname === "/";
}

/** The baseline with Clover's origins added to the three directives that block it. */
function paymentHeaders(): Record<string, string> {
  return {
    ...BASE_SECURITY_HEADERS,
    "Content-Security-Policy": BASE_SECURITY_HEADERS["Content-Security-Policy"]
      .replace(MARKETING_SCRIPT_ORIGINS, `${MARKETING_SCRIPT_ORIGINS} ${CLOVER_SCRIPT_ORIGINS}`)
      .replace(MARKETING_CONNECT_ORIGINS, `${MARKETING_CONNECT_ORIGINS} ${CLOVER_CONNECT_ORIGINS}`)
      // No frame-src in the baseline, so it falls back to default-src 'self' and
      // Clover's iframes are blocked. It has to be added, not rewritten.
      .replace("object-src 'none'", `frame-src ${CLOVER_FRAME_ORIGINS}; object-src 'none'`),
  };
}

export function securityHeadersFor(pathname: string): Record<string, string> {
  if (isPaymentPath(pathname)) return paymentHeaders();
  if (!isTokenBearingPath(pathname)) return BASE_SECURITY_HEADERS;
  return {
    ...BASE_SECURITY_HEADERS,
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store, max-age=0",
  };
}
