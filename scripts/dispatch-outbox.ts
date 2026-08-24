/**
 * Drains `notification_outbox`.
 *
 * Runs as the `outbox-dispatcher` Container Apps job every minute. It is the
 * retry sweeper and the safety net, not the primary path: the routes dispatch
 * inline the moment an order becomes real, so the customer and the kitchen hear
 * about it in seconds rather than waiting on the one-minute cron floor. What
 * this catches is everything inline dispatch could not — a provider that was
 * down, a container that died between commit and send, a row parked while
 * credentials were still missing.
 *
 * Safe to run concurrently with itself and with inline dispatch: rows are
 * claimed with `FOR UPDATE SKIP LOCKED`, so two workers never take the same one.
 */
import { closePool } from "@/db/pg-driver";
import { dispatchOutbox, requeueUnacknowledgedOrders } from "@/lib/notifications/dispatcher";

async function main(): Promise<void> {
  try {
    // Re-queue first, so an order that has gone unacknowledged for another
    // interval is picked up by the same pass rather than waiting for the next.
    const requeued = await requeueUnacknowledgedOrders();
    if (requeued) console.log(`re-queued ${requeued} unacknowledged order call(s)`);

    const outcome = await dispatchOutbox({ limit: 50 });
    console.log(
      outcome.claimed
        ? `claimed ${outcome.claimed}: ${outcome.sent} sent, ${outcome.retried} retrying, ${outcome.failed} failed, ${outcome.parked} parked`
        : "nothing due",
    );
  } finally {
    await closePool();
  }
}

// Guarded so tests can import nothing from here without connecting.
if (process.argv[1]?.endsWith("dispatch-outbox.ts")) {
  await main();
}
