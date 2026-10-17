import { getD1 } from "@/db/runtime";
import { CALL_SID, signedTwilioForm } from "@/lib/voice/webhooks";

export const dynamic = "force-dynamic";
const TERMINAL = ["completed", "busy", "failed", "no-answer", "canceled"];
const PROGRESS = ["queued", "initiated", "ringing", "in-progress"];
const STATUSES = new Set([...PROGRESS, ...TERMINAL]);

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await signedTwilioForm(request);
    if (form instanceof Response) return form;
    if (!CALL_SID.test(form.CallSid ?? "") || !STATUSES.has(form.CallStatus)) {
      return new Response("Invalid call status.", { status: 400 });
    }
    const terminal = TERMINAL.includes(form.CallStatus);
    const duration = /^\d{1,7}$/.test(form.CallDuration ?? "") ? Number(form.CallDuration) : null;
    const sequence = /^\d{1,9}$/.test(form.SequenceNumber ?? "") ? Number(form.SequenceNumber) : null;
    const parsedTime = form.Timestamp ? Date.parse(form.Timestamp) : NaN;
    const now = Date.now();
    const endedAt = Number.isFinite(parsedTime) && Math.abs(parsedTime - now) < 24 * 60 * 60_000 ? parsedTime : now;
    // Terminal callbacks win over progress callbacks, including when Twilio
    // omits SequenceNumber. Retries cannot move end time or reopen a call.
    await getD1().prepare(
      `UPDATE voice_calls SET twilio_status = ?, twilio_status_sequence = ?,
         call_duration_seconds = COALESCE(?, call_duration_seconds),
         ended_at = CASE WHEN ? = 1 THEN COALESCE(ended_at, ?) ELSE ended_at END,
         stage = CASE WHEN ? = 1 AND stage NOT IN ('placed', 'placing') THEN 'closed' ELSE stage END,
         updated_at = ?
       WHERE call_sid = ? AND provider = 'elevenlabs'
         AND (twilio_status IS NULL OR twilio_status NOT IN ('completed', 'busy', 'failed', 'no-answer', 'canceled'))
         AND (twilio_status IS NULL OR twilio_status <> ?)
         AND (? = 1 OR twilio_status_sequence IS NULL OR (?::integer IS NOT NULL AND ? > twilio_status_sequence))
         AND (? = 1 OR CASE twilio_status WHEN 'queued' THEN 0 WHEN 'initiated' THEN 1
           WHEN 'ringing' THEN 2 WHEN 'in-progress' THEN 3 ELSE -1 END < ?)`,
    ).bind(form.CallStatus, sequence, duration, terminal ? 1 : 0, endedAt, terminal ? 1 : 0, now,
      form.CallSid, form.CallStatus, terminal ? 1 : 0, sequence, sequence, terminal ? 1 : 0, PROGRESS.indexOf(form.CallStatus)).run();
    // Unknown CallSids are acknowledged without creating a caller-selected row.
    return new Response(null, { status: 200 });
  } catch {
    return new Response("Call status could not be saved.", { status: 503 });
  }
}
