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
 * CSP allows self-hosted assets plus the inline styles and scripts the framework
 * emits, and forbids framing. `nosniff` also hardens owner-uploaded images.
 */
export const BASE_SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    // Clover Hosted Checkout is never called from the browser — the session is
    // created server-side and the customer is sent to Clover's own page by a
    // top-level navigation, which no directive here restricts. So unlike the
    // Stripe setup this replaces, neither connect-src nor form-action needs a
    // payment-provider origin.
    "connect-src 'self'",
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
export function securityHeadersFor(pathname: string): Record<string, string> {
  if (!isTokenBearingPath(pathname)) return BASE_SECURITY_HEADERS;
  return {
    ...BASE_SECURITY_HEADERS,
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store, max-age=0",
  };
}
