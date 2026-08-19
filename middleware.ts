import { NextResponse } from "next/server";

/**
 * H-16 / H-26: baseline browser security headers on every response.
 *
 * These previously lived in the Cloudflare Worker entry point, which applied
 * them at the edge. Expressing them as framework middleware instead keeps them
 * attached to the application rather than to one host, so they survive the move
 * to Azure and are exercised by `npm run dev` as well as production.
 *
 * CSP allows self-hosted assets plus the inline styles and scripts the framework
 * emits, and forbids framing. `nosniff` also hardens owner-uploaded images that
 * are served without an explicit safe content type.
 */
const SECURITY_HEADERS: Record<string, string> = {
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
    "connect-src 'self' https://api.stripe.com",
    "font-src 'self' data:",
    "form-action 'self' https://checkout.stripe.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; "),
};

export function middleware() {
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  matcher: "/:path*",
};
