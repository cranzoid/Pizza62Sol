import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach, type TestContext } from "node:test";
import { createHmac } from "node:crypto";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";
const { getPool, closePool } = await import("@/db/pg-driver");
const { clearIntegrationSecretCache, describeIntegrationSecrets, writeIntegrationSecret, readIntegrationSecret } = await import("@/lib/integration-secrets");
const { twilioSignature } = await import("@/lib/notifications/twilio-signature");
const { createVoiceSession, authenticateVoiceSession } = await import("@/lib/voice/session");
const { hashOpaqueToken } = await import("@/lib/domain");
const { verifyElevenLabsSignature } = await import("@/lib/voice/elevenlabs-signature");
const { POST: inbound } = await import("@/app/api/voice/inbound/route");
const { POST: status } = await import("@/app/api/voice/status/route");
const { POST: events } = await import("@/app/api/voice/events/route");
const reachable = await getPool().query("SELECT 1").then(() => true).catch(() => false);
const withDb = (name: string, run: (context: TestContext) => Promise<void>) => test(name, { skip: reachable ? false : "Postgres is not reachable" }, run);
const keys = ["VOICE_AI_MODE", "VOICE_AI_ALLOWLIST", "VOICE_AI_NUMBER", "VOICE_TOOL_SECRET", "ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "ELEVENLABS_WEBHOOK_SECRET", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "SETTINGS_ENCRYPTION_KEY"];
const previous = new Map(keys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const apiKey = "test-elevenlabs-api-key-" + "a".repeat(32);
const webhookSecret = "test-webhook-secret-" + "b".repeat(32);
const toolSecret = "test-tool-secret-" + "c".repeat(32);
const token = "test-twilio-auth-token";
const caller = "+19055550177";
const number = "+18254626262";
const xml = '<?xml version="1.0"?><Response><Connect><Stream url="wss://example.invalid/stream?opaque=token"/></Connect></Response>';
let requests: Array<{ url: string; init: RequestInit; payload: Record<string, unknown> }> = [];
const callSids: string[] = [];
const sessionIds: string[] = [];
const sid = () => { const value = `CA${crypto.randomUUID().replaceAll("-", "")}`; callSids.push(value); return value; };

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {
    VOICE_AI_MODE: "internal", VOICE_AI_ALLOWLIST: caller, VOICE_AI_NUMBER: number,
    VOICE_TOOL_SECRET: toolSecret, ELEVENLABS_API_KEY: apiKey, ELEVENLABS_AGENT_ID: "agent_staging_test",
    ELEVENLABS_WEBHOOK_SECRET: webhookSecret, TWILIO_AUTH_TOKEN: token, TWILIO_FROM_NUMBER: number,
  });
  clearIntegrationSecretCache();
  requests = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.elevenlabs.io/v1/convai/twilio/register-call", "tests never make live requests");
    requests.push({ url: String(url), init: init!, payload: JSON.parse(String(init?.body)) });
    return Response.json(xml);
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });
after(async () => {
  if (reachable) await getPool().query("DELETE FROM voice_calls WHERE call_sid = ANY($1::text[]) OR id = ANY($2::text[])", [callSids, sessionIds]);
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  clearIntegrationSecretCache();
  await closePool();
});

