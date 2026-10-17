/**
 * The voice session: the call's working order and the rules for changing it.
 *
 * The language model never holds transactional state. It calls tools; the
 * tools read and write this row (`voice_calls`), and every rule that matters —
 * what may happen in which stage, which version was reviewed, which version
 * was confirmed, whether an order already exists — is enforced here, in SQL,
 * not in a prompt.
 *
 * **Each transition is one conditional UPDATE … RETURNING.** The WHERE clause
 * carries the precondition (the version the caller saw, the stage it must be
 * in), so a stale retry, a duplicate request or two tool calls racing each
 * other cannot both succeed: one updates the row and the other finds nothing
 * to update and is told why. Nothing reads, decides and then writes.
 *
 * **One version for the whole draft.** Any change to anything the order is
 * built from — lines, fulfilment, customer, address, time, promo code, tip — increments
 * `cart_version` and clears the review and the confirmation, so a "yes" can
 * only ever place the exact draft the caller heard read back.
 *
 * **Sessions are minted by server code only** (`createVoiceSession`). There is
 * an inbound-call webhook that creates one only after it has
 * verified Twilio's signature. The session secret is returned once and stored
 * as a hash.
 */
import { getD1 } from "@/db/runtime";
import { generateOpaqueToken, hashOpaqueToken, type Fulfilment, type ToppingPlacement } from "@/lib/domain";
import { VOICE_SESSION_TTL_MS } from "@/lib/voice/config";

export type VoiceCallStage =
  | "new"
  | "fulfilment"
  | "building"
  | "address"
  | "review"
  | "confirmed"
  | "placing"
  | "placed"
  | "closed";

export type CallerIdStatus = "presented" | "forwarded_as_store" | "withheld" | "unknown";

/**
 * One line of the working order: ids and choices only, never a price. It is
 * an `OrderRequest` item in waiting — see lib/voice/cart.ts — and is priced by
 * `quoteOrder` every time it is read back.
 */
export type VoiceCartLine = {
  lineId: string;
  productId: string;
  variationId: string | null;
  quantity: number;
  /** For a specialty pizza, additions to the recipe; for anything else, every topping. */
  toppings: Array<{ toppingId: string; placement: ToppingPlacement }>;
  /** Recipe toppings the caller asked to leave off. */
  omitToppings: string[];
  extraCheese: boolean;
  /**
   * Light or no cheese, written ahead of the notes the way the website's cheese
   * step writes it. Absent on lines stored before it existed, which is regular.
   */
  cheese?: "none" | "light" | null;
  modifiers: Array<{ id: string; values: Array<string | { value: string; placement: ToppingPlacement }> }>;
  notes: string | null;
};

/**
 * The caller's checkout choices that are not lines: when, a promo code, a tip.
 *
 * Choices in the shape `OrderRequest` takes them, never amounts. A scheduled
 * time is a slot timestamp the server chose from `nextOrderSlots`
 * (lib/voice/schedule.ts); a code is what the caller said, normalized; a tip
 * is a preset percentage or a dollar amount the caller named. `quoteOrder`
 * prices all three, exactly as it prices them for the website.
 */
export type VoiceOrderOptions = {
  schedule: { type: "asap" } | { type: "scheduled"; scheduledFor: number };
  couponCode: string | null;
  tip: { type: "none" } | { type: "percentage"; valueBps: number } | { type: "custom"; amountCents: number };
};

export const DEFAULT_ORDER_OPTIONS: VoiceOrderOptions = Object.freeze({
  schedule: Object.freeze({ type: "asap" }) as VoiceOrderOptions["schedule"],
  couponCode: null,
  tip: Object.freeze({ type: "none" }) as VoiceOrderOptions["tip"],
});

/**
 * Reads stored options defensively. A row written before this column existed
 * holds `{}`, which is exactly the old behaviour: ASAP, no code, no tip. A
 * malformed value falls back the same way rather than to anything the caller
 * did not choose.
 */
