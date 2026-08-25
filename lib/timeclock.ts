import { getD1, getSetting } from "@/db/runtime";
import {
  ONTARIO_WEEKLY_OVERTIME_MINUTES,
  buildTimesheet,
  buildWorkSessions,
  grossPayCents,
  inspectClockTimeline,
  payPeriodFor,
  splitOvertime,
  zonedDateTimeToUtc,
  type ClockAction,
  type ClockEventRecord,
  type PayrollPeriod,
} from "@/lib/domain";

export type StaffProfile = {
  staff_user_id: string;
  job_title: string | null;
  employment_type: string;
  wage_cents: number;
  weekly_overtime_minutes: number;
  overtime_multiplier_bps: number;
  week_starts_on: number;
  pin_hash: string | null;
  pin_salt: string | null;
  pin_iterations: number | null;
  availability_json: string;
  hired_at: number | null;
};

export type ShiftRow = {
  id: string;
  staff_user_id: string | null;
  role: string | null;
  starts_at: number;
  ends_at: number;
  unpaid_break_minutes: number;
  notes: string | null;
  published: number;
};

const DEFAULT_PROFILE = {
  job_title: null,
  employment_type: "hourly",
  wage_cents: 0,
  weekly_overtime_minutes: ONTARIO_WEEKLY_OVERTIME_MINUTES,
  overtime_multiplier_bps: 15_000,
  week_starts_on: 0,
  pin_hash: null,
  pin_salt: null,
  pin_iterations: null,
  availability_json: "[]",
  hired_at: null,
};

export async function loadProfile(staffUserId: string): Promise<StaffProfile> {
  const row = await getD1()
    .prepare("SELECT * FROM staff_profiles WHERE staff_user_id = ?")
    .bind(staffUserId)
    .first<StaffProfile>();
  return row ?? { staff_user_id: staffUserId, ...DEFAULT_PROFILE };
}

export async function loadClockEvents(staffUserId: string, since = 0, until = Number.MAX_SAFE_INTEGER) {
  const events = await getD1()
    .prepare(
      `SELECT id, session_id, action, occurred_at, source, correction_of, created_at
       FROM time_clock_events WHERE staff_user_id = ? AND occurred_at >= ? AND occurred_at < ?
       ORDER BY occurred_at, created_at, id`,
    )
    .bind(staffUserId, since, until)
    .all<{ id: string; session_id: string; action: ClockAction; occurred_at: number; source: string; correction_of: string | null; created_at: number }>();
  return events.results;
}

export type TimeClockSettings = {
  timeZone: string;
  period: PayrollPeriod;
  anchor: number;
};

/**
 * Pay periods are anchored on a fixed date so every period lines up with the one
 * before it. When the owner has not set an anchor the epoch's first Sunday is
 * used, which keeps weekly and biweekly periods starting on a Sunday.
 */
export async function timeClockSettings(): Promise<TimeClockSettings> {
  const operations = await getSetting<Record<string, unknown>>("operations").catch(() => ({}) as Record<string, unknown>);
  const business = await getSetting<Record<string, unknown>>("business").catch(() => ({}) as Record<string, unknown>);
  const period = operations.payrollPeriod === "weekly" ? "weekly" : "biweekly";
  const timeZone = String(business.timeZone ?? "America/Toronto");
  const anchor = Number(operations.payrollAnchor ?? 0) || zonedDateTimeToUtc("2024-01-07", 0, timeZone); // Sunday, locally
  return { timeZone, period, anchor };
}

export function resolvePeriod(now: number, settings: TimeClockSettings, offsetPeriods = 0) {
  return payPeriodFor(now, { period: settings.period, anchor: settings.anchor, offsetPeriods, timeZone: settings.timeZone });
}