function twilio(path: string, form: Record<string, string>, query = "", signature?: string) {
  const url = `https://example.invalid/api/voice/${path}${query}`;
  return new Request(url, { method: "POST", headers: {
    "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature ?? twilioSignature(token, url, form),
  }, body: new URLSearchParams(form) });
}
const incoming = (callSid = sid(), extra: Record<string, string> = {}, query = "") => twilio("inbound", { CallSid: callSid, From: caller, To: number, ...extra }, query);
async function row(callSid: string) { return (await getPool().query("SELECT * FROM voice_calls WHERE call_sid=$1", [callSid])).rows[0]; }
async function mint() {
  const minted = await createVoiceSession({ provider: "elevenlabs", mode: "internal", callSid: sid(), calledNumber: number, callerPhone: caller });
  sessionIds.push(minted.session.id);
  return minted;
}
function postCall(sessionId: string, callSid: string, conversationId = `conv_${crypto.randomUUID()}`) {
  return { type: "post_call_transcription", event_timestamp: Math.floor(Date.now() / 1000), data: {
    conversation_id: conversationId, agent_id: "agent_staging_test", agent_version: 7, version_id: "agtver_staging_test", status: "done",
    conversation_initiation_client_data: { dynamic_variables: { voice_session_id: sessionId, call_sid: callSid, secret__voice_session: "<REDACTED>" } },
    metadata: { start_time_unix_secs: Math.floor(Date.now() / 1000) - 30, call_duration_secs: 30, termination_reason: "user_ended" },
    analysis: { transcript_summary: "Pickup ordered. Card 4111 1111 1111 1111 cvv 123 expiry 12/29", call_successful: "success" },
    transcript: [{ role: "user", message: "Card 4111 1111 1111 1111 cvv 123 expiry 12/29 phone 9055550177", time_in_call_secs: 2,
      tool_calls: [{ headers: { Authorization: toolSecret, "X-Voice-Session": "never-save-this-secret" } }] }],
  } };
}
function eleven(event: unknown, options: { signature?: string; timestamp?: number; raw?: string } = {}) {
  const raw = options.raw ?? JSON.stringify(event);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const hash = createHmac("sha256", webhookSecret).update(`${timestamp}.${raw}`).digest("hex");
  return new Request("https://example.invalid/api/voice/events", { method: "POST", headers: {
    "content-type": "application/json", "elevenlabs-signature": options.signature ?? `t=${timestamp},v0=${hash}`,
  }, body: raw });
}

