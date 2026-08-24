import { getD1, writeAudit } from "@/db/runtime";
import { nextClockState, type ClockAction, type ClockState } from "@/lib/domain";
import { loadClockEvents } from "@/lib/timeclock";

export class PunchError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export async function currentClockState(staffUserId: string): Promise<{ state: ClockState; sessionId: string | null }> {
  const events = await loadClockEvents(staffUserId, Date.now() - 30 * 86_400_000);
  let state: ClockState = "clocked_out";
  for (const event of events) state = nextClockState(state, event.action);
  return { state, sessionId: events.at(-1)?.session_id ?? null };
}

/**
 * Records a punch. C-06: the compare-and-swap on time_clock_state and the event
 * insert commit as one batch, and the event is written by `INSERT … SELECT …
 * WHERE transition_id = ?` so only the request that won the swap writes one. A
 * losing racer writes nothing rather than leaving the guard row ahead of the log.
 */
export async function recordPunch(
  staffUserId: string,
  action: ClockAction,
  source: "self_service" | "kiosk" | "manager",
): Promise<{ state: ClockState; occurredAt: number; sessionId: string }> {
  const { state, sessionId } = await currentClockState(staffUserId);
  const next = nextClockState(state, action);
  const now = Date.now();
  const database = getD1();
  await database
    .prepare(
      `INSERT INTO time_clock_state (staff_user_id, state, session_id, transition_id, updated_at)
       VALUES (?, ?, ?, NULL, ?) ON CONFLICT(staff_user_id) DO NOTHING`,
    )
    .bind(staffUserId, state, sessionId, now)
    .run();
  if (action !== "clock_in" && !sessionId) {
    throw new PunchError("No open clock session was found.");
  }
  const transitionId = crypto.randomUUID();
  const newSessionId = crypto.randomUUID();
  const casStatement =
    action === "clock_in"
      ? database
          .prepare(
            `UPDATE time_clock_state SET state = 'working', session_id = ?, transition_id = ?, updated_at = ?
             WHERE staff_user_id = ? AND state = 'clocked_out'`,
          )
          .bind(newSessionId, transitionId, now, staffUserId)
      : database
          .prepare(
            `UPDATE time_clock_state SET state = ?, transition_id = ?, updated_at = ?
             WHERE staff_user_id = ? AND state = ?`,
          )
          .bind(next, transitionId, now, staffUserId, state);
  const [cas] = await database.batch([
    casStatement,
    database
      .prepare(
        `INSERT INTO time_clock_events
         (id, staff_user_id, session_id, action, occurred_at, source, created_at)
         SELECT ?, staff_user_id, session_id, ?, ?, ?, ?
         FROM time_clock_state WHERE staff_user_id = ? AND transition_id = ?`,
      )
      .bind(crypto.randomUUID(), action, now, source, now, staffUserId, transitionId),
  ]);
  if (!cas.meta.changes) {
    throw new PunchError("Your clock state changed on another device. Refresh and try again.");
  }
  const resolvedSession = action === "clock_in" ? newSessionId : sessionId ?? newSessionId;
  await writeAudit({
    actorId: staffUserId,
    action: `timeclock.${action}`,
    targetType: "clock_session",
    targetId: resolvedSession,
    previous: { state },
    next: { state: next, source },
  });
  return { state: next, occurredAt: now, sessionId: resolvedSession };
}
