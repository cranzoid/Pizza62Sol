/**
 * Who is placing an order, and what that allows.
 *
 * `createOrder` used to take one `staffEntry` boolean, and that one flag
 * switched on five unrelated things at once: relaxed contact details, the
 * counter-only products, pay-at-store on a delivery (and on a pickup whatever
 * the website setting), the last-order cutoff exemption and the dropping of
 * campaign attribution. A third kind of caller — an order taken over the phone
 * by an automated receptionist — needs some of those and must not get the
 * others, so each is now its own field and a caller is described by naming all
 * of them.
 *
 * **These are trusted-server values.** A policy is chosen by the route that
 * authenticated the caller and passed to `createOrder` as its second argument,
 * which no request body can reach. The public website route passes nothing and
 * gets `WEBSITE_ORDER_POLICY`, the least-privileged preset; anything that omits
 * or garbles its policy falls back to that same preset rather than to anything
 * more generous.
 *
 * The presets below reproduce exactly what the website, the till's phone
 * orders and the till's walk-ins did before the split; that is pinned by
 * `tests/order-policy.test.ts` against outcomes recorded from the old code.
 */

/**
 * Where an order was taken. Mirrors `ORDER_CHANNELS` in db/schema.ts, which is
 * the database constraint; `tests/order-policy.test.ts` keeps the two equal.
 *
 * `ai_phone` is not `phone`: `phone` means a member of staff took the call and
 * keyed it in at the till. An order the automated receptionist took is a
 * different thing to the kitchen, to the owner's figures and to an audit.
 */
export type OrderChannel = "online" | "phone" | "walk_in" | "ai_phone";

export type PaymentMethod = "pay_at_store" | "online";

/** Who is answerable for an order being placed. */
export type OrderActorType = "customer" | "staff" | "ai_receptionist";

/**
 * How much contact detail an order must carry.
 *
 * - `full` — the website: name, phone and email, because the email is how the
 *   confirmation and tracking link reach a customer nobody has spoken to.
 * - `name_only` — the counter: a name to call out; phone and email are optional
 *   but checked when given (see `normalizeCustomer` on why a demanded email at
 *   a counter produces `x@x.com`).
 * - `name_and_phone` — a phone call taken by the AI receptionist: a name and a
 *   callback number, because nobody at the restaurant has seen this customer
 *   and the number is the only way back to them. Email is optional, as it is on
 *   a staff-taken phone order; a caller is not asked to spell one out.
 *
 * A delivery needs a phone number for the driver under every policy.
 */
export type ContactPolicy = "full" | "name_only" | "name_and_phone";

export type OrderPolicy = Readonly<{
  /** Stored on the order; drives the alert wording, the ticket and reporting. */
  channel: OrderChannel;
  actorType: OrderActorType;
  contactPolicy: ContactPolicy;
  /** May order products configured `staffOnly` (counter-only items). */
  allowStaffOnlyItems: boolean;
  /** The payment methods this caller may choose at all. */
  paymentMethods: readonly PaymentMethod[];
  /**
   * Pay-at-store on a pickup. `setting` follows the website's
   * `ordering.payAtStorePickupEnabled`; `always` is the counter deciding for
   * itself with the customer in front of it.
   */
  payAtStorePickup: "setting" | "always";
  /** Pay-at-store on a delivery, the driver collecting at the door. */
  allowPayOnDelivery: boolean;
  /**
   * Exempt from the ASAP last-order cutoff. The till decides whether the
   * kitchen can take one more; nobody else may. Opening hours, closures and
   * the schedule rules apply to everyone regardless.
   */
  bypassLastOrderCutoff: boolean;
  /** Keep the campaign attribution the browser sent. Only a browser has one. */
  recordAttribution: boolean;
  /**
   * Queue the restaurant's new-order alert. An order taken in person by staff
   * is already known to the restaurant, so it is recorded as acknowledged
   * instead of ringing the kitchen about the employee's own action.
   */
  alertRestaurant: boolean;
  /** Promo codes and gift cards may be applied. */
  allowCodes: boolean;
}>;

export type CreateOrderContext = {
  policy: OrderPolicy;
  /** The member of staff who keyed the order in, for the audit trail. */
  staffUserId?: string;
  /**
   * For an order the AI receptionist placed, the voice session that placed it.
   * Recorded on the order's creation event so the order can be traced back to
   * its call. Server-derived, like everything else in a context.
   */
  actorId?: string;
};

const BOTH_PAYMENT_METHODS: readonly PaymentMethod[] = Object.freeze(["pay_at_store", "online"]);

/** The public website, and the fallback for anything that does not name a policy. */
export const WEBSITE_ORDER_POLICY: OrderPolicy = Object.freeze({
  channel: "online",
  actorType: "customer",
  contactPolicy: "full",
  allowStaffOnlyItems: false,
  paymentMethods: BOTH_PAYMENT_METHODS,
  payAtStorePickup: "setting",
  allowPayOnDelivery: false,
  bypassLastOrderCutoff: false,
  recordAttribution: true,
  alertRestaurant: true,
  allowCodes: true,
});

