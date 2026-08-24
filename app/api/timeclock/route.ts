import { authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1 } from "@/db/runtime";
import { type ClockAction } from "@/lib/domain";
import { loadProfile, loadShifts, resolvePeriod, timeClockSettings, timesheetFor } from "@/lib/timeclock";
import { PunchError, currentClockState, recordPunch } from "@/lib/timeclock-punch";

const PUNCHES = new Set(["clock_in", "break_start", "break_end", "clock_out"]);

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request);
    const url = new URL(request.url);
    const offset = Math.max(-26, Math.min(0, Number(url.searchParams.get("period") ?? 0) || 0));
    const now = Date.now();
    const settings = await timeClockSettings();
    const profile = await loadProfile(user.id);
    const period = resolvePeriod(now, settings, offset);
    const [timesheet, state, shifts, requests] = await Promise.all([
      timesheetFor(user.id, period, settings, profile, now),
      currentClockState(user.id),
      // Two weeks of the employee's own published schedule, plus anything they are
      // still finishing today.
      loadShifts(now - 86_400_000, now + 14 * 86_400_000, user.id),
      Promise.all([
        getD1().prepare("SELECT * FROM correction_requests WHERE staff_user_id = ? ORDER BY created_at DESC LIMIT 20").bind(user.id).all(),
        getD1().prepare("SELECT * FROM time_off_requests WHERE staff_user_id = ? ORDER BY created_at DESC LIMIT 20").bind(user.id).all(),
        getD1().prepare("SELECT * FROM timesheet_approvals WHERE staff_user_id = ? ORDER BY period_start DESC LIMIT 6").bind(user.id).all(),
      ]),
    ]);
    const [corrections, timeOff, approvals] = requests;
    return Response.json({
      user,
      state: state.state,
      // Kept for the existing employee screen, which reads paidMs directly.
      paidMs: timesheet.totalPaidMs,
      period: { ...period, label: settings.period, timeZone: settings.timeZone, offset },
      profile: {
        jobTitle: profile.job_title,
        employmentType: profile.employment_type,
        wageCents: profile.wage_cents,
        weeklyOvertimeMinutes: profile.weekly_overtime_minutes,
        hasPin: Boolean(profile.pin_hash),
        availability: JSON.parse(profile.availability_json || "[]"),
      },
      timesheet: {
        days: timesheet.days,
        sessions: timesheet.sessions,
        totalPaidMs: timesheet.totalPaidMs,
        totalBreakMs: timesheet.totalBreakMs,
        regularMs: timesheet.regularMs,
        overtimeMs: timesheet.overtimeMs,
        weeks: timesheet.weeks,
        grossPayCents: timesheet.grossPayCents,
        openSession: timesheet.openSession,
      },
      shifts: shifts.filter((shift) => shift.published),
      events: (await getD1()
        .prepare("SELECT id, action, occurred_at, session_id, source FROM time_clock_events WHERE staff_user_id = ? ORDER BY occurred_at DESC LIMIT 40")
        .bind(user.id)
        .all()).results.reverse(),
      corrections: corrections.results,
      timeOff: timeOff.results,
      approvals: approvals.results,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request);
    const body = (await request.json()) as {
      action?: string;
      eventId?: string;
      requestedTime?: number;
      reason?: string;
      startsAt?: number;
      endsAt?: number;
      partialDay?: boolean;
      note?: string;
      pin?: string;
      availability?: unknown;
    };
    if (PUNCHES.has(body.action ?? "")) {
      const result = await recordPunch(user.id, body.action as ClockAction, "self_service");
      return Response.json({ ok: true, state: result.state, occurredAt: result.occurredAt });
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
    if (body.action === "availability.update") {
      // Seven rows of {available, startMinute, endMinute}, one per weekday.
      const availability = Array.isArray(body.availability) ? body.availability.slice(0, 7) : null;
      if (!availability || availability.some((row) => {
        const entry = row as Record<string, unknown>;
        return typeof entry !== "object" || !Number.isInteger(entry.startMinute) || !Number.isInteger(entry.endMinute) ||
          Number(entry.startMinute) < 0 || Number(entry.endMinute) > 1440 || Number(entry.startMinute) > Number(entry.endMinute);
      })) {
        return Response.json({ error: "Enter a valid time range for each day." }, { status: 400 });
      }
      const now = Date.now();
      await getD1()
        .prepare(
          `INSERT INTO staff_profiles (staff_user_id, availability_json, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(staff_user_id) DO UPDATE SET availability_json = excluded.availability_json, updated_at = excluded.updated_at`,
        )
        .bind(user.id, JSON.stringify(availability), now, now)
        .run();
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Unsupported time-clock action." }, { status: 400 });
  } catch (error) {
    if (error instanceof PunchError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && error.message.startsWith("Invalid time-clock transition")) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return authErrorResponse(error);
  }
}
