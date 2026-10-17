/**
 * The voice tool API: POST /api/voice/tools/<tool>.
 *
 * A thin wrapper. Everything a tool does — and every rule about money, menu ids,
 * versions, confirmation and placement — is in lib/voice/tools.ts; this route
 * only decides whether the request may reach it:
 *
 * 1. **The kill switch.** `VOICE_AI_MODE` is `off` unless someone sets it, and
 *    while it is off every call is refused with 503, before any credential is
 *    looked at.
 * 2. **The provider's bearer token** (`Authorization: Bearer <VOICE_TOOL_SECRET>`),
 *    compared in constant time. Without a configured secret nothing
 *    authenticates.
 * 3. **The call's own session** (`X-Voice-Session: <per-session secret>`). The
 *    bearer alone opens no session: a leaked provider secret cannot read or
 *    change any call it was not handed the session secret for.
 *
 * There is deliberately no route that creates a session. The future inbound
 * call webhook will mint one after verifying Twilio's signature; until then,
 * only server code and tests can.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { logFailure } from "@/lib/log";
import { voiceAiMode, voiceToolSecret } from "@/lib/voice/config";
import { runVoiceTool } from "@/lib/voice/tools";

export const dynamic = "force-dynamic";

/** Tool arguments are a few fields of ids and choices; anything larger is not a tool call. */
const MAX_BODY_BYTES = 16_384;

const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refusal = (status: number, code: string, message: string) => json(status, { ok: false, issues: [{ code, message }] });

function sameSecret(presented: string, expected: string): boolean {
  // Hash first so the comparison is over equal lengths and leaks nothing about either.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: Request, context: { params: Promise<{ tool: string }> }) {
  try {
    if ((await voiceAiMode()) === "off") return refusal(503, "VOICE_DISABLED", "The AI phone line is switched off.");
    const expected = await voiceToolSecret();
    if (!expected) return refusal(503, "VOICE_NOT_CONFIGURED", "The AI phone line has no tool credential configured.");
    const authorization = request.headers.get("authorization") ?? "";
    const presented = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
    if (!presented || !sameSecret(presented, expected)) return refusal(401, "UNAUTHORIZED", "Missing or invalid tool credential.");
    const sessionSecret = request.headers.get("x-voice-session") ?? "";
    if (!sessionSecret) return refusal(401, "SESSION_REQUIRED", "Missing X-Voice-Session.");

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return refusal(413, "BODY_TOO_LARGE", "Tool arguments are too large.");
    let input: unknown = {};
    if (raw.trim()) {
      try {
        input = JSON.parse(raw);
      } catch {
        return refusal(400, "INVALID_JSON", "Tool arguments must be JSON.");
      }
    }
    const { tool } = await context.params;
    const result = await runVoiceTool(tool, sessionSecret, input);
    return json(result.status, result.body);
  } catch (error) {
    const reference = logFailure("voice.tools", error);
    return json(500, { ok: false, issues: [{ code: "TOOL_FAILED", message: "Something went wrong on our side." }], reference });
  }
}
