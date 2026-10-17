import { getD1 } from "@/db/runtime";
import { readIntegrationSecret } from "@/lib/integration-secrets";
import { verifyElevenLabsSignature } from "@/lib/voice/elevenlabs-signature";
import { redactForLog } from "@/lib/voice/redact";
import { voiceWebhookBody } from "@/lib/voice/webhooks";

export const dynamic = "force-dynamic";
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const identifier = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : null;
const seconds = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < 10_000_000 ? value : null;
const text = (value: unknown): string | null => typeof value === "string" ? value : null;

export async function POST(request: Request): Promise<Response> {
  try {
    const secret = await readIntegrationSecret("ELEVENLABS_WEBHOOK_SECRET");
    if (!secret) return new Response("Webhook is not configured.", { status: 503 });
    const raw = await voiceWebhookBody(request, 1_048_576);
    if (raw instanceof Response) return raw;
    if (!verifyElevenLabsSignature(secret, raw, request.headers.get("elevenlabs-signature"))) {
      return new Response("Invalid signature.", { status: 403 });
    }
    let event: Record<string, unknown>;
    try { event = object(JSON.parse(raw.toString("utf8"))); }
    catch { return new Response("Invalid JSON.", { status: 400 }); }
    // Ignore unsupported events without persisting their payload (especially audio).
    if (event.type !== "post_call_transcription") return Response.json({ ok: true, ignored: true });
    const data = object(event.data);
    const conversationId = identifier(data.conversation_id);
    if (!conversationId) return new Response("Missing conversation ID.", { status: 400 });
    const metadata = object(data.metadata);
    const variables = object(object(data.conversation_initiation_client_data).dynamic_variables);
    const sessionId = identifier(variables.voice_session_id);
    const callSid = identifier(object(metadata.phone_call).call_sid) ?? identifier(variables.call_sid);
    // Never use secret__voice_session: ElevenLabs redacts it after the call.
    // Only HMAC-authenticated provider data can name a row here.
    const database = getD1();
    const session = await database.prepare(
      `SELECT id, call_sid, provider_conversation_id FROM voice_calls WHERE provider = 'elevenlabs'
       AND ${sessionId ? "id = ?" : "provider_conversation_id = ?"}`,
    ).bind(sessionId ?? conversationId).first<{ id: string; call_sid: string; provider_conversation_id: string | null }>();
    if (!session) return new Response("Call is not available yet.", { status: 503 });
    if ((callSid && callSid !== session.call_sid)
      || (session.provider_conversation_id && session.provider_conversation_id !== conversationId)) {
      return new Response("Call association mismatch.", { status: 409 });
    }
    const duration = seconds(metadata.call_duration_secs);
    const start = typeof metadata.start_time_unix_secs === "number" && Number.isSafeInteger(metadata.start_time_unix_secs)
      && metadata.start_time_unix_secs > 0 && metadata.start_time_unix_secs < 10_000_000_000 ? metadata.start_time_unix_secs : null;
    const now = Date.now();
    const endedAt = start !== null && duration !== null ? (start + duration) * 1000 : now;
    const analysis = object(data.analysis);
    // An explicit projection excludes dynamic variables, tool requests/results,
    // headers, audio and arbitrary provider metadata from persisted JSON.
    const transcript = Array.isArray(data.transcript) ? data.transcript.map((entry) => {
      const turn = object(entry);
      return { role: text(turn.role), message: text(turn.message), time_in_call_secs: seconds(turn.time_in_call_secs) };
    }) : [];
    const stored = redactForLog({
      type: event.type, conversation_id: conversationId, agent_id: identifier(data.agent_id),
      version_id: identifier(data.version_id),
      agent_version: identifier(data.agent_version) ?? seconds(data.agent_version),
      status: text(data.status), duration_seconds: duration, transcript,
      summary: text(analysis.transcript_summary), disposition: text(analysis.call_successful),
      termination_reason: text(metadata.termination_reason), failure_reason: text(data.failure_reason),
    });
    // One SQL statement atomically binds the conversation and appends its event.
    // A duplicate (even a concurrent delivery) cannot append another transcript.
    const result = await database.prepare(
      `WITH updated AS (
         UPDATE voice_calls SET provider_conversation_id = ?, post_call_received_at = ?,
           ended_at = COALESCE(ended_at, ?), call_duration_seconds = COALESCE(call_duration_seconds, ?),
           stage = CASE WHEN stage IN ('placed', 'placing') THEN stage ELSE 'closed' END, updated_at = ?
         WHERE id = ? AND post_call_received_at IS NULL
           AND (provider_conversation_id IS NULL OR provider_conversation_id = ?)
         RETURNING id
       ) INSERT INTO voice_call_events
         (id, voice_call_id, event_type, request_json, ok, created_at)
         SELECT ?, id, 'session', ?, 1, ? FROM updated`,
    ).bind(conversationId, now, endedAt, duration, now, session.id, conversationId,
      `post_call:${session.id}:${conversationId}`, JSON.stringify(stored), now).run();
    if (!result.meta.changes) {
      const bound = await database.prepare("SELECT provider_conversation_id FROM voice_calls WHERE id = ?")
        .bind(session.id).first<{ provider_conversation_id: string | null }>();
      if (!bound) return new Response("Call is not available yet.", { status: 503 });
      if (bound.provider_conversation_id !== conversationId) return new Response("Call association mismatch.", { status: 409 });
    }
    return Response.json({ ok: true });
  } catch {
    // No raw webhook or provider exception details in application logs.
    return new Response("Call event could not be saved.", { status: 503 });
  }
}
