import { ensureDatabase, getD1 } from "@/db/runtime";
import { hashOpaqueToken } from "@/lib/domain";

/**
 * Resolves the caller's IP from the proxy chain in front of the app.
 *
 * Getting this wrong is not a small bug: the previous implementation fell back
 * to the literal string `"local"` whenever no header was present, which put
 * every anonymous visitor in the same bucket. Off Cloudflare that fallback is
 * the *normal* path, so eight feedback submissions from anywhere on the internet
 * would lock out every other customer, and — worse — the order-create limiter
 * would throttle the whole restaurant after twelve orders.
 *
 * Two headers matter, in this order:
 *
 * - `X-Azure-ClientIP` is set by Front Door and holds the true client address.
 *   Front Door overwrites whatever the client sent, so it cannot be forged.
 *
 * - `X-Forwarded-For` is appended to by the Container Apps ingress. The
 *   **last** entry is the one Azure added; anything to its left was supplied by
 *   the caller and is attacker-controlled. Reading the first entry — as the old
 *   code did — lets anyone mint a fresh bucket per request by sending a made-up
 *   value, which defeats the limiter entirely.
 *
 * Note the ordering is load-bearing when Front Door is enabled: the ingress then
 * appends *Front Door's* edge IP to `X-Forwarded-For`, so the rightmost entry
 * would be shared by every visitor. `X-Azure-ClientIP` has to win.
 */
export function trustsProxyHeaders(): boolean {
  return process.env.TRUST_PROXY_HEADERS === "true";
}

export function resolveClientIdentity(request: Request): string | null {
  const azureClientIp = request.headers.get("x-azure-clientip")?.trim();
  if (azureClientIp) return azureClientIp;

  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const hops = forwardedFor
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    const nearest = hops.at(-1);
    // Container Apps appends "ip:port" in some configurations.
    if (nearest) return nearest.replace(/:\d+$/, "");
  }

  return null;
}

/**
 * Consumes one unit of the caller's budget for `scope`, throwing once it is
 * spent.
 *
 * The whole window is one statement. The old read-then-write pair raced with
 * itself, which was survivable on a single Worker but is not on Container Apps:
 * with replicas running concurrently, N simultaneous requests all read the same
 * pre-increment count and all pass. `ON CONFLICT DO UPDATE … RETURNING` makes
 * the decision atomic in the database, where the contention actually is.
 *
 * The `rate_limits.` qualifiers are required, not stylistic — a bare
 * `window_started_at` inside `DO UPDATE SET` is ambiguous in Postgres and fails
 * at runtime, invisible to typecheck.
 */
export async function enforceRateLimit(
  request: Request,
  scope: string,
  maxAttempts: number,
  windowMs: number,
): Promise<void> {
  await ensureDatabase();

  const identity = resolveClientIdentity(request);
  if (!identity) {
    // No trusted header.
    //
    // Whether that is an emergency depends on the deployment, so the deployment
    // has to say. `TRUST_PROXY_HEADERS` is set by Terraform on the Container App
    // (container_app.tf) and asserts "every request reaching this process has
    // passed through an ingress that stamps the client address". Under that
    // promise a request without one is either a misconfigured proxy or a caller
    // that bypassed the ingress, and both should be refused rather than waved
    // through on a key they would share with everyone else.
    //
    // Off — local runs, tests, anything direct — there is no proxy to trust and
    // a fixed identity is the honest answer. This is deliberately not keyed on
    // NODE_ENV: `vinext start` sets that to production, which would make every
    // local request fail closed and leave production-mode testing impossible.
    if (trustsProxyHeaders()) throw new RateLimitError();
    return applyRateLimit(`${scope}:direct`, maxAttempts, windowMs);
  }

  return applyRateLimit(`${scope}:${identity}`, maxAttempts, windowMs);
}

async function applyRateLimit(key: string, maxAttempts: number, windowMs: number): Promise<void> {
  const keyHash = await hashOpaqueToken(key);
  const now = Date.now();

  const row = await getD1()
    .prepare(
      `INSERT INTO rate_limits (key_hash, window_started_at, attempts, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(key_hash) DO UPDATE SET
         window_started_at = CASE
           WHEN ? - rate_limits.window_started_at >= ? THEN ?
           ELSE rate_limits.window_started_at END,
         attempts = CASE
           WHEN ? - rate_limits.window_started_at >= ? THEN 1
           ELSE rate_limits.attempts + 1 END,
         updated_at = ?
       RETURNING attempts`,
    )
    .bind(keyHash, now, now, now, windowMs, now, now, windowMs, now)
    .first<{ attempts: number }>();

  // `attempts` counts the request being served, so the budget is spent only
  // once it exceeds the maximum.
  if (row && row.attempts > maxAttempts) throw new RateLimitError();
}

export class RateLimitError extends Error {
  readonly status = 429;
  constructor() {
    super("Too many attempts. Please wait and try again.");
  }
}
