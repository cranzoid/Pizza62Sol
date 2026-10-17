/**
 * Voice sessions: the server-held working order and its stage machine (Phase 2B).
 *
 * The properties pinned here are the ones a prompt cannot be trusted with:
 *
 * - voice is off, pickup-only and capped unless configured otherwise;
 * - a session's secret is returned once, stored only as a hash, and opens that
 *   session and no other;
 * - every change to the draft moves `cart_version` and clears the review and
 *   the confirmation, so a "yes" belongs to exactly one version;
 * - the transitions refuse what is out of order — confirming before a review,
 *   confirming an old version, placing before a confirmation, changing anything
 *   once placing has begun — and two racing calls cannot both win;
 * - the database itself refuses the half-states, and the event log cannot be
 *   rewritten.
 *
 * Requires a reachable Postgres; skipped otherwise.
 */
import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool } = await import("@/db/pg-driver");
const { hashOpaqueToken } = await import("@/lib/domain");
const config = await import("@/lib/voice/config");
const {
  abandonPlacement,
  applyDraftChange,
  authenticateVoiceSession,
  beginPlacement,
  closeVoiceSession,
  completePlacement,
  createVoiceSession,
  draftStage,
  expireConfirmation,
  loadVoiceSession,
  recordConfirmation,
  recordReview,
  recordToolEvent,
  startDraft,
} = await import("@/lib/voice/session");

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);
after(async () => {
  await closePool();
});
afterEach(() => {
  for (const key of ["VOICE_AI_MODE", "VOICE_TOOL_SECRET", "VOICE_PILOT_FULFILMENTS", "VOICE_MAX_ORDER_CENTS"]) delete process.env[key];
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const line = (lineId: string, productId = "poutine") => ({
  lineId,
  productId,
  variationId: null,
  quantity: 1,
  toppings: [],
  omitToppings: [],
  extraCheese: false,
  modifiers: [],
  notes: null,
});

async function started(fulfilment: "pickup" | "delivery" | null = "pickup") {
  const { session, sessionSecret } = await createVoiceSession({ provider: "test", mode: "test" });
  const result = await startDraft(session, { fulfilment });
  assert.ok(result.ok);
  return { session: result.session, sessionSecret };
}

async function seedOrder(): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await getPool().query(
    `INSERT INTO orders (id,order_number,tracking_token_hash,feedback_token_hash,customer_name,customer_phone,
       customer_email,fulfilment,channel,status,payment_status,payment_method,schedule_type,estimated_for,pricing_json,
       subtotal_cents,discount_cents,tax_cents,delivery_fee_cents,tip_cents,total_cents,created_at,updated_at)
     VALUES ($1,$2,$1,$1,'Voice Test','9055550100','','pickup','ai_phone','received','pending_at_store','pay_at_store','asap',$3,'{}',0,0,0,0,0,0,$3,$3)`,
    [id, `P62-V${id.slice(0, 8)}`, now],
  );
  return id;
}

// --- configuration ------------------------------------------------------------------

test("voice is off, pickup-only and capped until configured", async () => {
  assert.equal(await config.voiceAiMode(), "off");
  process.env.VOICE_AI_MODE = "LIVE";
  assert.equal(await config.voiceAiMode(), "live");
  process.env.VOICE_AI_MODE = "on";
  assert.equal(await config.voiceAiMode(), "off", "an unrecognised mode is off, not on");

  assert.deepEqual([...(await config.voicePilotFulfilments())], ["pickup"]);
  process.env.VOICE_PILOT_FULFILMENTS = "pickup,delivery";
  assert.deepEqual([...(await config.voicePilotFulfilments())].sort(), ["delivery", "pickup"]);

  assert.equal(await config.voiceMaxOrderCents(), 15_000);
  process.env.VOICE_MAX_ORDER_CENTS = "999999999";
  assert.equal(await config.voiceMaxOrderCents(), 15_000, "an absurd cap falls back to the default");

  assert.equal(await config.voiceToolSecret(), null);
  process.env.VOICE_TOOL_SECRET = "short";
  assert.equal(await config.voiceToolSecret(), null, "a guessable bearer is treated as none");
  process.env.VOICE_TOOL_SECRET = "x".repeat(40);
  assert.equal(await config.voiceToolSecret(), "x".repeat(40));
});

// --- minting and authenticating ---------------------------------------------------------

withDb("a session's secret is returned once and stored only as a hash", async () => {
  const { session, sessionSecret } = await createVoiceSession({ provider: "test", mode: "test", callerPhone: "+19055550199", callerIdStatus: "presented" });
  assert.ok(sessionSecret.length >= 40);
  assert.equal(session.stage, "new");
  assert.equal(session.cartVersion, 0);
  const row = (await getPool().query<Record<string, unknown>>("SELECT * FROM voice_calls WHERE id=$1", [session.id])).rows[0];
  assert.equal(row.session_secret_hash, await hashOpaqueToken(`voice-session:${sessionSecret}`));
  assert.ok(!JSON.stringify(row).includes(sessionSecret), "the secret itself is nowhere in the row");
  assert.equal(row.caller_id_status, "presented");
});

withDb("a secret opens its own session and no other", async () => {
  const a = await createVoiceSession({ provider: "test", mode: "test" });
  const b = await createVoiceSession({ provider: "test", mode: "test" });
  assert.equal((await authenticateVoiceSession(a.sessionSecret))?.id, a.session.id);
  assert.equal((await authenticateVoiceSession(b.sessionSecret))?.id, b.session.id);
  assert.equal(await authenticateVoiceSession(`${a.sessionSecret}x`), null);
  assert.equal(await authenticateVoiceSession(a.sessionSecret.slice(0, -1)), null);
  assert.equal(await authenticateVoiceSession(""), null);
  assert.equal(await authenticateVoiceSession(undefined), null);
  assert.equal(await authenticateVoiceSession({ secret: a.sessionSecret }), null);
  assert.equal(await authenticateVoiceSession(a.session.id), null, "the session id is not a credential");
});

withDb("an expired or closed session no longer authenticates", async () => {
  const now = Date.now();
  const expired = await createVoiceSession({ provider: "test", mode: "test", now: now - 60_000, ttlMs: 30_000 });
  assert.equal(await authenticateVoiceSession(expired.sessionSecret, now), null);
  const closed = await createVoiceSession({ provider: "test", mode: "test" });
  await closeVoiceSession(closed.session.id, "caller hung up");
  assert.equal(await authenticateVoiceSession(closed.sessionSecret), null);
  // Nor can anything be changed on it.
  const stale = await loadVoiceSession(expired.session.id);
  const change = await startDraft(stale!, { now });
  assert.equal(change.ok, false);
});

// --- the draft and its version -------------------------------------------------------------

withDb("the draft's stage follows what it still needs", async () => {
  assert.equal(draftStage({ fulfilment: null, deliveryAddress: null }), "fulfilment");
  assert.equal(draftStage({ fulfilment: "delivery", deliveryAddress: null }), "address");
  assert.equal(draftStage({ fulfilment: "delivery", deliveryAddress: { line1: "55 Parkdale Ave N" } }), "building");
  assert.equal(draftStage({ fulfilment: "pickup", deliveryAddress: null }), "building");
  const { session } = await createVoiceSession({ provider: "test", mode: "test" });
  // Nothing changes before the order is started.
  assert.equal((await applyDraftChange(session, { cart: [line("L1")] })).ok, false);
  const fresh = await startDraft(session, { fulfilment: null });
  assert.ok(fresh.ok && fresh.session.stage === "fulfilment");
  const delivery = await applyDraftChange(fresh.session, { fulfilment: "delivery" });
  assert.ok(delivery.ok && delivery.session.stage === "address");
  const addressed = await applyDraftChange(delivery.session, { deliveryAddress: { line1: "55 Parkdale Ave N" } });
  assert.ok(addressed.ok && addressed.session.stage === "building");
  const pickup = await applyDraftChange(addressed.session, { fulfilment: "pickup" });
  assert.ok(pickup.ok);
  assert.equal(pickup.session.deliveryAddress, null, "pickup drops the address");
});

withDb("every change moves the version, and a stale one is refused", async () => {
  const { session } = await started();
  const first = await applyDraftChange(session, { cart: [line("L1")], nextLineNumber: 2 });
  assert.ok(first.ok);
  assert.equal(first.session.cartVersion, session.cartVersion + 1);
  const stale = await applyDraftChange(session, { cart: [line("L1"), line("L2")] }, { expectedVersion: session.cartVersion });
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.reason, "stale");
  assert.equal((await loadVoiceSession(session.id))?.cart.length, 1, "the stale write changed nothing");
});

