import { authErrorResponse, createPinHash, requireStaff, validatePin, verifyPin } from "@/lib/auth";
import { ensureDatabase, getD1, writeAudit } from "@/db/runtime";
import { ONTARIO_WEEKLY_OVERTIME_MINUTES, hasPermission, type ClockAction } from "@/lib/domain";
import {
  csvCell,
  hoursFromMs,
  loadProfile,
  loadShifts,
  resolvePeriod,
  timeClockSettings,
  timesheetFor,
  type StaffProfile,
} from "@/lib/timeclock";
import { PunchError, recordPunch } from "@/lib/timeclock-punch";

type TeamMember = { id: string; name: string; email: string; role: string; active: number };

async function team(): Promise<TeamMember[]> {
  const rows = await getD1()
    .prepare("SELECT id, name, email, role, active FROM staff_users ORDER BY active DESC, name")
    .all<TeamMember>();
  return rows.results;
}

async function profilesFor(ids: string[]): Promise<Map<string, StaffProfile>> {
  const profiles = await Promise.all(ids.map((id) => loadProfile(id)));
  return new Map(profiles.map((profile) => [profile.staff_user_id, profile]));
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    // Viewing the team's time needs either the record-editing or the payroll
    // permission; approving and editing are checked again on each write below.
    const user = await requireStaff(request);
    const canView = user.role === "owner" || ["edit_time_records", "export_payroll", "manage_employees", "approve_time_off_requests", "approve_correction_requests"]
      .some((permission) => hasPermission(user.role, user.permissions, permission));
    if (!canView) return Response.json({ error: "You do not have permission to view team time records." }, { status: 403 });
    const url = new URL(request.url);
    const now = Date.now();
    const settings = await timeClockSettings();
    const offset = Math.max(-26, Math.min(0, Number(url.searchParams.get("period") ?? 0) || 0));
    const period = resolvePeriod(now, settings, offset);
    const weekFrom = Number(url.searchParams.get("weekFrom") ?? 0) || now - 3 * 86_400_000;
    const weekTo = weekFrom + 21 * 86_400_000;
    const members = await team();
    const profiles = await profilesFor(members.map((member) => member.id));
    const [timesheets, shifts, onClock, corrections, timeOff, approvals] = await Promise.all([
      Promise.all(members.filter((member) => member.active).map(async (member) => ({
        member,
        summary: await timesheetFor(member.id, period, settings, profiles.get(member.id)!, now),
      }))),
      loadShifts(weekFrom, weekTo),
      getD1()
        .prepare(
          `SELECT u.id, u.name, s.state, s.updated_at
           FROM time_clock_state s JOIN staff_users u ON u.id = s.staff_user_id
           WHERE s.state != 'clocked_out'`,
        )
        .all(),
      getD1()
        .prepare(
          `SELECT c.*, u.name AS staff_name, e.action, e.occurred_at
           FROM correction_requests c JOIN staff_users u ON u.id = c.staff_user_id
           LEFT JOIN time_clock_events e ON e.id = c.event_id
           ORDER BY c.status = 'pending' DESC, c.created_at DESC LIMIT 40`,
        )
        .all(),
      getD1()
        .prepare(
          `SELECT t.*, u.name AS staff_name FROM time_off_requests t JOIN staff_users u ON u.id = t.staff_user_id
           ORDER BY t.status = 'pending' DESC, t.starts_at DESC LIMIT 40`,
        )
        .all(),
      getD1()
        .prepare("SELECT * FROM timesheet_approvals WHERE period_start = ?")
        .bind(period.start)
        .all(),
    ]);
    return Response.json({
      user,
      period: { ...period, label: settings.period, timeZone: settings.timeZone, offset },
      week: { from: weekFrom, to: weekTo },
      team: members.map((member) => {
        const profile = profiles.get(member.id)!;
        return {
          ...member,
          jobTitle: profile.job_title,
          employmentType: profile.employment_type,
          wageCents: profile.wage_cents,
          weeklyOvertimeMinutes: profile.weekly_overtime_minutes,
          overtimeMultiplierBps: profile.overtime_multiplier_bps,
          hasPin: Boolean(profile.pin_hash),
          availability: JSON.parse(profile.availability_json || "[]"),
        };
      }),
      timesheets: timesheets.map(({ member, summary }) => ({
        staffUserId: member.id,
        name: member.name,
        days: summary.days,
        totalPaidMs: summary.totalPaidMs,
        totalBreakMs: summary.totalBreakMs,
        regularMs: summary.regularMs,
        overtimeMs: summary.overtimeMs,
        grossPayCents: summary.grossPayCents,
        openSession: summary.openSession,
        approved: approvals.results.some((row) => String((row as Record<string, unknown>).staff_user_id) === member.id),
      })),
      shifts,
      onClock: onClock.results,
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
    const body = (await request.json()) as Record<string, unknown>;
    const action = String(body.action ?? "");
    const now = Date.now();
    const database = getD1();
    const requirePermission = (permission: string) => {
      if (user.role !== "owner" && !hasPermission(user.role, user.permissions, permission)) {
        throw new PunchError("You do not have permission for that.", 403);
      }
    };

    if (action === "shift.upsert") {
      requirePermission("manage_employees");
      const id = String(body.id ?? "") || crypto.randomUUID();
      const startsAt = Number(body.startsAt);
      const endsAt = Number(body.endsAt);
      const staffUserId = body.staffUserId ? String(body.staffUserId) : null;
      const breakMinutes = Math.max(0, Math.min(240, Number(body.unpaidBreakMinutes ?? 0) || 0));
      if (!Number.isSafeInteger(startsAt) || !Number.isSafeInteger(endsAt) || endsAt <= startsAt || endsAt - startsAt > 20 * 3_600_000) {
        return Response.json({ error: "A shift needs a start and an end within 20 hours of each other." }, { status: 400 });
      }
      if (staffUserId) {
        const exists = await database.prepare("SELECT id FROM staff_users WHERE id = ? AND active = 1").bind(staffUserId).first();
        if (!exists) return Response.json({ error: "Choose an active team member." }, { status: 400 });
        // A person cannot be in two places at once; overlapping shifts are the most
        // common scheduling mistake, so they are rejected rather than warned about.
        const clash = await database
          .prepare("SELECT id FROM shifts WHERE staff_user_id = ? AND id != ? AND starts_at < ? AND ends_at > ?")
          .bind(staffUserId, id, endsAt, startsAt)
          .first();
        if (clash) return Response.json({ error: "That overlaps a shift this person already has." }, { status: 409 });
      }
      await database
        .prepare(
          `INSERT INTO shifts (id, staff_user_id, role, starts_at, ends_at, unpaid_break_minutes, notes, published, published_at, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET staff_user_id = excluded.staff_user_id, role = excluded.role,
             starts_at = excluded.starts_at, ends_at = excluded.ends_at,
             unpaid_break_minutes = excluded.unpaid_break_minutes, notes = excluded.notes,
             updated_at = excluded.updated_at`,
        )
        .bind(id, staffUserId, body.role ? String(body.role).slice(0, 60) : null, startsAt, endsAt, breakMinutes, body.notes ? String(body.notes).slice(0, 300) : null, user.id, now, now)
        .run();
      await writeAudit({ actorId: user.id, action: "shift.upsert", targetType: "shift", targetId: id, next: { staffUserId, startsAt, endsAt } });
      return Response.json({ ok: true, id });
    }

    if (action === "shift.delete") {
      requirePermission("manage_employees");
      const id = String(body.id ?? "");
      const previous = await database.prepare("SELECT * FROM shifts WHERE id = ?").bind(id).first();
      if (!previous) return Response.json({ error: "That shift no longer exists." }, { status: 404 });
      await database.prepare("DELETE FROM shifts WHERE id = ?").bind(id).run();
      await writeAudit({ actorId: user.id, action: "shift.delete", targetType: "shift", targetId: id, previous });
      return Response.json({ ok: true });
    }

    if (action === "schedule.publish") {
      requirePermission("manage_employees");
      const from = Number(body.from);
      const to = Number(body.to);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) {
        return Response.json({ error: "Choose the week to publish." }, { status: 400 });
      }
      const result = await database
        .prepare("UPDATE shifts SET published = 1, published_at = ?, updated_at = ? WHERE starts_at >= ? AND starts_at < ? AND published = 0")
        .bind(now, now, from, to)
        .run();
      await writeAudit({ actorId: user.id, action: "schedule.publish", targetType: "schedule", targetId: String(from), next: { from, to, published: result.meta.changes } });
      return Response.json({ ok: true, published: result.meta.changes });
    }

    if (action === "profile.update") {
      requirePermission("manage_employees");
      const staffUserId = String(body.staffUserId ?? "");
      const exists = await database.prepare("SELECT id FROM staff_users WHERE id = ?").bind(staffUserId).first();
      if (!exists) return Response.json({ error: "That team member no longer exists." }, { status: 404 });
      const wageCents = Math.max(0, Math.min(1_000_00, Math.round(Number(body.wageCents ?? 0) || 0)));
      const weeklyOvertimeMinutes = Math.max(0, Math.min(10_080, Number(body.weeklyOvertimeMinutes ?? ONTARIO_WEEKLY_OVERTIME_MINUTES) || 0));
      const multiplier = Math.max(10_000, Math.min(30_000, Number(body.overtimeMultiplierBps ?? 15_000) || 15_000));
      await database
        .prepare(
          `INSERT INTO staff_profiles (staff_user_id, job_title, employment_type, wage_cents,
             weekly_overtime_minutes, overtime_multiplier_bps, week_starts_on, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(staff_user_id) DO UPDATE SET job_title = excluded.job_title,
             employment_type = excluded.employment_type, wage_cents = excluded.wage_cents,
             weekly_overtime_minutes = excluded.weekly_overtime_minutes,
             overtime_multiplier_bps = excluded.overtime_multiplier_bps,
             week_starts_on = excluded.week_starts_on, updated_at = excluded.updated_at`,
        )
        .bind(
          staffUserId,
          body.jobTitle ? String(body.jobTitle).slice(0, 60) : null,
          body.employmentType === "salary" ? "salary" : "hourly",
          wageCents,
          weeklyOvertimeMinutes,
          multiplier,
          Math.max(0, Math.min(6, Number(body.weekStartsOn ?? 0) || 0)),
          now,
          now,
        )
        .run();
      await writeAudit({ actorId: user.id, action: "timeclock.profile.update", targetType: "staff_profile", targetId: staffUserId, next: { wageCents, weeklyOvertimeMinutes } });
      return Response.json({ ok: true });
    }

    if (action === "pin.set") {
      requirePermission("manage_employees");
      const staffUserId = String(body.staffUserId ?? "");
      const pin = String(body.pin ?? "");
      if (!pin) {
        await database.prepare("UPDATE staff_profiles SET pin_hash = NULL, pin_salt = NULL, pin_iterations = NULL, updated_at = ? WHERE staff_user_id = ?").bind(now, staffUserId).run();
        await writeAudit({ actorId: user.id, action: "timeclock.pin.clear", targetType: "staff_profile", targetId: staffUserId });
        return Response.json({ ok: true, hasPin: false });
      }
      validatePin(pin);

      // C-09: two employees sharing a PIN used to mean one silently punched the
      // other's card. The kiosk now identifies the employee before verifying, so
      // a collision no longer misattributes a punch — but it would still let two
      // people believe the same PIN is "theirs", so it is rejected outright.
      //
      // This is O(staff) PBKDF2 derivations, which is exactly what was removed
      // from the punch path. It is acceptable here: setting a PIN is a rare
      // manager action, not something that happens at every shift change.
      const existing = await database
        .prepare(
          `SELECT staff_user_id, pin_hash, pin_salt, pin_iterations
           FROM staff_profiles
           WHERE pin_hash IS NOT NULL AND staff_user_id <> ?`,
        )
        .bind(staffUserId)
        .all<{ staff_user_id: string; pin_hash: string; pin_salt: string; pin_iterations: number }>();
      for (const profile of existing.results) {
        if (await verifyPin(pin, profile.pin_hash, profile.pin_salt, profile.pin_iterations)) {
          // Deliberately does not say who holds it - that would hand a manager
          // another employee's PIN.
          return Response.json(
            { error: "Another employee already uses that PIN. Choose a different one." },
            { status: 409 },
          );
        }
      }

      const hashed = await createPinHash(pin);
      await database
        .prepare(
          `INSERT INTO staff_profiles (staff_user_id, pin_hash, pin_salt, pin_iterations, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(staff_user_id) DO UPDATE SET pin_hash = excluded.pin_hash,
             pin_salt = excluded.pin_salt, pin_iterations = excluded.pin_iterations, updated_at = excluded.updated_at`,
        )
        .bind(staffUserId, hashed.hash, hashed.salt, hashed.iterations, now, now)
        .run();
      // The PIN itself is never written to the audit log.
      await writeAudit({ actorId: user.id, action: "timeclock.pin.set", targetType: "staff_profile", targetId: staffUserId });
      return Response.json({ ok: true, hasPin: true });
    }

    if (action === "event.adjust" || action === "event.insert" || action === "event.delete") {
      requirePermission("edit_time_records");
      if (action === "event.insert") {
        const staffUserId = String(body.staffUserId ?? "");
        const occurredAt = Number(body.occurredAt);
        const punch = String(body.punch ?? "") as ClockAction;
        if (!["clock_in", "break_start", "break_end", "clock_out"].includes(punch) || !Number.isSafeInteger(occurredAt)) {
          return Response.json({ error: "Choose a punch type and a time." }, { status: 400 });
        }
        // A manager-inserted punch keeps the session of the nearest earlier event so
        // the timesheet still reads as one shift.
        const neighbour = await database
          .prepare("SELECT session_id FROM time_clock_events WHERE staff_user_id = ? AND occurred_at <= ? ORDER BY occurred_at DESC LIMIT 1")
          .bind(staffUserId, occurredAt)
          .first<{ session_id: string }>();
        const id = crypto.randomUUID();
        await database
          .prepare(
            `INSERT INTO time_clock_events (id, staff_user_id, session_id, action, occurred_at, source, created_at)
             VALUES (?, ?, ?, ?, ?, 'manager', ?)`,
          )
          .bind(id, staffUserId, neighbour?.session_id ?? crypto.randomUUID(), punch, occurredAt, now)
          .run();
        await writeAudit({ actorId: user.id, action: "timeclock.event.insert", targetType: "clock_event", targetId: id, next: { staffUserId, punch, occurredAt } });
        return Response.json({ ok: true, id });
      }
      const eventId = String(body.eventId ?? "");
      const previous = await database.prepare("SELECT * FROM time_clock_events WHERE id = ?").bind(eventId).first<Record<string, unknown>>();
      if (!previous) return Response.json({ error: "That clock entry no longer exists." }, { status: 404 });
      if (action === "event.delete") {
        await database.prepare("DELETE FROM time_clock_events WHERE id = ?").bind(eventId).run();
        await writeAudit({ actorId: user.id, action: "timeclock.event.delete", targetType: "clock_event", targetId: eventId, previous });
        return Response.json({ ok: true });
      }
      const occurredAt = Number(body.occurredAt);
      if (!Number.isSafeInteger(occurredAt)) return Response.json({ error: "Enter a valid time." }, { status: 400 });
      await database
        .prepare("UPDATE time_clock_events SET occurred_at = ?, source = 'manager' WHERE id = ?")
        .bind(occurredAt, eventId)
        .run();
      await writeAudit({ actorId: user.id, action: "timeclock.event.adjust", targetType: "clock_event", targetId: eventId, previous, next: { occurredAt } });
      return Response.json({ ok: true });
    }

    if (action === "correction.resolve") {
      requirePermission("approve_correction_requests");
      const id = String(body.id ?? "");
      const approve = Boolean(body.approve);
      const requestRow = await database.prepare("SELECT * FROM correction_requests WHERE id = ?").bind(id).first<Record<string, unknown>>();
      if (!requestRow || requestRow.status !== "pending") {
        return Response.json({ error: "That request has already been handled." }, { status: 409 });
      }
      const statements = [
        database
          .prepare("UPDATE correction_requests SET status = ?, reviewer_id = ?, reviewer_note = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
          .bind(approve ? "approved" : "declined", user.id, body.note ? String(body.note).slice(0, 500) : null, now, id),
      ];
      // Approving is what actually moves the punch, so both rows commit together.
      if (approve) {
        statements.push(
          database
            .prepare("UPDATE time_clock_events SET occurred_at = ?, source = 'manager' WHERE id = ?")
            .bind(Number(requestRow.requested_time), String(requestRow.event_id)),
        );
      }
      const [update] = await database.batch(statements);
      if (!update.meta.changes) return Response.json({ error: "That request has already been handled." }, { status: 409 });
      await writeAudit({ actorId: user.id, action: "timeclock.correction.resolve", targetType: "correction_request", targetId: id, previous: requestRow, next: { approve } });
      return Response.json({ ok: true });
    }

    if (action === "timeoff.resolve") {
      requirePermission("approve_time_off_requests");
      const id = String(body.id ?? "");
      const result = await database
        .prepare("UPDATE time_off_requests SET status = ?, reviewer_id = ?, reviewer_note = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
        .bind(body.approve ? "approved" : "declined", user.id, body.note ? String(body.note).slice(0, 500) : null, now, id)
        .run();
      if (!result.meta.changes) return Response.json({ error: "That request has already been handled." }, { status: 409 });
      await writeAudit({ actorId: user.id, action: "timeclock.timeoff.resolve", targetType: "time_off_request", targetId: id, next: { approve: Boolean(body.approve) } });
      return Response.json({ ok: true });
    }

    if (action === "timesheet.approve") {
      requirePermission("export_payroll");
      const staffUserId = String(body.staffUserId ?? "");
      const settings = await timeClockSettings();
      const period = resolvePeriod(now, settings, Math.max(-26, Math.min(0, Number(body.periodOffset ?? 0) || 0)));
      const profile = await loadProfile(staffUserId);
      const summary = await timesheetFor(staffUserId, period, settings, profile, now);
      if (summary.openSession) {
        return Response.json({ error: "That timesheet still has an open shift. Close it before approving." }, { status: 409 });
      }
      await database
        .prepare(
          `INSERT INTO timesheet_approvals (id, staff_user_id, period_start, period_end, status, paid_ms,
             regular_ms, overtime_ms, gross_pay_cents, note, approved_by, approved_at)
           VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(staff_user_id, period_start) DO UPDATE SET status = 'approved', paid_ms = excluded.paid_ms,
             regular_ms = excluded.regular_ms, overtime_ms = excluded.overtime_ms,
             gross_pay_cents = excluded.gross_pay_cents, note = excluded.note,
             approved_by = excluded.approved_by, approved_at = excluded.approved_at`,
        )
        .bind(crypto.randomUUID(), staffUserId, period.start, period.end, summary.totalPaidMs, summary.regularMs, summary.overtimeMs, summary.grossPayCents, body.note ? String(body.note).slice(0, 300) : null, user.id, now)
        .run();
      await writeAudit({ actorId: user.id, action: "timeclock.timesheet.approve", targetType: "timesheet", targetId: `${staffUserId}:${period.start}`, next: { paidMs: summary.totalPaidMs } });
      return Response.json({ ok: true });
    }

    if (action === "punch.for") {
      requirePermission("edit_time_records");
      const staffUserId = String(body.staffUserId ?? "");
      const punch = String(body.punch ?? "") as ClockAction;
      if (!["clock_in", "break_start", "break_end", "clock_out"].includes(punch)) {
        return Response.json({ error: "Choose a clock action." }, { status: 400 });
      }
      const result = await recordPunch(staffUserId, punch, "manager");
      return Response.json({ ok: true, state: result.state });
    }

    return Response.json({ error: "Unsupported time-clock action." }, { status: 400 });
  } catch (error) {
    if (error instanceof PunchError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && /PIN|transition/.test(error.message)) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    return authErrorResponse(error);
  }
}

/** Payroll export: one row per employee per pay period, as CSV for a bookkeeper. */
export async function PUT(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request, "export_payroll");
    const body = (await request.json()) as { periodOffset?: number };
    const now = Date.now();
    const settings = await timeClockSettings();
    const period = resolvePeriod(now, settings, Math.max(-26, Math.min(0, Number(body.periodOffset ?? 0) || 0)));
    const members = (await team()).filter((member) => member.active);
    const profiles = await profilesFor(members.map((member) => member.id));
    const rows = await Promise.all(members.map(async (member) => {
      const profile = profiles.get(member.id)!;
      const summary = await timesheetFor(member.id, period, settings, profile, now);
      const approval = await getD1()
        .prepare("SELECT status, approved_at FROM timesheet_approvals WHERE staff_user_id = ? AND period_start = ?")
        .bind(member.id, period.start)
        .first<{ status: string; approved_at: number }>();
      return [
        member.name,
        member.email,
        profile.job_title ?? "",
        new Date(period.start).toISOString().slice(0, 10),
        new Date(period.end - 1).toISOString().slice(0, 10),
        hoursFromMs(summary.regularMs),
        hoursFromMs(summary.overtimeMs),
        hoursFromMs(summary.totalPaidMs),
        hoursFromMs(summary.totalBreakMs),
        (profile.wage_cents / 100).toFixed(2),
        (summary.grossPayCents / 100).toFixed(2),
        approval?.status ?? "not approved",
      ];
    }));
    const header = ["Name", "Email", "Role", "Period start", "Period end", "Regular hours", "Overtime hours", "Total paid hours", "Unpaid break hours", "Hourly rate", "Gross pay", "Approval"];
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    await writeAudit({ actorId: user.id, action: "timeclock.payroll.export", targetType: "payroll", targetId: String(period.start), next: { employees: rows.length } });
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="pizza62-payroll-${new Date(period.start).toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