export type TimesheetSummary = {
  staffUserId: string;
  days: ReturnType<typeof buildTimesheet>["days"];
  sessions: ReturnType<typeof buildWorkSessions>;
  totalPaidMs: number;
  totalBreakMs: number;
  regularMs: number;
  overtimeMs: number;
  weeks: ReturnType<typeof splitOvertime>["weeks"];
  grossPayCents: number;
  openSession: boolean;
  integrityIssues: ReturnType<typeof inspectClockTimeline>["issues"];
};

/** Keeps whole sessions whose clock-in belongs to this period. */
function clockEventsForPeriod(
  events: Awaited<ReturnType<typeof loadClockEvents>>,
  period: { start: number; end: number },
): Awaited<ReturnType<typeof loadClockEvents>> {
  const selected: Awaited<ReturnType<typeof loadClockEvents>> = [];
  let include = false;
  for (const event of events) {
    if (event.action === "clock_in") include = event.occurred_at >= period.start && event.occurred_at < period.end;
    if (include) selected.push(event);
    if (event.action === "clock_out") include = false;
  }
  return selected;
}

export async function timesheetFor(
  staffUserId: string,
  period: { start: number; end: number },
  settings: TimeClockSettings,
  profile: StaffProfile,
  asOf = Date.now(),
): Promise<TimesheetSummary> {
  // Validate the complete history, not a pay-period slice. A slice can begin with
  // the clock-out of an overnight shift and look corrupt even when the full log is
  // valid. It also used to let a shift crossing a period boundary accrue until
  // today because its closing event fell just outside the query window.
  const allEvents = await loadClockEvents(staffUserId, 0, asOf + 1);
  const fullRecords: ClockEventRecord[] = allEvents.map((event) => ({
    id: event.id,
    action: event.action,
    occurredAt: event.occurred_at,
    sessionId: event.session_id,
  }));
  const integrity = inspectClockTimeline(fullRecords);
  if (integrity.issues.length) {
    return {
      staffUserId,
      days: [],
      sessions: [],
      totalPaidMs: 0,
      totalBreakMs: 0,
      regularMs: 0,
      overtimeMs: 0,
      weeks: [],
      grossPayCents: 0,
      openSession: false,
      integrityIssues: integrity.issues,
    };
  }
  const events = clockEventsForPeriod(allEvents, period);
  const records: ClockEventRecord[] = events.map((event) => ({ action: event.action, occurredAt: event.occurred_at }));
  const timesheet = buildTimesheet(records, settings.timeZone, asOf);
  const overtime = splitOvertime(timesheet.days, {
    weeklyOvertimeMinutes: profile.weekly_overtime_minutes,
    weekStartsOn: profile.week_starts_on,
  });
  return {
    staffUserId,
    days: timesheet.days,
    sessions: buildWorkSessions(records, asOf),
    totalPaidMs: timesheet.totalPaidMs,
    totalBreakMs: timesheet.totalBreakMs,
    regularMs: overtime.regularMs,
    overtimeMs: overtime.overtimeMs,
    weeks: overtime.weeks,
    grossPayCents: grossPayCents(overtime.regularMs, overtime.overtimeMs, profile.wage_cents, profile.overtime_multiplier_bps),
    openSession: timesheet.openSession,
    integrityIssues: [],
  };
}

export async function loadShifts(from: number, to: number, staffUserId?: string): Promise<ShiftRow[]> {
  const conditions = ["starts_at >= ?", "starts_at < ?"];
  const bindings: unknown[] = [from, to];
  if (staffUserId) {
    conditions.push("staff_user_id = ?");
    bindings.push(staffUserId);
  }
  const rows = await getD1()
    .prepare(
      `SELECT id, staff_user_id, role, starts_at, ends_at, unpaid_break_minutes, notes, published
       FROM shifts WHERE ${conditions.join(" AND ")} ORDER BY starts_at LIMIT 500`,
    )
    .bind(...bindings)
    .all<ShiftRow>();
  return rows.results;
}

/** Escapes a field for CSV: quotes wrap it and internal quotes are doubled. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const hoursFromMs = (milliseconds: number) => Math.round((milliseconds / 3_600_000) * 100) / 100;
