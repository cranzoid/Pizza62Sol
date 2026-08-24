/**
 * Transaction-level regressions for the staff time clock.
 *
 * Requires Postgres and is skipped when the local test database is unavailable.
 * The production defect this pins was created by manager punches bypassing the
 * employee state machine, allowing duplicate clock-outs and overlapping shifts.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const {
  PunchError,
  adjustManagerClockEvent,
  insertManagerClockEvent,
  inspectCurrentClockState,
  recordPunch,
} = await import("@/lib/timeclock-punch");

const reachable = await getPool().query("SELECT 1").then(() => true).catch(() => false);
const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const RUN = crypto.randomUUID();
const STAFF_ID = `clock-test-${RUN}`;
const ACTOR_ID = `clock-manager-${RUN}`;

async function createStaff(id: string, role: "employee" | "manager") {
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_users
     (id,email,name,role,password_hash,password_salt,password_iterations,permissions_json,active,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'test','test',1,'[]',1,$5,$5)`,
    [id, `${id}@example.test`, role === "manager" ? "Test Manager" : "Test Employee", role, now],
  );
}

if (reachable) {
  await createStaff(STAFF_ID, "employee");
  await createStaff(ACTOR_ID, "manager");
}

after(async () => {
  if (reachable) {
    await getPool().query("DELETE FROM correction_requests WHERE staff_user_id = $1", [STAFF_ID]);
    await getPool().query("DELETE FROM timesheet_approvals WHERE staff_user_id = $1", [STAFF_ID]);
    await getPool().query("DELETE FROM time_clock_events WHERE staff_user_id = $1", [STAFF_ID]);
    await getPool().query("DELETE FROM time_clock_state WHERE staff_user_id = $1", [STAFF_ID]);
    await getPool().query("DELETE FROM audit_log WHERE actor_id IN ($1,$2) OR target_id = $1", [STAFF_ID, ACTOR_ID]);
    await getPool().query("DELETE FROM staff_users WHERE id IN ($1,$2)", [STAFF_ID, ACTOR_ID]);
  }
  await closePool();
});

withDb("serialises simultaneous punches so only one transition wins", async () => {
  await recordPunch(STAFF_ID, "clock_in", "self_service");
  const attempts = await Promise.allSettled([
    recordPunch(STAFF_ID, "clock_out", "self_service"),
    recordPunch(STAFF_ID, "clock_out", "self_service"),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
  const rejected = attempts.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected" && rejected.reason instanceof Error);
  assert.match((rejected as PromiseRejectedResult).reason.message, /Invalid time-clock transition/);

  const events = await getPool().query("SELECT action FROM time_clock_events WHERE staff_user_id = $1 ORDER BY occurred_at, created_at, id", [STAFF_ID]);
  assert.deepEqual(events.rows.map((row) => row.action), ["clock_in", "clock_out"]);
  assert.equal((await inspectCurrentClockState(STAFF_ID)).state, "clocked_out");
});

withDb("manager entry cannot append a duplicate clock-out", async () => {
  await assert.rejects(
    () => insertManagerClockEvent({ actorId: ACTOR_ID, staffUserId: STAFF_ID, action: "clock_out", occurredAt: Date.now() - 1_000 }),
    (error: unknown) => error instanceof PunchError && /matching clock-in|invalid time record|transition/i.test(error.message),
  );
  const count = await getPool().query<{ count: string }>("SELECT count(*) FROM time_clock_events WHERE staff_user_id = $1", [STAFF_ID]);
  assert.equal(Number(count.rows[0].count), 2);
});

withDb("editing a signed-off punch marks its timesheet for manager re-review", async () => {
  const event = await getPool().query<{ id: string; occurred_at: number }>(
    "SELECT id, occurred_at FROM time_clock_events WHERE staff_user_id = $1 AND action = 'clock_out'",
    [STAFF_ID],
  );
  const clockOut = event.rows[0];
  const periodStart = clockOut.occurred_at - 86_400_000;
  const periodEnd = clockOut.occurred_at + 86_400_000;
  await getPool().query(
    `INSERT INTO timesheet_approvals
     (id,staff_user_id,period_start,period_end,status,paid_ms,regular_ms,overtime_ms,gross_pay_cents,approved_by,approved_at)
     VALUES ($1,$2,$3,$4,'approved',0,0,0,0,$5,$6)`,
    [`approval-${RUN}`, STAFF_ID, periodStart, periodEnd, ACTOR_ID, Date.now()],
  );

  await adjustManagerClockEvent({ actorId: ACTOR_ID, eventId: clockOut.id, occurredAt: clockOut.occurred_at + 60_000 });
  const approval = await getPool().query<{ status: string }>("SELECT status FROM timesheet_approvals WHERE id = $1", [`approval-${RUN}`]);
  assert.equal(approval.rows[0].status, "needs_review");
  assert.equal((await inspectCurrentClockState(STAFF_ID)).state, "clocked_out");
});