export function parseOrderOptions(value: unknown): VoiceOrderOptions {
  const raw = parseJson<Record<string, unknown>>(value, {});
  const schedule = raw.schedule as Record<string, unknown> | undefined;
  const tip = raw.tip as Record<string, unknown> | undefined;
  return {
    schedule: schedule?.type === "scheduled" && Number.isSafeInteger(schedule.scheduledFor)
      ? { type: "scheduled", scheduledFor: Number(schedule.scheduledFor) }
      : { type: "asap" },
    couponCode: typeof raw.couponCode === "string" && raw.couponCode ? raw.couponCode : null,
    tip: tip?.type === "percentage" && Number.isSafeInteger(tip.valueBps)
      ? { type: "percentage", valueBps: Number(tip.valueBps) }
      : tip?.type === "custom" && Number.isSafeInteger(tip.amountCents)
        ? { type: "custom", amountCents: Number(tip.amountCents) }
        : { type: "none" },
  };
}

/** The delivery decision for the stored address, kept so the agent's next answer is the same one. */
export type StoredDeliveryCheck = {
  cartVersion: number;
  addressDeliverable: boolean;
  eligible: boolean;
  reason: string;
  feeCents: number;
  minimumCents: number;
  shortfallCents: number;
  checkedAt: number;
};

export type VoiceSession = {
  id: string;
  provider: "elevenlabs" | "simulator" | "test";
  mode: "test" | "internal" | "pilot" | "live";
  callSid: string | null;
  providerConversationId: string | null;
  calledNumber: string | null;
  forwardedFrom: string | null;
  callerPhone: string | null;
  callerIdStatus: CallerIdStatus;
  stage: VoiceCallStage;
  fulfilment: Fulfilment | null;
  customerName: string | null;
  customerPhone: string | null;
  customerPhoneSource: "caller_id" | "spoken" | null;
  deliveryAddress: Record<string, string> | null;
  deliveryCheck: StoredDeliveryCheck | null;
  cart: VoiceCartLine[];
  orderOptions: VoiceOrderOptions;
  cartVersion: number;
  nextLineNumber: number;
  reviewedVersion: number | null;
  reviewedAmountCents: number | null;
  reviewedAt: number | null;
  confirmedVersion: number | null;
  confirmedAt: number | null;
  confirmedAmountCents: number | null;
  confirmationUtterance: string | null;
  placementStartedAt: number | null;
  orderId: string | null;
  placedAt: number | null;
  toolCallCount: number;
  validationErrorCount: number;
  consecutiveFailureCount: number;
  escalationReason: string | null;
  failureReason: string | null;
  startedAt: number;
  endedAt: number | null;
  expiresAt: number;
};

type Row = Record<string, unknown>;

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toSession(row: Row): VoiceSession {
  return {
    id: String(row.id),
    provider: row.provider as VoiceSession["provider"],
    mode: row.mode as VoiceSession["mode"],
    callSid: (row.call_sid as string | null) ?? null,
    providerConversationId: (row.provider_conversation_id as string | null) ?? null,
    calledNumber: (row.called_number as string | null) ?? null,
    forwardedFrom: (row.forwarded_from as string | null) ?? null,
    callerPhone: (row.caller_phone as string | null) ?? null,
    callerIdStatus: row.caller_id_status as CallerIdStatus,
    stage: row.stage as VoiceCallStage,
    fulfilment: (row.fulfilment as Fulfilment | null) ?? null,
    customerName: (row.customer_name as string | null) ?? null,
    customerPhone: (row.customer_phone as string | null) ?? null,
    customerPhoneSource: (row.customer_phone_source as VoiceSession["customerPhoneSource"]) ?? null,
    deliveryAddress: parseJson<Record<string, string> | null>(row.delivery_address_json, null),
    deliveryCheck: parseJson<StoredDeliveryCheck | null>(row.delivery_check_json, null),
    cart: parseJson<VoiceCartLine[]>(row.cart_json, []),
    orderOptions: parseOrderOptions(row.order_options_json),
    cartVersion: Number(row.cart_version),
    nextLineNumber: Number(row.next_line_number),
    reviewedVersion: num(row.reviewed_version),
    reviewedAmountCents: num(row.reviewed_amount_cents),
    reviewedAt: num(row.reviewed_at),
    confirmedVersion: num(row.confirmed_version),
    confirmedAt: num(row.confirmed_at),
    confirmedAmountCents: num(row.confirmed_amount_cents),
    confirmationUtterance: (row.confirmation_utterance as string | null) ?? null,
    placementStartedAt: num(row.placement_started_at),
    orderId: (row.order_id as string | null) ?? null,
    placedAt: num(row.placed_at),
    toolCallCount: Number(row.tool_call_count),
    validationErrorCount: Number(row.validation_error_count),
    consecutiveFailureCount: Number(row.consecutive_failure_count),
    escalationReason: (row.escalation_reason as string | null) ?? null,
    failureReason: (row.failure_reason as string | null) ?? null,
    startedAt: Number(row.started_at),
    endedAt: num(row.ended_at),
    expiresAt: Number(row.expires_at),
  };
}

