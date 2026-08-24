import type { PoolClient } from "pg";
import { ensureDatabase } from "@/db/runtime";
import { getPool } from "@/db/pg-driver";
import {
  inspectClockTimeline,
  nextClockState,
  type ClockAction,
  type ClockEventRecord,
  type ClockState,
  type ClockTimelineIssue,
} from "@/lib/domain";

export class PunchError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

export class ClockIntegrityError extends PunchError {
  issues: ClockTimelineIssue[];
  constructor(issues: ClockTimelineIssue[]) {
    super("This time record needs manager attention before another punch can be recorded.", 409);
    this.issues = issues;
  }
}

type StoredClockEvent = {
  id: string;
  staff_user_id: string;
  session_id: string;
  action: ClockAction;
  occurred_at: number;
  source: string;
  correction_of: string | null;
  created_at: number;
};

type AuditInput = {
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  previous?: unknown;
  next?: unknown;
  reason?: string;
};

const recordsFor = (events: StoredClockEvent[]): ClockEventRecord[] =>
  events.map((event) => ({
    id: event.id,
    action: event.action,
    occurredAt: event.occurred_at,
    sessionId: event.session_id,
  }));

async function loadEvents(client: PoolClient, staffUserId: string, lock = false): Promise<StoredClockEvent[]> {
  const result = await client.query<StoredClockEvent>(
    `SELECT id, staff_user_id, session_id, action, occurred_at, source, correction_of, created_at
     FROM time_clock_events WHERE staff_user_id = $1
     ORDER BY occurred_at, created_at, id${lock ? " FOR UPDATE" : ""}`,
    [staffUserId],
  );
  return result.rows;
}

async function audit(client: PoolClient, input: AuditInput, now: number): Promise<void> {
  await client.query(
    `INSERT INTO audit_log
     (id, actor_id, action, target_type, target_id, previous_json, next_json, reason, request_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)`,
    [
      crypto.randomUUID(),
      input.actorId,
      input.action,
      input.targetType,
      input.targetId,
      input.previous === undefined ? null : JSON.stringify(input.previous),
      input.next === undefined ? null : JSON.stringify(input.next),
      input.reason ?? null,
      now,
    ],
  );
}

async function lockStaff(client: PoolClient, staffUserId: string): Promise<void> {
  const staff = await client.query<{ active: number }>(
    "SELECT active FROM staff_users WHERE id = $1 FOR UPDATE",
    [staffUserId],
  );
  if (!staff.rows.length) throw new PunchError("That team member no longer exists.", 404);
  if (staff.rows[0].active !== 1) throw new PunchError("That team member is inactive.", 409);
}

async function syncState(
  client: PoolClient,
  staffUserId: string,
  timeline: ReturnType<typeof inspectClockTimeline>,
  now: number,
): Promise<void> {
  if (timeline.issues.length) throw new ClockIntegrityError(timeline.issues);
  if (timeline.state === "clocked_out") {
    await client.query(
      `INSERT INTO time_clock_state (staff_user_id, state, session_id, transition_id, updated_at)
       VALUES ($1, 'clocked_out', NULL, $2, $3)
       ON CONFLICT (staff_user_id) DO UPDATE SET state = 'clocked_out', session_id = NULL,
         transition_id = excluded.transition_id, updated_at = excluded.updated_at`,
      [staffUserId, crypto.randomUUID(), now],
    );
    return;
  }
  if (!timeline.sessionId) throw new PunchError("The open shift has no session identifier.", 409);
  await client.query(
    `INSERT INTO time_clock_state (staff_user_id, state, session_id, transition_id, updated_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (staff_user_id) DO UPDATE SET state = excluded.state, session_id = excluded.session_id,
       transition_id = excluded.transition_id, updated_at = excluded.updated_at`,
    [staffUserId, timeline.state, timeline.sessionId, crypto.randomUUID(), now],
  );
}

/** A punch mutation changes the evidence behind a signed timesheet. Preserve the
 * approval row for audit/history, but force a manager to review it again. */
