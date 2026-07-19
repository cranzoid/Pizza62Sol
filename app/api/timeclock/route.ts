import { authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1, writeAudit } from "@/db/runtime";
import {
  calculatePaidMilliseconds,
  nextClockState,
  type ClockAction,
  type ClockState,
} from "@/lib/domain";

async function clockData(staffUserId: string) {
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const events = await getD1()
    .prepare(
      `SELECT id, session_id, action, occurred_at, source
       FROM time_clock_events WHERE staff_user_id = ? AND occurred_at >= ? ORDER BY occurred_at`,
    )
    .bind(staffUserId, since)
    .all<{ id: string; session_id: string; action: ClockAction; occurred_at: number; source: string }>();
  let state: ClockState = "clocked_out";
  for (const event of events.results) state = nextClockState(state, event.action);
  const paidMs = calculatePaidMilliseconds(
    events.results.map((event) => ({ action: event.action, occurredAt: event.occurred_at })),
  );
  const [corrections, timeOff] = await Promise.all([
    getD1()
      .prepare("SELECT * FROM correction_requests WHERE staff_user_id = ? ORDER BY created_at DESC LIMIT 20")
      .bind(staffUserId)
      .all(),
    getD1()
      .prepare("SELECT * FROM time_off_requests WHERE staff_user_id = ? ORDER BY created_at DESC LIMIT 20")
      .bind(staffUserId)
      .all(),
  ]);
  return { state, paidMs, events: events.results, corrections: corrections.results, timeOff: timeOff.results };
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request);
    return Response.json({ user, ...(await clockData(user.id)) });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request);
    const body = (await request.json()) as
      | { action?: ClockAction }
      | { action?: "correction.request"; eventId?: string; requestedTime?: number; reason?: string }
      | { action?: "timeoff.request"; startsAt?: number; endsAt?: number; partialDay?: boolean; note?: string };
    if (["clock_in", "break_start", "break_end", "clock_out"].includes(body.action ?? "")) {
      const action = body.action as ClockAction;
      const data = await clockData(user.id);
      const next = nextClockState(data.state, action);
      const last = data.events.at(-1);
      const sessionId = action === "clock_in" ? crypto.randomUUID() : last?.session_id;
      if (!sessionId) return Response.json({ error: "No open clock session was found." }, { status: 409 });
      const now = Date.now();
      await getD1()
        .prepare(
          `INSERT INTO time_clock_events
           (id, staff_user_id, session_id, action, occurred_at, source, created_at)
           VALUES (?, ?, ?, ?, ?, 'self_service', ?)`,
        )
        .bind(crypto.randomUUID(), user.id, sessionId, action, now, now)
        .run();
      await writeAudit({ actorId: user.id, action: `timeclock.${action}`, targetType: "clock_session", targetId: sessionId, previous: { state: data.state }, next: { state: next } });
      return Response.json({ ok: true, state: next, occurredAt: now });
    }
    if (body.action === "correction.request") {
      const event = await getD1()
        .prepare("SELECT id, occurred_at FROM time_clock_events WHERE id = ? AND staff_user_id = ?")
        .bind(body.eventId ?? "", user.id)
        .first();
      const requestedTime = body.requestedTime;
      const reason = body.reason?.trim() ?? "";
      if (!event || !Number.isSafeInteger(requestedTime) || reason.length < 5 || reason.length > 500) {
        return Response.json({ error: "Choose a valid clock event, corrected time, and reason." }, { status: 400 });
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      await getD1()
        .prepare(
          `INSERT INTO correction_requests
           (id, staff_user_id, event_id, requested_time, reason, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(id, user.id, body.eventId, requestedTime, reason, now, now)
        .run();
      return Response.json({ ok: true, id }, { status: 201 });
    }
    if (body.action === "timeoff.request") {
      const startsAt = body.startsAt;
      const endsAt = body.endsAt;
      const note = body.note?.trim() ?? "";
      if (!Number.isSafeInteger(startsAt) || !Number.isSafeInteger(endsAt) || Number(endsAt) < Number(startsAt) || note.length > 500) {
        return Response.json({ error: "Choose a valid date range and note." }, { status: 400 });
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      await getD1()
        .prepare(
          `INSERT INTO time_off_requests
           (id, staff_user_id, starts_at, ends_at, partial_day, note, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .bind(id, user.id, startsAt, endsAt, body.partialDay ? 1 : 0, note || null, now, now)
        .run();
      return Response.json({ ok: true, id }, { status: 201 });
    }
    return Response.json({ error: "Unsupported time-clock action." }, { status: 400 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid time-clock transition")) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return authErrorResponse(error);
  }
}