/** Domain-separated so a voice secret can never be confused with any other hashed token. */
async function hashSessionSecret(secret: string): Promise<string> {
  return hashOpaqueToken(`voice-session:${secret}`);
}

// --- minting and finding sessions ---------------------------------------------------

export type NewVoiceSession = {
  provider: VoiceSession["provider"];
  mode: VoiceSession["mode"];
  calledNumber?: string | null;
  forwardedFrom?: string | null;
  /** Atomically claim a signed inbound CallSid; losers must not register it again. */
  deduplicateCallSid?: boolean;
  callerPhone?: string | null;
  callerIdStatus?: CallerIdStatus;
  callSid?: string | null;
  providerConversationId?: string | null;
  now?: number;
  ttlMs?: number;
};

/**
 * A new session and its secret. **Server code only** — the secret is what lets
 * a tool call act on this session, so whatever calls this must already have
 * established who is on the line (the inbound webhook, by Twilio's
 * signature) or be a test. The secret is not stored and cannot be recovered.
 */
type MintedVoiceSession = { session: VoiceSession; sessionSecret: string };
export function createVoiceSession(input: NewVoiceSession & { deduplicateCallSid: true }): Promise<MintedVoiceSession | null>;
export function createVoiceSession(input: NewVoiceSession & { deduplicateCallSid?: false }): Promise<MintedVoiceSession>;
export async function createVoiceSession(input: NewVoiceSession): Promise<MintedVoiceSession | null> {
  if (input.deduplicateCallSid && !input.callSid) throw new Error("An inbound session requires CallSid");
  const now = input.now ?? Date.now();
  const sessionSecret = generateOpaqueToken(32);
  const row = await getD1()
    .prepare(
      `INSERT INTO voice_calls
       (id, provider, mode, call_sid, provider_conversation_id, session_secret_hash, caller_phone, caller_id_status,
        called_number, forwarded_from, stage, started_at, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)
       ON CONFLICT (call_sid) WHERE call_sid IS NOT NULL DO NOTHING
       RETURNING *`,
    )
    .bind(
      crypto.randomUUID(),
      input.provider,
      input.mode,
      input.callSid ?? null,
      input.providerConversationId ?? null,
      await hashSessionSecret(sessionSecret),
      input.callerPhone ?? null,
      input.callerIdStatus ?? "unknown",
      input.calledNumber ?? null,
      input.forwardedFrom ?? null,
      now,
      now + (input.ttlMs ?? VOICE_SESSION_TTL_MS),
      now,
      now,
    )
    .first<Row>();
  if (!row && input.deduplicateCallSid) return null;
  if (!row) throw new Error("voice session could not be created");
  return { session: toSession(row), sessionSecret };
}

/**
 * The live session a secret belongs to, or null — for an unknown secret, an
 * expired session or a closed one alike, so a caller cannot tell them apart.
 * A placed session still authenticates: a retried `place_order` must be able
 * to get its order back.
 */
