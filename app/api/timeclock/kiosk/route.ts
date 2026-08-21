import { ensureDatabase, getD1, getSetting } from "@/db/runtime";
import { verifyPin } from "@/lib/auth";
import { hashOpaqueToken } from "@/lib/domain";
import { enforceRateLimit, RateLimitError } from "@/lib/security";
import { type ClockAction } from "@/lib/domain";
import { PunchError, currentClockState, recordPunch } from "@/lib/timeclock-punch";

const PUNCHES = new Set(["clock_in", "break_start", "break_end", "clock_out"]);

/**
 * Whether this request came from a paired kiosk device.
 *
 * C-09 introduced this endpoint so the kiosk could show a name picker, and in
 * doing so published the first names of every member of staff to the internet.
 * Rate limiting bounds how fast they can be scraped; it does not stop them being
 * read. So the tablet is paired once and presents a token afterwards.
 *
 * **Fails closed when nothing is paired.** The tempting alternative — stay open
 * until a token is configured — means the roster is public on every deployment
 * where somebody has not got round to it yet, which is exactly the state this is
 * meant to end. Pairing is one tap in Admin → Team.
 *
 * Compared against a stored hash, so the settings row is not itself a credential.
 */
async function pairedKiosk(request: Request): Promise<boolean> {
  const presented = request.headers.get("x-kiosk-token")?.trim();
  if (!presented) return false;
  const kiosk = await getSetting<{ tokenHash?: string }>("kiosk").catch(() => ({ tokenHash: undefined }));
  if (!kiosk?.tokenHash) return false;
  return (await hashOpaqueToken(presented)) === kiosk.tokenHash;
}

/**
 * The roster the kiosk shows so an employee can identify themselves before
 * typing a PIN.
 *
 * Only the id and display name of active staff who actually have a PIN — no
 * wage, role, contact details or employment terms. Even that is behind the
 * device token above: a list of who works here and when they are on shift is
 * worth something to somebody, and it was readable by anyone who found the URL.
 */
export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, "timeclock-roster", 60, 10 * 60 * 1000);
    await ensureDatabase();
    if (!(await pairedKiosk(request))) {
      return Response.json(
        {
          error: "This tablet is not set up as a time clock yet. Ask the owner to pair it from Admin → Team.",
          paired: false,
        },
        { status: 403 },
      );
    }
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
