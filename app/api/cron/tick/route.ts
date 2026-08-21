/**
 * The background work, driven by a timer that lives outside the app.
 *
 * On Container Apps these were three scheduled Jobs. App Service has no
 * equivalent — Linux App Service does not support WebJobs — so the same work is
 * an authenticated endpoint that a Logic App calls on a recurrence. That is the
 * pattern already running in this Azure subscription for the CRM
 * (`logic-ptcd-hourly` → `POST /api/cron/tick`), so it is one operational shape
 * to understand rather than two.
 *
 * There are three things to do and they run every tick:
 *
 * - **Drain the notification outbox.** The audit's central finding. Inline
 *   dispatch fires on every order, so this is the sweeper that catches whatever
 *   the inline attempt missed — a replica that died mid-send, a provider that was
 *   briefly down, a row parked before credentials existed.
 * - **Reap abandoned checkouts.** Clover sends no expiry event and its sessions
 *   last 15 minutes, so an abandoned checkout would otherwise sit in the staff
 *   queue looking live forever.
 * - **Re-call the restaurant** about an order nobody has acknowledged.
 *
 * ## Why this is safe to expose
 *
 * A shared secret in the `Authorization` header, compared in constant time. The
 * work is idempotent and individually guarded — every mutation is conditional on
 * the state it expects — so the worst an attacker who guessed the secret could
 * do is make the sweeps run more often than scheduled, which is what they are
 * designed to tolerate.
 *
 * Without a secret configured it fails closed. An open endpoint that dispatches
 * notifications is a way to make the restaurant's phone ring from the internet.
 */
import { dispatchOutbox, requeueUnacknowledgedOrders } from "@/lib/notifications/dispatcher";
import { reapStalePayments } from "@/scripts/reap-payments";
import { PostgresDatabase, getPool } from "@/db/pg-driver";
import { readIntegrationSecret } from "@/lib/integration-secrets";
import { env } from "@/lib/runtime-env";
import { logFailure } from "@/lib/log";

/** Length-independent, so a wrong secret cannot be narrowed by timing. */
function secretMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < presented.length; index += 1) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

async function authorize(request: Request): Promise<boolean> {
  const configured =
    (env as unknown as Record<string, string | undefined>).CRON_SECRET?.trim() ||
    (await readIntegrationSecret("CRON_SECRET"));
  // Fail closed. An unauthenticated endpoint that sends notifications and places
  // calls is a way to make the restaurant's phone ring from the internet.
  if (!configured) return false;

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  return Boolean(presented) && secretMatches(presented, configured);
}

export async function POST(request: Request) {
  if (!(await authorize(request))) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const startedAt = Date.now();
  const results: Record<string, unknown> = {};
  const failures: string[] = [];

  /**
   * Each sweep is isolated.
   *
   * One failing must not stop the others: a Postgres hiccup in the reaper would
   * otherwise silence every notification for as long as it lasted, and the
   * notifications are the part customers can see.
   */
  const run = async (name: string, work: () => Promise<unknown>) => {
    try {
      results[name] = await work();
    } catch (error) {
      failures.push(name);
      results[name] = { error: error instanceof Error ? error.message : String(error) };
      logFailure(`cron.${name}`, error);
    }
  };

  await run("outbox", () => dispatchOutbox({ limit: 50 }));
  await run("payments", async () => {
    const cancelled = await reapStalePayments(new PostgresDatabase(getPool()));
    return { cancelled };
  });
  await run("unacknowledged", async () => ({ requeued: await requeueUnacknowledgedOrders() }));

  // 207 when something failed: the caller is a Logic App, and a plain 200 would
  // make a persistently broken sweep invisible until a customer noticed. A 5xx
  // would be wrong too — the tick itself ran.
  return Response.json(
    { ok: failures.length === 0, failures, durationMs: Date.now() - startedAt, ...results },
    { status: failures.length ? 207 : 200 },
  );
}