export async function authenticateVoiceSession(secret: unknown, now: number = Date.now()): Promise<VoiceSession | null> {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 200) return null;
  const row = await getD1()
    .prepare("SELECT * FROM voice_calls WHERE session_secret_hash = ?")
    .bind(await hashSessionSecret(secret))
    .first<Row>();
  if (!row) return null;
  const session = toSession(row);
  if (session.expiresAt <= now || session.stage === "closed") return null;
  return session;
}

export async function loadVoiceSession(id: string): Promise<VoiceSession | null> {
  const row = await getD1().prepare("SELECT * FROM voice_calls WHERE id = ?").bind(id).first<Row>();
  return row ? toSession(row) : null;
}

// --- the stage machine ---------------------------------------------------------------

/**
 * The stage a draft is in while it is being built: it needs a fulfilment, then
 * (for a delivery) an address, then it is being built. Review, confirmation and
 * placement are entered only by their own transitions below.
 */
export function draftStage(draft: Pick<VoiceSession, "fulfilment" | "deliveryAddress">): VoiceCallStage {
  if (!draft.fulfilment) return "fulfilment";
  if (draft.fulfilment === "delivery" && !draft.deliveryAddress) return "address";
  return "building";
}

/** Stages in which the draft may change. A change in `review` or `confirmed` drops back to building. */
const EDITABLE_STAGES: VoiceCallStage[] = ["fulfilment", "building", "address", "review", "confirmed"];

export type DraftChange = {
  cart?: VoiceCartLine[];
  nextLineNumber?: number;
  fulfilment?: Fulfilment | null;
  customer?: { name: string; phone: string; phoneSource: "caller_id" | "spoken" } | null;
  deliveryAddress?: Record<string, string> | null;
  deliveryCheck?: StoredDeliveryCheck | null;
  options?: VoiceOrderOptions;
};

export type TransitionResult =
  | { ok: true; session: VoiceSession }
  | { ok: false; reason: "stale" | "locked" | "expired"; session: VoiceSession | null };

async function refused(id: string, now: number): Promise<TransitionResult> {
  const current = await loadVoiceSession(id);
  if (!current || current.expiresAt <= now || current.stage === "closed") return { ok: false, reason: "expired", session: current };
  if (current.stage === "placing" || current.stage === "placed" || current.stage === "new") return { ok: false, reason: "locked", session: current };
  return { ok: false, reason: "stale", session: current };
}

/**
 * Changes the draft. Increments `cart_version`, clears the review and the
 * confirmation, and recomputes the stage — all in one statement conditional on
 * the version the caller last saw and on the draft still being editable.
 */
export async function applyDraftChange(
  session: VoiceSession,
  change: DraftChange,
  options: { expectedVersion?: number; now?: number } = {},
): Promise<TransitionResult> {
  const now = options.now ?? Date.now();
  const expected = options.expectedVersion ?? session.cartVersion;
  const merged = {
    fulfilment: change.fulfilment !== undefined ? change.fulfilment : session.fulfilment,
    deliveryAddress: change.deliveryAddress !== undefined ? change.deliveryAddress : session.deliveryAddress,
  };
  // Going back to pickup leaves no address to deliver to.
  if (merged.fulfilment !== "delivery" && change.fulfilment !== undefined) merged.deliveryAddress = null;
  const customer = change.customer !== undefined
    ? change.customer
    : session.customerName
      ? { name: session.customerName, phone: session.customerPhone ?? "", phoneSource: session.customerPhoneSource ?? "spoken" }
      : null;
  const deliveryCheck = change.deliveryCheck !== undefined
    ? change.deliveryCheck
    : merged.deliveryAddress === session.deliveryAddress ? session.deliveryCheck : null;
  const row = await getD1()
    .prepare(
      `UPDATE voice_calls SET
         cart_json = ?, next_line_number = ?, fulfilment = ?, customer_name = ?, customer_phone = ?,
         customer_phone_source = ?, delivery_address_json = ?, delivery_check_json = ?, order_options_json = ?,
         cart_version = cart_version + 1,
         reviewed_version = NULL, reviewed_amount_cents = NULL, reviewed_at = NULL,
         confirmed_version = NULL, confirmed_at = NULL, confirmed_amount_cents = NULL, confirmation_utterance = NULL,
         stage = ?, updated_at = ?
       WHERE id = ? AND cart_version = ? AND stage IN (${EDITABLE_STAGES.map(() => "?").join(", ")}) AND expires_at > ?
       RETURNING *`,
    )
    .bind(
      JSON.stringify(change.cart ?? session.cart),
      change.nextLineNumber ?? session.nextLineNumber,
      merged.fulfilment,
      customer?.name ?? null,
      customer?.phone ?? null,
      customer?.phoneSource ?? null,
      merged.deliveryAddress ? JSON.stringify(merged.deliveryAddress) : null,
      deliveryCheck ? JSON.stringify(deliveryCheck) : null,
      JSON.stringify(change.options ?? session.orderOptions),
      draftStage(merged),
      now,
      session.id,
      expected,
      ...EDITABLE_STAGES,
      now,
    )
    .first<Row>();
  return row ? { ok: true, session: toSession(row) } : refused(session.id, now);
}