async function invalidateApprovals(
  client: PoolClient,
  staffUserId: string,
  occurredAt: number,
  secondOccurredAt = occurredAt,
): Promise<void> {
  await client.query(
    `UPDATE timesheet_approvals SET status = 'needs_review'
     WHERE staff_user_id = $1 AND status = 'approved'
       AND (($2 >= period_start AND $2 < period_end) OR ($3 >= period_start AND $3 < period_end))`,
    [staffUserId, occurredAt, secondOccurredAt],
  );
}

async function inClockTransaction<T>(staffUserId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureDatabase();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockStaff(client, staffUserId);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type ClockStatus = {
  state: ClockState;
  sessionId: string | null;
  issues: ClockTimelineIssue[];
};

/** Non-throwing read so damaged legacy data can be explained on-screen. */
export async function inspectCurrentClockState(staffUserId: string): Promise<ClockStatus> {
  await ensureDatabase();
  const [eventsResult, stateResult] = await Promise.all([
    getPool().query<StoredClockEvent>(
      `SELECT id, staff_user_id, session_id, action, occurred_at, source, correction_of, created_at
       FROM time_clock_events WHERE staff_user_id = $1 ORDER BY occurred_at, created_at, id`,
      [staffUserId],
    ),
    getPool().query<{ state: ClockState; session_id: string | null }>(
      "SELECT state, session_id FROM time_clock_state WHERE staff_user_id = $1",
      [staffUserId],
    ),
  ]);
  const timeline = inspectClockTimeline(recordsFor(eventsResult.rows));
  const guard = stateResult.rows[0];
  const issues = [...timeline.issues];
  if (guard && guard.state !== timeline.state) {
    issues.push({
      eventId: null,
      action: timeline.state === "clocked_out" ? "clock_out" : "clock_in",
      occurredAt: Date.now(),
      stateBefore: guard.state,
      message: "The live clock status does not match the punch history.",
    });
  } else if (guard && timeline.state !== "clocked_out" && guard.session_id !== timeline.sessionId) {
    issues.push({
      eventId: null,
      action: timeline.state === "on_break" ? "break_start" : "clock_in",
      occurredAt: Date.now(),
      stateBefore: guard.state,
      message: "The live clock session does not match the punch history.",
    });
  } else if (!guard && timeline.state !== "clocked_out") {
    issues.push({
      eventId: null,
      action: "clock_in",
      occurredAt: Date.now(),
      stateBefore: timeline.state,
      message: "The live clock status is missing for an open shift.",
    });
  }
  return { state: timeline.state, sessionId: timeline.sessionId, issues };
}

export async function currentClockState(staffUserId: string): Promise<{ state: ClockState; sessionId: string | null }> {
  const status = await inspectCurrentClockState(staffUserId);
  if (status.issues.length) throw new ClockIntegrityError(status.issues);
  return { state: status.state, sessionId: status.sessionId };
}

/** Records a live punch while holding the same employee lock used by manager edits. */
export async function recordPunch(
  staffUserId: string,
  action: ClockAction,
  source: "self_service" | "kiosk" | "manager",
  actorId = staffUserId,
): Promise<{ state: ClockState; occurredAt: number; sessionId: string }> {
  return inClockTransaction(staffUserId, async (client) => {
    const events = await loadEvents(client, staffUserId, true);
    const timeline = inspectClockTimeline(recordsFor(events));
    if (timeline.issues.length) throw new ClockIntegrityError(timeline.issues);
    const next = nextClockState(timeline.state, action);
    const now = Date.now();
    const sessionId = action === "clock_in" ? crypto.randomUUID() : timeline.sessionId;
    if (!sessionId) throw new PunchError("No open clock session was found.");
    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO time_clock_events
       (id, staff_user_id, session_id, action, occurred_at, source, correction_of, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$5)`,
      [id, staffUserId, sessionId, action, now, source],
    );
    const nextTimeline = inspectClockTimeline([
      ...recordsFor(events),
      { id, action, occurredAt: now, sessionId },
    ]);
    await invalidateApprovals(client, staffUserId, now);
    await syncState(client, staffUserId, nextTimeline, now);
    await audit(client, {
      actorId,
      action: `timeclock.${action}`,
      targetType: "clock_session",
      targetId: sessionId,
      previous: { state: timeline.state },
      next: { state: next, source, staffUserId },
    }, now);
    return { state: next, occurredAt: now, sessionId };
  });
}

export async function insertManagerClockEvent(input: {
  actorId: string;
  staffUserId: string;
  action: ClockAction;
  occurredAt: number;
}): Promise<{ id: string }> {
  return inClockTransaction(input.staffUserId, async (client) => {
    const events = await loadEvents(client, input.staffUserId, true);
    const current = inspectClockTimeline(recordsFor(events));
    if (current.issues.length) throw new ClockIntegrityError(current.issues);
    if (input.occurredAt > Date.now() + 5 * 60_000) throw new PunchError("A punch cannot be added in the future.", 400);
    if (events.some((event) => event.action === input.action && event.occurred_at === input.occurredAt)) {
      throw new PunchError("That exact punch is already recorded.", 409);
    }
    const before = inspectClockTimeline(recordsFor(events.filter((event) => event.occurred_at <= input.occurredAt)));
    if (before.issues.length) throw new ClockIntegrityError(before.issues);
    const sessionId = input.action === "clock_in" ? crypto.randomUUID() : before.sessionId;
    if (!sessionId) throw new PunchError("Add the matching clock-in before this punch.", 409);
    const id = crypto.randomUUID();
    const now = Date.now();
    const proposed: StoredClockEvent = {
      id,
      staff_user_id: input.staffUserId,
      session_id: sessionId,
      action: input.action,
      occurred_at: input.occurredAt,
      source: "manager",
      correction_of: null,
      created_at: now,
    };
    const next = inspectClockTimeline(recordsFor([...events, proposed].sort((a, b) => a.occurred_at - b.occurred_at || a.created_at - b.created_at || a.id.localeCompare(b.id))));
    if (next.issues.length) throw new ClockIntegrityError(next.issues);
    await client.query(
      `INSERT INTO time_clock_events
       (id, staff_user_id, session_id, action, occurred_at, source, correction_of, created_at)
       VALUES ($1,$2,$3,$4,$5,'manager',NULL,$6)`,
      [id, input.staffUserId, sessionId, input.action, input.occurredAt, now],
    );
    await invalidateApprovals(client, input.staffUserId, input.occurredAt);
    await syncState(client, input.staffUserId, next, now);
    await audit(client, {
      actorId: input.actorId,
      action: "timeclock.event.insert",
      targetType: "clock_event",
      targetId: id,
      next: { staffUserId: input.staffUserId, punch: input.action, occurredAt: input.occurredAt },
    }, now);
    return { id };
  });
}

export async function deleteManagerClockEvent(input: { actorId: string; eventId: string }): Promise<void> {
  await ensureDatabase();
  const event = await getPool().query<{ staff_user_id: string }>(
    "SELECT staff_user_id FROM time_clock_events WHERE id = $1",
    [input.eventId],
  );
  if (!event.rows.length) throw new PunchError("That clock entry no longer exists.", 404);
  await inClockTransaction(event.rows[0].staff_user_id, async (client) => {
    const events = await loadEvents(client, event.rows[0].staff_user_id, true);
    const previous = events.find((row) => row.id === input.eventId);
    if (!previous) throw new PunchError("That clock entry no longer exists.", 404);
    const next = inspectClockTimeline(recordsFor(events.filter((row) => row.id !== input.eventId)));
    if (next.issues.length) throw new PunchError("Removing that punch would leave an invalid time record.", 409);
    const now = Date.now();
    await client.query("DELETE FROM time_clock_events WHERE id = $1", [input.eventId]);
    await invalidateApprovals(client, previous.staff_user_id, previous.occurred_at);
    await syncState(client, previous.staff_user_id, next, now);
    await audit(client, {
      actorId: input.actorId,
      action: "timeclock.event.delete",
      targetType: "clock_event",
      targetId: input.eventId,
      previous,
    }, now);
  });
}

export async function adjustManagerClockEvent(input: { actorId: string; eventId: string; occurredAt: number }): Promise<void> {
  await ensureDatabase();
  const event = await getPool().query<{ staff_user_id: string }>(
    "SELECT staff_user_id FROM time_clock_events WHERE id = $1",
    [input.eventId],
  );
  if (!event.rows.length) throw new PunchError("That clock entry no longer exists.", 404);
  await inClockTransaction(event.rows[0].staff_user_id, async (client) => {
    const events = await loadEvents(client, event.rows[0].staff_user_id, true);
    const previous = events.find((row) => row.id === input.eventId);
    if (!previous) throw new PunchError("That clock entry no longer exists.", 404);
    if (input.occurredAt > Date.now() + 5 * 60_000) throw new PunchError("A punch cannot be moved into the future.", 400);
    if (events.some((row) => row.id !== input.eventId && row.action === previous.action && row.occurred_at === input.occurredAt)) {
      throw new PunchError("That exact punch is already recorded.", 409);
    }
    const proposed = events
      .map((row) => row.id === input.eventId ? { ...row, occurred_at: input.occurredAt, source: "manager" } : row)
      .sort((a, b) => a.occurred_at - b.occurred_at || a.created_at - b.created_at || a.id.localeCompare(b.id));
    const next = inspectClockTimeline(recordsFor(proposed));
    if (next.issues.length) throw new PunchError("Moving that punch would leave an invalid time record.", 409);
    const now = Date.now();
    await client.query("UPDATE time_clock_events SET occurred_at = $1, source = 'manager' WHERE id = $2", [input.occurredAt, input.eventId]);
    await invalidateApprovals(client, previous.staff_user_id, previous.occurred_at, input.occurredAt);
    await syncState(client, previous.staff_user_id, next, now);
    await audit(client, {
      actorId: input.actorId,
      action: "timeclock.event.adjust",
      targetType: "clock_event",
      targetId: input.eventId,
      previous,
      next: { occurredAt: input.occurredAt },
    }, now);
  });
}

export async function resolveClockCorrection(input: {
  actorId: string;
  requestId: string;
  approve: boolean;
  note?: string;
}): Promise<void> {
  await ensureDatabase();
  const owner = await getPool().query<{ staff_user_id: string }>(
    "SELECT staff_user_id FROM correction_requests WHERE id = $1",
    [input.requestId],
  );
  if (!owner.rows.length) throw new PunchError("That correction request no longer exists.", 404);
  await inClockTransaction(owner.rows[0].staff_user_id, async (client) => {
    const request = await client.query<{
      id: string;
      staff_user_id: string;
      event_id: string;
      requested_time: number;
      status: string;
    }>("SELECT id, staff_user_id, event_id, requested_time, status FROM correction_requests WHERE id = $1 FOR UPDATE", [input.requestId]);
    const row = request.rows[0];
    if (!row || row.status !== "pending") throw new PunchError("That request has already been handled.", 409);
    const now = Date.now();
    if (input.approve) {
      if (row.requested_time > now + 5 * 60_000) throw new PunchError("A punch cannot be moved into the future.", 400);
      const events = await loadEvents(client, row.staff_user_id, true);
      const previous = events.find((event) => event.id === row.event_id);
      if (!previous) throw new PunchError("The punch attached to this request no longer exists.", 409);
      const proposed = events
        .map((event) => event.id === row.event_id ? { ...event, occurred_at: row.requested_time, source: "manager" } : event)
        .sort((a, b) => a.occurred_at - b.occurred_at || a.created_at - b.created_at || a.id.localeCompare(b.id));
      const timeline = inspectClockTimeline(recordsFor(proposed));
      if (timeline.issues.length) throw new PunchError("That corrected time would leave an invalid punch sequence.", 409);
      await client.query("UPDATE time_clock_events SET occurred_at = $1, source = 'manager' WHERE id = $2", [row.requested_time, row.event_id]);
      await invalidateApprovals(client, row.staff_user_id, previous.occurred_at, row.requested_time);
      await syncState(client, row.staff_user_id, timeline, now);
    }
    const resolved = await client.query(
      `UPDATE correction_requests SET status = $1, reviewer_id = $2, reviewer_note = $3, updated_at = $4
       WHERE id = $5 AND status = 'pending'`,
      [input.approve ? "approved" : "declined", input.actorId, input.note?.slice(0, 500) || null, now, input.requestId],
    );
    if (resolved.rowCount !== 1) throw new PunchError("That request has already been handled.", 409);
    await audit(client, {
      actorId: input.actorId,
      action: "timeclock.correction.resolve",
      targetType: "correction_request",
      targetId: input.requestId,
      previous: row,
      next: { approve: input.approve, note: input.note?.slice(0, 500) || null },
    }, now);
  });
}
