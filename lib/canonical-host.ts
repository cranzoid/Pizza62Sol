type CanonicalRedirectInput = {
  requestUrl: string;
  forwardedHost?: string | null;
  publicBaseUrl?: string | null;
};

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