/**
 * Starts (or restarts) the working order. Allowed from `new` and from any
 * editable stage; it empties the cart and the address and keeps the caller's
 * name and number. The promo code and tip go with the cart they were priced
 * on; the order time is kept only when `keepSchedule` says so (starting over
 * is not changing your mind about when). Never after an order has been placed.
 */
export async function startDraft(
  session: VoiceSession,
  options: { fulfilment?: Fulfilment | null; keepSchedule?: boolean; now?: number } = {},
): Promise<TransitionResult> {
  const now = options.now ?? Date.now();
  const fulfilment = options.fulfilment ?? null;
  const kept: VoiceOrderOptions = {
    ...DEFAULT_ORDER_OPTIONS,
    schedule: options.keepSchedule ? session.orderOptions.schedule : DEFAULT_ORDER_OPTIONS.schedule,
  };
  const row = await getD1()
    .prepare(
      `UPDATE voice_calls SET
         cart_json = '[]', fulfilment = ?, delivery_address_json = NULL, delivery_check_json = NULL,
         order_options_json = ?,
         cart_version = cart_version + 1,
         reviewed_version = NULL, reviewed_amount_cents = NULL, reviewed_at = NULL,
         confirmed_version = NULL, confirmed_at = NULL, confirmed_amount_cents = NULL, confirmation_utterance = NULL,
         stage = ?, updated_at = ?
       WHERE id = ? AND stage IN ('new', ${EDITABLE_STAGES.map(() => "?").join(", ")}) AND expires_at > ?
       RETURNING *`,
    )
    .bind(fulfilment, JSON.stringify(kept), draftStage({ fulfilment, deliveryAddress: null }), now, session.id, ...EDITABLE_STAGES, now)
    .first<Row>();
  return row ? { ok: true, session: toSession(row) } : refused(session.id, now);
}

/** The server-authored read-back was given for this exact version, at this amount. */
export async function recordReview(
  session: VoiceSession,
  amountDueCents: number,
  options: { now?: number } = {},
): Promise<TransitionResult> {
  const now = options.now ?? Date.now();
  const row = await getD1()
    .prepare(
      `UPDATE voice_calls SET
         reviewed_version = cart_version, reviewed_amount_cents = ?, reviewed_at = ?,
         confirmed_version = NULL, confirmed_at = NULL, confirmed_amount_cents = NULL, confirmation_utterance = NULL,
         stage = 'review', updated_at = ?
       WHERE id = ? AND cart_version = ? AND stage IN ('building', 'review', 'confirmed') AND expires_at > ?
       RETURNING *`,
    )
    .bind(amountDueCents, now, now, session.id, session.cartVersion, now)
    .first<Row>();
  return row ? { ok: true, session: toSession(row) } : refused(session.id, now);
}

/**
 * The caller said yes to the read-back of `version`. Only possible while that
 * version is both the current draft and the reviewed one.
 */
