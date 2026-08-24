/**
 * Server-side error logging for handlers that deliberately return a vague 500.
 *
 * The customer-facing message for a failed order is intentionally uninformative
 * — it must not leak a constraint name or a stack trace to the internet. But the
 * original code discarded the error entirely, so a failure had *no* record
 * anywhere. That is not a theoretical cost: a schema change that made every
 * online order fail presented as a bare 500 with nothing to go on, and finding
 * it meant re-running the call by hand outside the route.
 *
 * So: opaque to the caller, specific in the logs. `console.error` is the right
 * sink because App Service ships stdout/stderr to Log Analytics and App
 * Insights without an SDK, which is also what the alert rules query.
 */

/** Correlates the log line with the response the caller was given. */
export function newRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Logs an unexpected failure and returns the id to hand back to the caller.
 *
 * Pass `context` for whatever narrows the search without being sensitive — a
 * route name, an order number, a job name. Never a token, a card, or a payload.
 */
export function logFailure(scope: string, error: unknown, context?: Record<string, unknown>): string {
  const requestId = newRequestId();
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const extra = context && Object.keys(context).length ? ` ${JSON.stringify(context)}` : "";
  console.error(`[${scope}] ${requestId} ${detail}${extra}`);
  if (error instanceof Error && error.stack) console.error(error.stack);
  return requestId;
}
