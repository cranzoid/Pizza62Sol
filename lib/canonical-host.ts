type CanonicalRedirectInput = {
  requestUrl: string;
  forwardedHost?: string | null;
  publicBaseUrl?: string | null;
};

const LEGACY_PUBLIC_PATHS: Record<string, string> = {
  "/menu": "/#menu",
  "/online-ordering": "/#menu",
  "/cart-page": "/#menu",
  "/my-orders": "/track",
  "/my-subscriptions": "/",
};

/** Preserves useful Wix-era entry points when the custom domain moves to Azure. */
export function legacyRedirectUrl({ requestUrl, publicBaseUrl }: CanonicalRedirectInput): string | null {
  try {
    const request = new URL(requestUrl);
    const targetPath = LEGACY_PUBLIC_PATHS[request.pathname.replace(/\/$/, "") || "/"];
    if (!targetPath) return null;
    const base = new URL(publicBaseUrl || request.origin);
    return new URL(targetPath, base.origin).toString();
  } catch {
    return null;
  }
}

/**
 * Redirect only the www alias to the configured apex hostname.
 *
 * The Azure default hostname must remain reachable because App Service uses it
 * for health probes. Restricting this to the exact www alias avoids turning a
 * health check into a redirect while still giving search engines one origin.
 */
export function canonicalRedirectUrl({
  requestUrl,
  forwardedHost,
  publicBaseUrl,
}: CanonicalRedirectInput): string | null {
  if (!publicBaseUrl) return null;

  try {
    const request = new URL(requestUrl);
    const canonical = new URL(publicBaseUrl);
    const firstForwardedHost = forwardedHost?.split(",", 1)[0]?.trim();
    const effectiveHost = (firstForwardedHost || request.host).replace(/:\d+$/, "").toLowerCase();

    if (effectiveHost !== `www.${canonical.hostname.toLowerCase()}`) return null;

    const target = new URL(canonical.origin);
    target.pathname = request.pathname;
    target.search = request.search;
    return target.toString();
  } catch {
    return null;
  }
}
