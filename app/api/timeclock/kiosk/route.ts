import { ensureDatabase, getD1 } from "@/db/runtime";
import { verifyPin } from "@/lib/auth";
import { enforceRateLimit, RateLimitError } from "@/lib/security";
import { type ClockAction } from "@/lib/domain";
import { PunchError, currentClockState, recordPunch } from "@/lib/timeclock-punch";

const PUNCHES = new Set(["clock_in", "break_start", "break_end", "clock_out"]);

/**
 * Shared-terminal punching: an employee types their PIN on a tablet at the store
 * instead of signing in. A PIN is short, so this endpoint is rate limited, only
 * ever performs a punch, and returns nothing about anyone whose PIN did not match.
 */
export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "timeclock-kiosk", 12, 10 * 60 * 1000);
    await ensureDatabase();
    const body = (await request.json()) as { pin?: string; action?: string };
    const pin = String(body.pin ?? "");
    if (!PUNCHES.has(body.action ?? "") || !/^[0-9]{4,8}$/.test(pin)) {
      return Response.json({ error: "Enter your PIN and choose a clock action." }, { status: 400 });
    }
    const candidates = await getD1()
      .prepare(
        `SELECT p.staff_user_id, p.pin_hash, p.pin_salt, p.pin_iterations, u.name
         FROM staff_profiles p JOIN staff_users u ON u.id = p.staff_user_id
         WHERE p.pin_hash IS NOT NULL AND u.active = 1`,
      )
      .all<{ staff_user_id: string; pin_hash: string; pin_salt: string; pin_iterations: number; name: string }>();
    let matched: { id: string; name: string } | null = null;
    for (const candidate of candidates.results) {
      if (await verifyPin(pin, candidate.pin_hash, candidate.pin_salt, candidate.pin_iterations)) {
        matched = { id: candidate.staff_user_id, name: candidate.name };
        break;
      }
    }
    if (!matched) return Response.json({ error: "That PIN was not recognised." }, { status: 401 });
    const before = await currentClockState(matched.id);
    const result = await recordPunch(matched.id, body.action as ClockAction, "kiosk");
    return Response.json({
      ok: true,
      name: matched.name,
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
