import { getD1 } from "@/db/runtime";
import { readIntegrationSecrets } from "@/lib/integration-secrets";
import { isVoicePhone, voiceAiAllowlist, voiceAiMode, voiceAiNumber, voiceToolSecret, VOICE_REGISTER_TIMEOUT_MS } from "@/lib/voice/config";
import { closeVoiceSession, createVoiceSession } from "@/lib/voice/session";
import { CALL_SID, signedTwilioForm, voiceFallback, voiceXml } from "@/lib/voice/webhooks";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let sessionId: string | null = null;
  try {
    const form = await signedTwilioForm(request);
    if (form instanceof Response) return form;
    if (!CALL_SID.test(form.CallSid ?? "") || !form.From || !isVoicePhone(form.To ?? "")) {
      return new Response("Missing or invalid call fields.", { status: 400 });
    }
    const mode = await voiceAiMode();
    // Phase 4 only admits deliberate internal tests. Pilot/live configuration
    // remains recognized, but public rollout needs its own implementation/review.
    if (mode !== "internal") return voiceFallback();
    const [allowlist, number] = await Promise.all([voiceAiAllowlist(), voiceAiNumber()]);
    if (!isVoicePhone(form.From) || !allowlist.has(form.From) || form.To !== number) return voiceFallback();
    const [credentials, toolSecret] = await Promise.all([
      readIntegrationSecrets(["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "ELEVENLABS_WEBHOOK_SECRET"] as const),
      voiceToolSecret(),
    ]);
    if (!credentials.ELEVENLABS_API_KEY || !credentials.ELEVENLABS_AGENT_ID || !credentials.ELEVENLABS_WEBHOOK_SECRET || !toolSecret) {
      return voiceFallback();
    }
    const minted = await createVoiceSession({
      provider: "elevenlabs", mode, callSid: form.CallSid,
      callerPhone: form.From, calledNumber: form.To, forwardedFrom: form.ForwardedFrom || null,
      callerIdStatus: form.From === form.To || form.From === form.ForwardedFrom ? "forwarded_as_store" : "presented",
      deduplicateCallSid: true,
    });
    // Only the INSERT winner has the secret. No plaintext TwiML/secret cache is
    // kept, so a replay fails safely instead of starting a second conversation.
    if (!minted) return voiceFallback();
    sessionId = minted.session.id;
    await getD1().prepare("UPDATE voice_calls SET registration_state = 'registering' WHERE id = ?").bind(sessionId).run();
    const response = await fetch("https://api.elevenlabs.io/v1/convai/twilio/register-call", {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": credentials.ELEVENLABS_API_KEY },
      signal: AbortSignal.timeout(VOICE_REGISTER_TIMEOUT_MS),
      body: JSON.stringify({
        agent_id: credentials.ELEVENLABS_AGENT_ID,
        from_number: form.From,
        to_number: form.To,
        direction: "inbound",
        conversation_initiation_client_data: {
          dynamic_variables: {
            secret__voice_session: minted.sessionSecret,
            voice_session_id: sessionId,
            call_sid: form.CallSid,
            voice_mode: mode,
          },
        },
      }),
    });
    if (!response.ok) throw new Error("register-call failed");
    // The API's documented response is a JSON string containing TwiML. Also
    // accept direct XML. Decode the JSON transport only; never rebuild the XML.
    const raw = await response.text();
    const twiml: unknown = response.headers.get("content-type")?.includes("json") ? JSON.parse(raw) : raw;
    if (typeof twiml !== "string" || !/^\s*(?:<\?xml[^>]*>\s*)?<Response(?:\s|>)/.test(twiml)
      || !twiml.includes("</Response>")) throw new Error("Invalid register-call response");
    // A provider response must not echo application credentials into TwiML.
    if ([credentials.ELEVENLABS_API_KEY, credentials.ELEVENLABS_WEBHOOK_SECRET, toolSecret, minted.sessionSecret]
      .some((secret) => twiml.includes(secret))) throw new Error("Unsafe register-call response");
    await getD1().prepare("UPDATE voice_calls SET registration_state = 'registered', updated_at = ? WHERE id = ?")
      .bind(Date.now(), sessionId).run();
    return voiceXml(twiml);
  } catch {
    // Never log request bodies, API errors, TwiML or exception details: any of
    // them can contain the bearer key or the one-time session secret.
    if (sessionId) {
      try {
        await getD1().prepare("UPDATE voice_calls SET registration_state = 'failed' WHERE id = ?").bind(sessionId).run();
        await closeVoiceSession(sessionId, "register_call_failed");
      } catch { /* The audible fallback must also survive database failures. */ }
    }
    return voiceFallback();
  }
}