export async function recordConfirmation(
  session: VoiceSession,
  version: number,
  utterance: string | null,
  options: { now?: number } = {},
): Promise<TransitionResult> {
  const now = options.now ?? Date.now();
  const row = await getD1()
    .prepare(
      `UPDATE voice_calls SET
         confirmed_version = reviewed_version, confirmed_at = ?, confirmed_amount_cents = reviewed_amount_cents,
         confirmation_utterance = ?, stage = 'confirmed', updated_at = ?
       WHERE id = ? AND cart_version = ? AND reviewed_version = cart_version
         AND stage IN ('review', 'confirmed') AND expires_at > ?
       RETURNING *`,
    )
    .bind(now, utterance, now, session.id, version, now)
    .first<Row>();
  return row ? { ok: true, session: toSession(row) } : refused(session.id, now);
}

/** Drops a confirmation that is too old to act on; the read-back stands and can be confirmed again. */
export async function expireConfirmation(session: VoiceSession, options: { now?: number } = {}): Promise<TransitionResult> {
  const now = options.now ?? Date.now();
  const row = await getD1()
    .prepare(
      `UPDATE voice_calls SET confirmed_version = NULL, confirmed_at = NULL, confirmed_amount_cents = NULL,
         confirmation_utterance = NULL, stage = 'review', updated_at = ?
       WHERE id = ? AND stage = 'confirmed' AND order_id IS NULL
       RETURNING *`,
    )
    .bind(now, session.id)
    .first<Row>();
  return row ? { ok: true, session: toSession(row) } : refused(session.id, now);
}

/**
 * Takes the placement lock. Requires the draft, the review and the
 * confirmation all to be `version`, and no order yet. A session already
 * `placing` may re-enter — the previous attempt may have timed out after
 * `createOrder` committed, and the idempotency key makes calling it again
 * return that same order rather than a second one.
 */
export async function beginPlacement(session: VoiceSession, version: number, options: { now?: number } = {}): Promise<TransitionResult> {
  const now = options.now ?? Date.now();
  const row = await getD1()
    .prepare(
      `UPDATE voice_calls SET stage = 'placing', placement_started_at = ?, updated_at = ?
       WHERE id = ? AND cart_version = ? AND reviewed_version = cart_version AND confirmed_version = cart_version
         AND order_id IS NULL AND stage IN ('confirmed', 'placing') AND expires_at > ?
       RETURNING *`,
    )
    .bind(now, now, session.id, version, now)
    .first<Row>();
  return row ? { ok: true, session: toSession(row) } : refused(session.id, now);
}

/** The order exists. Set once: a second order id for the same session is refused by the WHERE clause. */
export async function completePlacement(session: VoiceSession, orderId: string, options: { now?: number } = {}): Promise<TransitionResult> {
  const now = options.now ?? Date.now();
  const row = await getD1()
    .prepare(
      `UPDATE voice_calls SET stage = 'placed', order_id = ?, placed_at = COALESCE(placed_at, ?), updated_at = ?
       WHERE id = ? AND (order_id IS NULL OR order_id = ?)
       RETURNING *`,
    )
    .bind(orderId, now, now, session.id, orderId)
    .first<Row>();
  return row ? { ok: true, session: toSession(row) } : refused(session.id, now);
}

/**
 * Lets go of the placement lock after `createOrder` refused the order. The
 * review and confirmation are cleared — whatever was refused (a changed total,
 * the store closing) means the caller has to hear a new read-back and say yes
 * to it — and the draft is editable again.
 */
export async function abandonPlacement(session: VoiceSession, reason: string, options: { now?: number } = {}): Promise<TransitionResult> {
  const now = options.now ?? Date.now();
  const row = await getD1()
    .prepare(
      `UPDATE voice_calls SET
         reviewed_version = NULL, reviewed_amount_cents = NULL, reviewed_at = NULL,
         confirmed_version = NULL, confirmed_at = NULL, confirmed_amount_cents = NULL, confirmation_utterance = NULL,
         placement_started_at = NULL, failure_reason = ?, stage = ?, updated_at = ?
       WHERE id = ? AND stage = 'placing' AND order_id IS NULL
       RETURNING *`,
    )
    .bind(reason.slice(0, 200), draftStage(session), now, session.id)
    .first<Row>();
  return row ? { ok: true, session: toSession(row) } : refused(session.id, now);
}