test("inbound and status reject invalid Twilio signatures before any provider request", async () => {
  for (const route of [inbound, status]) {
    const request = twilio("inbound", { CallSid: sid(), From: caller, To: number, CallStatus: "completed" }, "", "invalid");
    assert.equal((await route(request)).status, 403);
  }
  assert.equal(requests.length, 0);
});
test("default off and explicit off/pilot/live never invoke ElevenLabs", async () => {
  for (const mode of [undefined, "off", "pilot", "live", "invalid"]) {
    if (mode === undefined) delete process.env.VOICE_AI_MODE; else process.env.VOICE_AI_MODE = mode;
    const response = await inbound(incoming());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/xml");
    assert.match(await response.text(), /temporarily unavailable/);
  }
  assert.equal(requests.length, 0);
});
test("internal mode refuses unlisted, withheld, partial and wrong-destination callers", async () => {
  for (const From of ["+19055550999", "anonymous", "9055550177"]) await inbound(incoming(sid(), { From }));
  await inbound(incoming(sid(), { To: "+19055550999" }));
  process.env.VOICE_AI_ALLOWLIST = "9055550177";
  await inbound(incoming());
  assert.equal(requests.length, 0);
});
test("CallSid and caller fields cannot be substituted through query parameters or JSON", async () => {
  const query = `?CallSid=${sid()}&From=${encodeURIComponent(caller)}&To=${encodeURIComponent(number)}`;
  assert.equal((await inbound(twilio("inbound", {}, query))).status, 400);
  await inbound(incoming(sid(), { From: "+19055550999" }, query));
  assert.equal((await inbound(new Request("https://example.invalid/api/voice/inbound", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }))).status, 415);
  assert.equal(requests.length, 0);
});
test("oversized webhook bodies and duplicate signed form keys are refused", async () => {
  assert.equal((await events(eleven({}, { raw: "x".repeat(1_048_577) }))).status, 413);
  const form = { CallSid: sid(), From: caller, To: number };
  const original = twilio("inbound", form);
  const body = `${await original.text()}&CallSid=${sid()}`;
  assert.equal((await inbound(new Request(original.url, { method: "POST", headers: original.headers, body }))).status, 400);
  const oversized = incoming(sid(), { Extra: "x".repeat(16_384) });
  assert.equal((await inbound(oversized)).status, 413);
  assert.equal(requests.length, 0);
});
test("missing staging credentials fail closed without calling ElevenLabs", async () => {
  for (const key of ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "ELEVENLABS_WEBHOOK_SECRET", "VOICE_TOOL_SECRET"]) {
    const value = process.env[key]; delete process.env[key];
    assert.match(await (await inbound(incoming())).text(), /temporarily unavailable/);
    process.env[key] = value;
  }
  assert.equal(requests.length, 0);
});
withDb("allowlisted inbound mints one hashed session and sends the exact register-call contract", async (context) => {
  const logged: unknown[][] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) context.mock.method(console, method, (...args: unknown[]) => { logged.push(args); });
  const callSid = sid();
  const response = await inbound(incoming(callSid, { ForwardedFrom: "+19055550188" }, `?CallSid=${sid()}&From=anonymous`));
  assert.equal(response.status, 200); assert.equal(await response.text(), xml);
  assert.equal(requests.length, 1);
  const stored = await row(callSid);
  const payload = requests[0].payload;
  const variables = (payload.conversation_initiation_client_data as { dynamic_variables: Record<string, string> }).dynamic_variables;
  assert.deepEqual(payload, { agent_id: "agent_staging_test", from_number: caller, to_number: number, direction: "inbound",
    conversation_initiation_client_data: { dynamic_variables: { secret__voice_session: variables.secret__voice_session, voice_session_id: stored.id, call_sid: callSid, voice_mode: "internal" } } });
  assert.equal(new Headers(requests[0].init.headers).get("xi-api-key"), apiKey);
  assert.ok(requests[0].init.signal);
  assert.equal(stored.session_secret_hash, await hashOpaqueToken(`voice-session:${variables.secret__voice_session}`));
  assert.equal((await authenticateVoiceSession(variables.secret__voice_session))?.id, stored.id);
  for (const value of [variables.secret__voice_session, apiKey, toolSecret]) assert.ok(!JSON.stringify(stored).includes(value));
  assert.equal(stored.called_number, number); assert.equal(stored.caller_phone, caller);
  assert.equal(stored.forwarded_from, "+19055550188"); assert.equal(stored.caller_id_status, "presented");
  assert.equal(stored.provider, "elevenlabs"); assert.equal(stored.mode, "internal"); assert.equal(stored.registration_state, "registered");
  assert.ok(stored.started_at > Date.now() - 60_000);
  assert.deepEqual(logged, [], "neither session secret nor API key is logged");
});
withDb("concurrent and later inbound retries create exactly one session and one provider registration", async () => {
  const callSid = sid();
  const results = await Promise.all(Array.from({ length: 5 }, () => inbound(incoming(callSid))));
  await inbound(incoming(callSid));
  assert.equal(requests.length, 1);
  assert.equal((await getPool().query("SELECT COUNT(*)::int AS n FROM voice_calls WHERE call_sid=$1", [callSid])).rows[0].n, 1);
  assert.equal((await Promise.all(results.map((response) => response.text()))).filter((body) => body === xml).length, 1);
});
withDb("direct XML is passed through without reconstructing TwiML", async () => {
  globalThis.fetch = async () => new Response(xml, { headers: { "content-type": "text/xml" } });
  assert.equal(await (await inbound(incoming())).text(), xml);
});
withDb("register-call errors close the session and return audible fallback without logging credentials", async (context) => {
  const logged: unknown[][] = [];
  for (const method of ["log", "warn", "error", "info", "debug"] as const) context.mock.method(console, method, (...args: unknown[]) => { logged.push(args); });
  for (const failure of ["http", "exception", "bad-json", "echo-key", "echo-session"]) {
    const callSid = sid();
    globalThis.fetch = async (_url, init) => {
      if (failure === "http") return new Response(apiKey, { status: 500 });
      if (failure === "exception") throw new Error(`${apiKey} ${toolSecret}`);
      if (failure === "bad-json") return new Response("oops", { headers: { "content-type": "application/json" } });
      const secret = JSON.parse(String(init?.body)).conversation_initiation_client_data.dynamic_variables.secret__voice_session;
      return Response.json(`<Response><Say>${failure === "echo-key" ? apiKey : secret}</Say></Response>`);
    };
    const response = await inbound(incoming(callSid));
    const body = await response.text();
    assert.match(body, /temporarily unavailable/); assert.match(body, /<Hangup\/>/);
    assert.ok(!body.includes(apiKey)); assert.ok(!body.includes(toolSecret));
    const stored = await row(callSid);
    assert.equal(stored.stage, "closed"); assert.equal(stored.registration_state, "failed");
    assert.equal(stored.failure_reason, "register_call_failed"); assert.ok(stored.ended_at);
  }
  assert.deepEqual(logged, [], "provider errors and session secrets are never logged");
});
withDb("register-call timeout returns fallback and marks the call failed", async () => {
  const callSid = sid();
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    // Keep the test loop alive: AbortSignal.timeout deliberately uses an unref timer.
    setTimeout(() => reject(new Error("test deadline")), 6_000).unref();
  });
  const start = Date.now();
  // A ref'ed timer is needed only by this mock, never by the implementation.
  const keepAlive = setTimeout(() => {}, 10_000);
  try { assert.match(await (await inbound(incoming(callSid))).text(), /temporarily unavailable/); }
  finally { clearTimeout(keepAlive); }
  assert.ok(Date.now() - start < 6_000);
  assert.equal((await row(callSid)).registration_state, "failed");
});
withDb("signed status changes only its CallSid and is idempotent", async () => {
  const a = await mint(), b = await mint();
  const callback = () => twilio("status", { CallSid: a.session.callSid!, CallStatus: "completed", CallDuration: "42", SequenceNumber: "3", Timestamp: new Date().toUTCString() }, `?CallSid=${b.session.callSid}&id=${b.session.id}`);
  assert.equal((await status(callback())).status, 200);
  const first = await row(a.session.callSid!);
  assert.equal(first.twilio_status, "completed"); assert.equal(first.call_duration_seconds, 42); assert.ok(first.ended_at);
  assert.equal(first.stage, "closed");
  await status(callback());
  await status(twilio("status", { CallSid: a.session.callSid!, CallStatus: "in-progress", SequenceNumber: "4" }));
  assert.deepEqual(await row(a.session.callSid!), first);
  assert.equal((await row(b.session.callSid!)).twilio_status, null);
  const before = await getPool().query("SELECT COUNT(*) FROM voice_calls");
  await status(twilio("status", { CallSid: sid(), CallStatus: "completed" }));
  assert.deepEqual((await getPool().query("SELECT COUNT(*) FROM voice_calls")).rows, before.rows);
});
withDb("out-of-order progress statuses cannot regress a newer callback", async () => {
  const a = await mint();
  await status(twilio("status", { CallSid: a.session.callSid!, CallStatus: "in-progress", SequenceNumber: "2" }));
  await status(twilio("status", { CallSid: a.session.callSid!, CallStatus: "ringing", SequenceNumber: "1" }));
  assert.equal((await row(a.session.callSid!)).twilio_status, "in-progress");
});
withDb("progress status cannot regress even when sequence numbers are absent", async () => {
  const a = await mint();
  await status(twilio("status", { CallSid: a.session.callSid!, CallStatus: "in-progress" }));
  await status(twilio("status", { CallSid: a.session.callSid!, CallStatus: "ringing" }));
  assert.equal((await row(a.session.callSid!)).twilio_status, "in-progress");
});
test("ElevenLabs HMAC rejects invalid, stale, future, ambiguous and body-tampered signatures", async () => {
  const raw = Buffer.from('{ "type": "post_call_audio" }');
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", webhookSecret).update(`${timestamp}.`).update(raw).digest("hex");
  const header = `t=${timestamp}, v0=${digest}`;
  assert.equal(verifyElevenLabsSignature(webhookSecret, raw, header), true);
  assert.equal(verifyElevenLabsSignature(webhookSecret, Buffer.from('{}'), header), false);
  assert.equal(verifyElevenLabsSignature(webhookSecret, raw, `${header},t=${timestamp}`), false);
  assert.equal((await events(eleven({}, { signature: "bad" }))).status, 403);
  assert.equal((await events(eleven({}, { timestamp: timestamp - 1801 }))).status, 403);
  assert.equal((await events(eleven({}, { timestamp: timestamp + 120 }))).status, 403);
  assert.equal((await events(eleven({}, { raw: "{" }))).status, 400);
});
test("valid unsupported events are acknowledged without persisting their payload", async () => {
  const response = await events(eleven({ type: "post_call_audio", data: { full_audio: "ignored" } }));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, ignored: true });
});
withDb("post-call associates through the non-secret ID despite redaction and persists one sanitized event", async () => {
  const a = await mint();
  const event = postCall(a.session.id, a.session.callSid!);
  const responses = await Promise.all(Array.from({ length: 4 }, () => events(eleven(event))));
  for (const response of responses) assert.equal(response.status, 200);
  const first = await row(a.session.callSid!);
  assert.equal(first.provider_conversation_id, event.data.conversation_id); assert.equal(first.call_duration_seconds, 30);
  assert.equal(first.stage, "closed"); assert.ok(first.post_call_received_at); assert.ok(first.ended_at);
  await events(eleven(event));
  assert.deepEqual(await row(a.session.callSid!), first);
  const saved = (await getPool().query("SELECT * FROM voice_call_events WHERE voice_call_id=$1", [a.session.id])).rows;
  assert.equal(saved.length, 1);
  const encoded = JSON.stringify(saved);
  for (const forbidden of ["4111", "cvv 123", "12/29", "9055550177", "secret__", "never-save-this-secret", toolSecret, apiKey, a.sessionSecret]) assert.ok(!encoded.includes(forbidden), forbidden);
  const detail = JSON.parse(saved[0].request_json);
  assert.equal(detail.version_id, "agtver_staging_test"); assert.equal(detail.agent_version, 7); assert.equal(detail.disposition, "success"); assert.match(detail.transcript[0].message, /redacted/);
  // Once bound, conversation ID alone also handles redelivery.
  delete (event.data.conversation_initiation_client_data as { dynamic_variables?: unknown }).dynamic_variables;
  assert.equal((await events(eleven(event))).status, 200);
});
withDb("post-call refuses conflicting conversation or CallSid and retries unknown session association", async () => {
  const a = await mint();
  const initial = postCall(a.session.id, a.session.callSid!);
  assert.equal((await events(eleven(initial))).status, 200);
  assert.equal((await events(eleven(postCall(a.session.id, a.session.callSid!)))).status, 409);
  assert.equal((await events(eleven(postCall(a.session.id, sid(), initial.data.conversation_id)))).status, 409);
  assert.equal((await events(eleven(postCall(crypto.randomUUID(), sid())))).status, 503);
});
withDb("new provider credentials use encrypted integration storage and stay masked", async () => {
  process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
  for (const key of ["ELEVENLABS_API_KEY", "ELEVENLABS_WEBHOOK_SECRET", "VOICE_TOOL_SECRET"] as const) {
    const value = `encryption-test-${crypto.randomUUID()}`;
    try {
      await writeIntegrationSecret(key, value, "phase4-test");
      assert.equal(await readIntegrationSecret(key), value);
      const stored = (await getPool().query("SELECT * FROM integration_secrets WHERE key=$1", [key])).rows[0];
      assert.ok(!JSON.stringify(stored).includes(value));
      const description = (await describeIntegrationSecrets()).find((entry) => entry.key === key)!;
      assert.equal(description.configured, true); assert.notEqual(description.display, value);
    } finally { await getPool().query("DELETE FROM integration_secrets WHERE key=$1", [key]); clearIntegrationSecretCache(); }
  }
});