withDb("two changes racing from one version: exactly one wins", async () => {
  const { session } = await started();
  const results = await Promise.all([
    applyDraftChange(session, { cart: [line("L1", "poutine")] }),
    applyDraftChange(session, { cart: [line("L1", "fries")] }),
    applyDraftChange(session, { cart: [line("L1", "wedges")] }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal((await loadVoiceSession(session.id))?.cartVersion, session.cartVersion + 1);
});

// --- review, confirmation, placement ------------------------------------------------------------

withDb("a confirmation belongs to exactly the reviewed version", async () => {
  const { session } = await started();
  const built = await applyDraftChange(session, { cart: [line("L1")] });
  assert.ok(built.ok);
  // Not before a review.
  assert.equal((await recordConfirmation(built.session, built.session.cartVersion, "yes")).ok, false);
  const reviewed = await recordReview(built.session, 1016);
  assert.ok(reviewed.ok);
  assert.equal(reviewed.session.stage, "review");
  assert.equal(reviewed.session.reviewedVersion, reviewed.session.cartVersion);
  assert.equal(reviewed.session.reviewedAmountCents, 1016);
  // Not for an old version.
  assert.equal((await recordConfirmation(reviewed.session, reviewed.session.cartVersion - 1, "yes")).ok, false);
  const confirmed = await recordConfirmation(reviewed.session, reviewed.session.cartVersion, "yes that's right");
  assert.ok(confirmed.ok);
  assert.equal(confirmed.session.stage, "confirmed");
  assert.equal(confirmed.session.confirmedVersion, reviewed.session.cartVersion);
  assert.equal(confirmed.session.confirmedAmountCents, 1016);
  assert.equal(confirmed.session.confirmationUtterance, "yes that's right");
});

withDb("changing anything after review or confirmation invalidates both", async () => {
  const { session } = await started();
  const built = await applyDraftChange(session, { cart: [line("L1")] });
  assert.ok(built.ok);
  const reviewed = await recordReview(built.session, 1016);
  assert.ok(reviewed.ok);
  const confirmed = await recordConfirmation(reviewed.session, reviewed.session.cartVersion, "yes");
  assert.ok(confirmed.ok);
  for (const change of [
    { cart: [line("L1"), line("L2", "fries")] },
    { customer: { name: "Jordan", phone: "9055550177", phoneSource: "spoken" as const } },
    { fulfilment: "delivery" as const },
  ]) {
    const current = (await loadVoiceSession(session.id))!;
    if (current.reviewedVersion === null) {
      const again = await recordReview(current, 1016);
      if (again.ok) await recordConfirmation(again.session, again.session.cartVersion, "yes");
    }
    const before = (await loadVoiceSession(session.id))!;
    const changed = await applyDraftChange(before, change);
    assert.ok(changed.ok, JSON.stringify(change));
    assert.equal(changed.session.reviewedVersion, null);
    assert.equal(changed.session.confirmedVersion, null);
    assert.equal(changed.session.confirmedAt, null);
    assert.equal(changed.session.confirmedAmountCents, null);
    assert.equal(changed.session.confirmationUtterance, null);
    assert.ok(["building", "address"].includes(changed.session.stage));
    // The old version can no longer be confirmed.
    assert.equal((await recordConfirmation(changed.session, before.cartVersion, "yes")).ok, false);
  }
});

withDb("placing needs a confirmation of the current version, and locks the draft", async () => {
  const { session } = await started();
  const built = await applyDraftChange(session, { cart: [line("L1")] });
  assert.ok(built.ok);
  assert.equal((await beginPlacement(built.session, built.session.cartVersion)).ok, false, "not before review");
  const reviewed = await recordReview(built.session, 1016);
  assert.ok(reviewed.ok);
  assert.equal((await beginPlacement(reviewed.session, reviewed.session.cartVersion)).ok, false, "not after review alone");
  const confirmed = await recordConfirmation(reviewed.session, reviewed.session.cartVersion, "yes");
  assert.ok(confirmed.ok);
  assert.equal((await beginPlacement(confirmed.session, confirmed.session.cartVersion - 1)).ok, false, "not for another version");
  const placing = await beginPlacement(confirmed.session, confirmed.session.cartVersion);
  assert.ok(placing.ok);
  assert.equal(placing.session.stage, "placing");
  const locked = await applyDraftChange(placing.session, { cart: [] });
  assert.equal(locked.ok === false && locked.reason, "locked");
  assert.equal((await startDraft(placing.session)).ok, false, "no restarting mid-placement");
  // A retry after a timeout may re-enter: the idempotency key makes it safe.
  assert.ok((await beginPlacement(placing.session, placing.session.cartVersion)).ok);
});

withDb("an order is set once, and a placed session can never place another", async () => {
  const { session } = await started();
  const built = await applyDraftChange(session, { cart: [line("L1")] });
  assert.ok(built.ok);
  const reviewed = await recordReview(built.session, 1016);
  assert.ok(reviewed.ok);
  const confirmed = await recordConfirmation(reviewed.session, reviewed.session.cartVersion, "yes");
  assert.ok(confirmed.ok);
  const placing = await beginPlacement(confirmed.session, confirmed.session.cartVersion);
  assert.ok(placing.ok);
  const orderId = await seedOrder();
  const placed = await completePlacement(placing.session, orderId);
  assert.ok(placed.ok);
  assert.equal(placed.session.stage, "placed");
  assert.equal(placed.session.orderId, orderId);
  assert.ok((await completePlacement(placed.session, orderId)).ok, "recording the same order again is harmless");
  assert.equal((await completePlacement(placed.session, await seedOrder())).ok, false, "a second order is refused");
  assert.equal((await applyDraftChange(placed.session, { cart: [] })).ok, false);
  assert.equal((await startDraft(placed.session)).ok, false);
  assert.equal((await beginPlacement(placed.session, placed.session.cartVersion)).ok, false);
  // Still authenticates, so a retried place_order can read its order back.
  assert.equal((await loadVoiceSession(session.id))?.orderId, orderId);
});

withDb("a refused placement releases the lock and asks for a new review", async () => {
  const { session } = await started();
  const built = await applyDraftChange(session, { cart: [line("L1")] });
  assert.ok(built.ok);
  const reviewed = await recordReview(built.session, 1016);
  assert.ok(reviewed.ok);
  const confirmed = await recordConfirmation(reviewed.session, reviewed.session.cartVersion, "yes");
  assert.ok(confirmed.ok);
  const placing = await beginPlacement(confirmed.session, confirmed.session.cartVersion);
  assert.ok(placing.ok);
  const released = await abandonPlacement(placing.session, "TOTAL_CHANGED");
  assert.ok(released.ok);
  assert.equal(released.session.stage, "building");
  assert.equal(released.session.reviewedVersion, null);
  assert.equal(released.session.confirmedVersion, null);
  assert.equal(released.session.failureReason, "TOTAL_CHANGED");
  assert.ok((await applyDraftChange(released.session, { cart: [line("L1"), line("L2")] })).ok, "editable again");
});

withDb("an old confirmation can be expired back to the read-back", async () => {
  const { session } = await started();
  const built = await applyDraftChange(session, { cart: [line("L1")] });
  assert.ok(built.ok);
  const reviewed = await recordReview(built.session, 1016);
  assert.ok(reviewed.ok);
  const confirmed = await recordConfirmation(reviewed.session, reviewed.session.cartVersion, "yes");
  assert.ok(confirmed.ok);
  const expired = await expireConfirmation(confirmed.session);
  assert.ok(expired.ok);
  assert.equal(expired.session.stage, "review");
  assert.equal(expired.session.confirmedVersion, null);
  assert.equal(expired.session.reviewedVersion, confirmed.session.cartVersion, "the review stands");
  assert.ok((await recordConfirmation(expired.session, expired.session.cartVersion, "yes")).ok);
});

// --- the database refuses half-states -------------------------------------------------------------

withDb("the database refuses a confirmation without its review, or a placed session without an order", async () => {
  const { session } = await started();
  await assert.rejects(
    getPool().query("UPDATE voice_calls SET confirmed_version = cart_version, confirmed_at = 1, confirmed_amount_cents = 100 WHERE id = $1", [session.id]),
    /voice_calls_confirmation_consistent/,
  );
  await assert.rejects(getPool().query("UPDATE voice_calls SET stage = 'placed' WHERE id = $1", [session.id]), /voice_calls_placed_has_order/);
  await assert.rejects(getPool().query("UPDATE voice_calls SET stage = 'dancing' WHERE id = $1", [session.id]), /voice_calls_stage/);
  await assert.rejects(
    getPool().query("UPDATE voice_calls SET reviewed_version = cart_version + 5, reviewed_amount_cents = 1, reviewed_at = 1 WHERE id = $1", [session.id]),
    /voice_calls_review_consistent/,
  );
  await assert.rejects(
    getPool().query(
      `UPDATE voice_calls SET reviewed_version = cart_version, reviewed_amount_cents = 100, reviewed_at = 1,
         confirmed_version = cart_version, confirmed_at = 1, confirmed_amount_cents = 99 WHERE id = $1`,
      [session.id],
    ),
    /voice_calls_confirmation_consistent/,
    "a confirmation at a different amount from the review",
  );
});

// --- the event log ---------------------------------------------------------------------------------

withDb("tool calls are logged append-only and move the session's counters", async () => {
  const a = await started();
  const b = await started();
  const event = (ok: boolean) => ({
    tool: "add_item",
    request: { productId: "poutine" },
    response: { ok },
    ok,
    issueCodes: ok ? [] : ["ITEM_UNAVAILABLE"],
    latencyMs: 12,
    cartVersionBefore: 1,
    cartVersionAfter: ok ? 2 : 1,
    validationFailure: !ok,
  });
  assert.deepEqual(await recordToolEvent(a.session.id, event(false)), { toolCallCount: 1, consecutiveFailureCount: 1 });
  assert.deepEqual(await recordToolEvent(a.session.id, event(false)), { toolCallCount: 2, consecutiveFailureCount: 2 });
  assert.deepEqual(await recordToolEvent(a.session.id, event(true)), { toolCallCount: 3, consecutiveFailureCount: 0 });
  const after = (await loadVoiceSession(a.session.id))!;
  assert.equal(after.validationErrorCount, 2);
  assert.equal((await loadVoiceSession(b.session.id))!.toolCallCount, 0, "another session's counters are untouched");

  const rows = await getPool().query<{ id: string; ok: number; issue_codes_json: string | null }>(
    "SELECT id, ok, issue_codes_json FROM voice_call_events WHERE voice_call_id = $1 AND event_type = 'tool' ORDER BY created_at",
    [a.session.id],
  );
  assert.equal(rows.rows.length, 3);
  assert.equal(rows.rows[0].issue_codes_json, JSON.stringify(["ITEM_UNAVAILABLE"]));
  await assert.rejects(getPool().query("UPDATE voice_call_events SET ok = 1 WHERE id = $1", [rows.rows[0].id]), /append-only/);
});