export async function closeVoiceSession(id: string, reason: string, options: { now?: number } = {}): Promise<void> {
  const now = options.now ?? Date.now();
  await getD1()
    .prepare(
      `UPDATE voice_calls SET stage = CASE WHEN stage = 'placed' THEN 'placed' ELSE 'closed' END,
         ended_at = COALESCE(ended_at, ?), failure_reason = COALESCE(failure_reason, ?), updated_at = ?
       WHERE id = ? AND stage <> 'placing'`,
    )
    .bind(now, reason.slice(0, 200), now, id)
    .run();
}

// --- the event log --------------------------------------------------------------------

export type ToolEvent = {
  tool: string;
  request: unknown;
  response: unknown;
  ok: boolean;
  /**
   * Whether this call moves the consecutive-failure count that hands a caller
   * to staff. Defaults to `!ok`; an ordinary "that time isn't available" is not
   * a failure of the conversation.
   */
  countsAsFailure?: boolean;
  issueCodes: string[];
  latencyMs: number;
  cartVersionBefore: number | null;
  cartVersionAfter: number | null;
  /** The call was refused for bad input or a business rule (not a server fault). */
  validationFailure: boolean;
  escalationReason?: string | null;
};

/**
 * Appends one tool call to the session's log and moves its counters, in one
 * transaction. Returns the counters after the call, which is what decides
 * whether the agent is told to hand the caller over. `request` and `response`
 * must already be redacted — see lib/voice/redact.ts.
 */
export async function recordToolEvent(
  sessionId: string,
  event: ToolEvent,
  options: { now?: number } = {},
): Promise<{ toolCallCount: number; consecutiveFailureCount: number }> {
  const now = options.now ?? Date.now();
  const database = getD1();
  const [, counters] = await database.batch([
    database
      .prepare(
        `INSERT INTO voice_call_events
         (id, voice_call_id, event_type, tool, request_json, response_json, ok, issue_codes_json, latency_ms,
          cart_version_before, cart_version_after, created_at)
         VALUES (?, ?, 'tool', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        sessionId,
        event.tool,
        JSON.stringify(event.request ?? null).slice(0, 20_000),
        JSON.stringify(event.response ?? null).slice(0, 20_000),
        event.ok ? 1 : 0,
        event.issueCodes.length ? JSON.stringify(event.issueCodes) : null,
        Math.max(0, Math.round(event.latencyMs)),
        event.cartVersionBefore,
        event.cartVersionAfter,
        now,
      ),
    database
      .prepare(
        `UPDATE voice_calls SET
           tool_call_count = tool_call_count + 1,
           validation_error_count = validation_error_count + ?,
           consecutive_failure_count = CASE WHEN ? = 1 THEN 0 WHEN ? = 1 THEN consecutive_failure_count + 1 ELSE consecutive_failure_count END,
           escalation_reason = COALESCE(escalation_reason, ?),
           updated_at = ?
         WHERE id = ?
         RETURNING tool_call_count, consecutive_failure_count`,
      )
      .bind(event.validationFailure ? 1 : 0, event.ok ? 1 : 0, (event.countsAsFailure ?? !event.ok) ? 1 : 0, event.escalationReason ?? null, now, sessionId),
  ]);
  const row = (counters?.results?.[0] ?? {}) as Row;
  return { toolCallCount: Number(row.tool_call_count ?? 0), consecutiveFailureCount: Number(row.consecutive_failure_count ?? 0) };
}

/** Appends a session-level event (minted, closed) to the log. */
export async function recordSessionEvent(sessionId: string, note: string, options: { now?: number } = {}): Promise<void> {
  await getD1()
    .prepare(
      `INSERT INTO voice_call_events (id, voice_call_id, event_type, tool, request_json, response_json, ok, created_at)
       VALUES (?, ?, 'session', NULL, ?, NULL, 1, ?)`,
    )
    .bind(crypto.randomUUID(), sessionId, JSON.stringify({ note }), options.now ?? Date.now())
    .run();
}