const STAFF_PRIVILEGES = {
  actorType: "staff",
  contactPolicy: "name_only",
  allowStaffOnlyItems: true,
  paymentMethods: BOTH_PAYMENT_METHODS,
  payAtStorePickup: "always",
  allowPayOnDelivery: true,
  bypassLastOrderCutoff: true,
  recordAttribution: false,
  allowCodes: true,
} as const;

/** A phone order keyed in at the till. The kitchen is still alerted: whoever took the call may not be the one cooking. */
export const STAFF_PHONE_ORDER_POLICY: OrderPolicy = Object.freeze({
  ...STAFF_PRIVILEGES,
  channel: "phone",
  alertRestaurant: true,
});

/** A walk-in keyed in at the till, by staff standing in front of the order. */
export const STAFF_WALK_IN_ORDER_POLICY: OrderPolicy = Object.freeze({
  ...STAFF_PRIVILEGES,
  channel: "walk_in",
  alertRestaurant: false,
});

/**
 * An order taken over the phone by the AI receptionist.
 *
 * Not a staff context: no counter-only products, no cutoff exemption, no codes,
 * no card payments (nothing about a card is ever taken by voice). Pay-at-store
 * on a pickup follows the same website setting a stranger's order does.
 * Pay-at-the-door on a delivery is off; `aiPhoneOrderContext` can turn it on
 * only when the voice configuration explicitly allows delivery.
 */
export const AI_PHONE_ORDER_POLICY: OrderPolicy = Object.freeze({
  channel: "ai_phone",
  actorType: "ai_receptionist",
  contactPolicy: "name_and_phone",
  allowStaffOnlyItems: false,
  paymentMethods: Object.freeze(["pay_at_store"]) as readonly PaymentMethod[],
  payAtStorePickup: "setting",
  allowPayOnDelivery: false,
  bypassLastOrderCutoff: false,
  recordAttribution: false,
  alertRestaurant: true,
  allowCodes: false,
});

/** The AI preset with pay-at-the-door allowed — only for a voice config that explicitly enables delivery. */
const AI_PHONE_PAY_ON_DELIVERY_POLICY: OrderPolicy = Object.freeze({ ...AI_PHONE_ORDER_POLICY, allowPayOnDelivery: true });

export function websiteOrderContext(): CreateOrderContext {
  return { policy: WEBSITE_ORDER_POLICY };
}

/** The till's context, after the route has authenticated a member of staff. */
export function staffOrderContext(channel: "phone" | "walk_in", staffUserId?: string): CreateOrderContext {
  return {
    policy: channel === "phone" ? STAFF_PHONE_ORDER_POLICY : STAFF_WALK_IN_ORDER_POLICY,
    ...(staffUserId ? { staffUserId } : {}),
  };
}

/**
 * The AI receptionist's context, built by the voice tool service from the
 * authenticated voice session — never from anything the model sent.
 * `allowPayOnDelivery` is the voice configuration's explicit decision; it
 * defaults to off.
 */
export function aiPhoneOrderContext(options: { voiceSessionId: string; allowPayOnDelivery?: boolean }): CreateOrderContext {
  return {
    policy: options.allowPayOnDelivery ? AI_PHONE_PAY_ON_DELIVERY_POLICY : AI_PHONE_ORDER_POLICY,
    actorId: options.voiceSessionId,
  };
}

/** Every channel a policy may name; equal to `ORDER_CHANNELS` (tested). */
export const POLICY_CHANNELS: readonly OrderChannel[] = Object.freeze(["online", "phone", "walk_in", "ai_phone"]);

const CHANNELS = new Set<string>(POLICY_CHANNELS);
const CONTACT_POLICIES = new Set<string>(["full", "name_only", "name_and_phone"]);
const ACTOR_TYPES = new Set<string>(["customer", "staff", "ai_receptionist"]);

/**
 * The policy a context actually carries, or the website's when it carries
 * nothing usable.
 *
 * Every field is checked rather than trusting the shape, because the cost of a
 * malformed policy being read as permissive (`undefined` contact policy taken
 * as "not full") is a privilege nobody granted. A context that fails the check
 * gets the least-privileged preset, never a partial merge.
 */
export function resolveOrderPolicy(context: Partial<CreateOrderContext> | undefined | null): OrderPolicy {
  const policy = context?.policy as Partial<OrderPolicy> | undefined;
  if (!policy || typeof policy !== "object") return WEBSITE_ORDER_POLICY;
  const wellFormed =
    CHANNELS.has(String(policy.channel)) &&
    ACTOR_TYPES.has(String(policy.actorType)) &&
    CONTACT_POLICIES.has(String(policy.contactPolicy)) &&
    typeof policy.allowStaffOnlyItems === "boolean" &&
    Array.isArray(policy.paymentMethods) &&
    policy.paymentMethods.every((method) => method === "pay_at_store" || method === "online") &&
    (policy.payAtStorePickup === "setting" || policy.payAtStorePickup === "always") &&
    typeof policy.allowPayOnDelivery === "boolean" &&
    typeof policy.bypassLastOrderCutoff === "boolean" &&
    typeof policy.recordAttribution === "boolean" &&
    typeof policy.alertRestaurant === "boolean" &&
    typeof policy.allowCodes === "boolean";
  return wellFormed ? (policy as OrderPolicy) : WEBSITE_ORDER_POLICY;
}
