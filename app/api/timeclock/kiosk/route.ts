import { ensureDatabase, getD1 } from "@/db/runtime";
import { verifyPin } from "@/lib/auth";
import { enforceRateLimit, RateLimitError } from "@/lib/security";
import { type ClockAction } from "@/lib/domain";
import { PunchError, currentClockState, recordPunch } from "@/lib/timeclock-punch";

const PUNCHES = new Set(["clock_in", "break_start", "break_end", "clock_out"]);

/**
 * The roster the kiosk shows so an employee can identify themselves before
 * typing a PIN.
 *
 * Only the id and display name of active staff who actually have a PIN — no
 * wage, role, contact details or employment terms. The kiosk is a tablet in the
 * store, but this route is reachable from the internet, so it is rate limited
 * and returns the minimum needed to render a list of buttons.
 */
export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, "timeclock-roster", 60, 10 * 60 * 1000);
    await ensureDatabase();
    const roster = await getD1()
      .prepare(
        `SELECT p.staff_user_id, u.name
         FROM staff_profiles p JOIN staff_users u ON u.id = p.staff_user_id
         WHERE p.pin_hash IS NOT NULL AND u.active = 1
         ORDER BY u.name`,
      )
      .all<{ staff_user_id: string; name: string }>();
    return Response.json({
      employees: roster.results.map((row) => ({ id: row.staff_user_id, name: row.name })),
    });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return Response.json({ error: "Too many requests. Wait a moment." }, { status: 429 });
    }
    return Response.json({ error: "The roster could not be loaded." }, { status: 500 });
  }
}

/**
 * Shared-terminal punching: an employee taps their name on a tablet at the store
 * and types their PIN, instead of signing in.
 *
 * C-09: this used to take a PIN alone and derive PBKDF2 at 100k iterations
 * against *every* staff profile until one matched. Two things were wrong with
 * that. It burned seconds of CPU on every punch, growing linearly with the size
 * of the team — on a shared burstable database tier that is a self-inflicted
 * denial of service at shift change, when everyone punches at once. And because
 * the first matching hash won, two people with the same PIN meant one of them
 * silently punched the other's card: wrong hours, wrong pay, and no trace of it.
 *
 * Naming the employee makes it exactly one derivation, and PIN uniqueness is now
 * enforced where PINs are set (timeclock/manager, action `pin.set`) so a
 * collision cannot be created in the first place.
 */
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "timeclock-kiosk", 12, 10 * 60 * 1000);
    await ensureDatabase();
    const body = (await request.json()) as { staffUserId?: string; pin?: string; action?: string };
    const staffUserId = String(body.staffUserId ?? "");
    const pin = String(body.pin ?? "");
    if (!staffUserId || !PUNCHES.has(body.action ?? "") || !/^[0-9]{4,8}$/.test(pin)) {
      return Response.json({ error: "Choose your name, enter your PIN, and pick a clock action." }, { status: 400 });
    }

    // A second bucket keyed to the employee, not the caller. The per-IP limit
    // above does not stop a distributed attempt at one person's 4-digit PIN;
    // this does, and it is scoped so one employee's lockout cannot deny anyone
    // else their punch.
    await enforceRateLimit(request, `timeclock-kiosk-staff:${staffUserId}`, 12, 10 * 60 * 1000);

    const candidate = await getD1()
      .prepare(
        `SELECT p.staff_user_id, p.pin_hash, p.pin_salt, p.pin_iterations, u.name
         FROM staff_profiles p JOIN staff_users u ON u.id = p.staff_user_id
         WHERE p.staff_user_id = ? AND p.pin_hash IS NOT NULL AND u.active = 1`,
      )
      .bind(staffUserId)
      .first<{ staff_user_id: string; pin_hash: string; pin_salt: string; pin_iterations: number; name: string }>();

    // One derivation, and the same generic response whether the employee does
    // not exist or the PIN was wrong.
    const verified =
      candidate !== null &&
      (await verifyPin(pin, candidate.pin_hash, candidate.pin_salt, candidate.pin_iterations));
    if (!candidate || !verified) {
      return Response.json({ error: "That PIN was not recognised." }, { status: 401 });
    }

    const before = await currentClockState(candidate.staff_user_id);
    const result = await recordPunch(candidate.staff_user_id, body.action as ClockAction, "kiosk");
    return Response.json({
      ok: true,
      name: candidate.name,
      previousState: before.state,
      state: result.state,
      occurredAt: result.occurredAt,
    });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return Response.json({ error: "Too many PIN attempts. Wait a few minutes and try again." }, { status: 429 });
    }
    if (error instanceof PunchError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof Error && error.message.startsWith("Invalid time-clock transition")) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return Response.json({ error: "The clock could not record that." }, { status: 500 });
  }
}
