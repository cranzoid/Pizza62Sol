import { NextResponse } from "next/server";
import { securityHeadersFor } from "@/lib/security-headers";

/**
 * Applies the security headers to every response.
 *
 * The policy itself lives in `lib/security-headers.ts`, not here. That module is
 * importable by the test suite — this one is not, because `next/server` cannot
 * be resolved by the plain Node loader the tests run under — and keeping the
 * rules out of the framework's middleware API matters because that API is
 * already deprecated in favour of `proxy.ts`. When that rename happens, only
 * this file moves.
 */
export function middleware(request: Request) {
  const response = NextResponse.next();
  for (const [name, value] of Object.entries(securityHeadersFor(new URL(request.url).pathname))) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = {
  matcher: "/:path*",
};
