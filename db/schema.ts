/**
 * Authoritative schema. `drizzle-kit generate` turns this into the SQL applied by
 * the migration job, so this file — not a hand-written DDL string — is the single
 * source of truth (H-13, which previously required keeping two definitions in
 * manual parity).
 *
 * Two deliberate type choices keep the application code untouched by the port:
 * timestamps are `bigint` epoch-milliseconds rather than `timestamp`, and
 * booleans are `integer` 0/1 rather than `boolean`. Both preserve the contract
 * the 169 raw SQL statements already assume.
 */
import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
};

/**
 * H-14: the closed vocabularies, as database constraints rather than convention.
 *
 * The audit found IDs copied between tables with no foreign keys and no check
 * constraints, so an orphaned order item or an order sitting in a status no code
 * path can move it out of were both storable. Foreign keys are declared below on
 * every ownership edge; these lists are the other half.
 *
 * The delete rules encode who owns what. Rows that only exist as part of an order
 * (`order_items`, `payments`, `order_events`, `feedback_responses`) cascade with
 * it. Catalog rows an order *refers* to (`products`, `categories`) restrict, so a
 * product that has ever been sold cannot be deleted out from under its history —
 * the admin UI deactivates rather than deletes, so this blocks only mistakes.
 * Payroll evidence (`time_clock_events`, `timesheet_approvals`) also restricts,
 * because an employee record disappearing must not take hours worked with it.
 */
export const ORDER_STATUSES = [
  "awaiting_payment",
  "received",
  "preparing",
  "ready_for_pickup",
  "out_for_delivery",
  "completed",
  "cancelled",
] as const;

/**
 * `orders.payment_status`, which is deliberately NOT the same vocabulary as
 * `orders.status` or `payments.status`.
 *
 * The trap: an online order's *order* status is `awaiting_payment` while its
 * *payment* status is `awaiting_checkout`. They look interchangeable and are
 * not. Likewise `declined` belongs to `payments.status` only — a declined
 * Clover event leaves the order payable (the customer may retry on the same
 * session), so nothing writes `declined` here.
 *
 * Every value below has a writer: `awaiting_checkout`/`pending_at_store` at
 * creation, `paid` from the Clover webhook, `failed` when no session could be
 * created, `expired` from the reaper, `cancelled` from a staff cancel, and the
 * two refund states from the recorded-refund path.
 */
export const ORDER_PAYMENT_STATUSES = [
  "awaiting_checkout",
  "pending_at_store",
  "paid",
  "failed",
  "expired",
  "cancelled",
  "refunded",
  "partially_refunded",
] as const;

export const PAYMENT_STATUSES = [
  "pending",
  "captured",
  "declined",
  "failed",
  "expired",
  "refunded",
  "partially_refunded",
] as const;

/**
 * Where the order came from. `online` is the customer web app; `phone` and
 * `walk_in` are staff-entered at the counter. Every order carries one so the
 * owner can answer "how many were in store" without reconciling two systems.
 */
export const ORDER_CHANNELS = ["online", "phone", "walk_in"] as const;

/** The outbox vocabulary the dispatcher, the reaper and the webhook all share. */
export const OUTBOX_STATUSES = [
  "waiting_payment",
  "waiting_completion",
  "pending",
  "retrying",
  "pending_provider_setup",
  "sending",
  "sent",
  "failed",
  "cancelled",
] as const;

/** H-11b: matched by `applyPromotions`; anything else would never apply. */
export const PROMOTION_TYPES = ["percentage", "fixed", "free_delivery"] as const;

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((value) => `'${value}'`).join(", ")})`);

/** Every 0/1 integer boolean in this schema; never a real `boolean` (see header). */
const isFlag = (column: string) => sql.raw(`${column} IN (0, 1)`);

const nonNegative = (...columns: string[]) =>
  sql.raw(columns.map((column) => `${column} >= 0`).join(" AND "));

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const categories = pgTable(
  "categories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    active: integer("active").notNull().default(1),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [uniqueIndex("categories_slug_uq").on(table.slug)],
);

export const products = pgTable(
  "products",
  {
    id: text("id").primaryKey(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict", onUpdate: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description").notNull().default(""),
    productType: text("product_type").notNull(),
    imageUrl: text("image_url"),
    basePriceCents: integer("base_price_cents").notNull().default(0),
    taxable: integer("taxable").notNull().default(1),
    pickupEligible: integer("pickup_eligible").notNull().default(1),
    deliveryEligible: integer("delivery_eligible").notNull().default(1),
    halalCapable: integer("halal_capable").notNull().default(0),
    promotionEligible: integer("promotion_eligible").notNull().default(1),
    active: integer("active").notNull().default(1),
    soldOut: integer("sold_out").notNull().default(0),
    setupRequired: integer("setup_required").notNull().default(0),
    kitchenLabel: text("kitchen_label"),
    configurationJson: text("configuration_json").notNull().default("{}"),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("products_slug_uq").on(table.slug),
    index("products_category_idx").on(table.categoryId),
    index("products_active_idx").on(table.active, table.soldOut),
    check("products_price_nonneg", nonNegative("base_price_cents")),
    check(
      "products_flags",
      sql`${isFlag("taxable")} AND ${isFlag("pickup_eligible")} AND ${isFlag("delivery_eligible")}
          AND ${isFlag("halal_capable")} AND ${isFlag("promotion_eligible")} AND ${isFlag("active")}
          AND ${isFlag("sold_out")} AND ${isFlag("setup_required")}`,
    ),
  ],
);

export const productVariations = pgTable(
  "product_variations",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    basePriceCents: integer("base_price_cents").notNull(),
    extraToppingPriceCents: integer("extra_topping_price_cents").notNull().default(0),
    includedToppingUnitsBps: integer("included_topping_units_bps").notNull().default(0),
    active: integer("active").notNull().default(1),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    index("product_variations_product_idx").on(table.productId),
    check(
      "product_variations_price_nonneg",
      nonNegative("base_price_cents", "extra_topping_price_cents", "included_topping_units_bps"),
    ),
    check("product_variations_flags", isFlag("active")),
  ],
);

export const toppings = pgTable(
  "toppings",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kitchenLabel: text("kitchen_label").notNull(),
    isMeat: integer("is_meat").notNull().default(0),
    hasHalalVersion: integer("has_halal_version").notNull().default(0),
    halalDisplayName: text("halal_display_name"),
    halalAvailable: integer("halal_available").notNull().default(0),
    halalCostCents: integer("halal_cost_cents").notNull().default(0),
    active: integer("active").notNull().default(1),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    index("toppings_active_idx").on(table.active),
    check("toppings_cost_nonneg", nonNegative("halal_cost_cents")),
    check(
      "toppings_flags",
      sql`${isFlag("is_meat")} AND ${isFlag("has_halal_version")} AND ${isFlag("halal_available")} AND ${isFlag("active")}`,
    ),
  ],
);

export const promotions = pgTable(
  "promotions",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    code: text("code"),
    type: text("type").notNull(),
    amount: integer("amount").notNull().default(0),
    priority: integer("priority").notNull().default(0),
    combinable: integer("combinable").notNull().default(1),
    exclusive: integer("exclusive").notNull().default(0),
    stackGroup: text("stack_group"),
    active: integer("active").notNull().default(0),
    startsAt: bigint("starts_at", { mode: "number" }),
    endsAt: bigint("ends_at", { mode: "number" }),
    // Eligibility the owner can set without a developer. `minSubtotalCents` is
    // measured against the pre-discount menu subtotal; `fulfilment` restricts an
    // offer to pickup or delivery ("any" means both).
    minSubtotalCents: integer("min_subtotal_cents").notNull().default(0),
    fulfilment: text("fulfilment").notNull().default("any"),
    // Null means unlimited. `usageCount` is incremented in the same transaction
    // that creates the order, so the limit cannot be raced past.
    usageLimit: integer("usage_limit"),
    perCustomerLimit: integer("per_customer_limit"),
    usageCount: integer("usage_count").notNull().default(0),
    ruleJson: text("rule_json").notNull().default("{}"),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("promotions_code_uq").on(table.code),
    check("promotions_type", inList("type", PROMOTION_TYPES)),
    check("promotions_fulfilment", inList("fulfilment", ["any", "pickup", "delivery"])),
    check("promotions_amount_nonneg", nonNegative("amount", "min_subtotal_cents", "usage_count")),
    check("promotions_limits", sql`(usage_limit IS NULL OR usage_limit > 0) AND (per_customer_limit IS NULL OR per_customer_limit > 0)`),
    check("promotions_window", sql`starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at`),
    check("promotions_flags", sql`${isFlag("combinable")} AND ${isFlag("exclusive")} AND ${isFlag("active")}`),
  ],
);

export const staffUsers = pgTable(
  "staff_users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordSalt: text("password_salt").notNull(),
    passwordIterations: integer("password_iterations").notNull(),
    permissionsJson: text("permissions_json").notNull().default("[]"),
    active: integer("active").notNull().default(1),
    lastLoginAt: bigint("last_login_at", { mode: "number" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("staff_users_email_uq").on(table.email),
    check("staff_users_role", inList("role", ["owner", "manager", "employee"])),
    check("staff_users_flags", isFlag("active")),
    check("staff_users_iterations", sql`password_iterations > 0`),
  ],
);

export const staffSessions = pgTable(
  "staff_sessions",
  {
    id: text("id").primaryKey(),
    staffUserId: text("staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "cascade", onUpdate: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    revokedAt: bigint("revoked_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("staff_sessions_token_hash_uq").on(table.tokenHash),
    index("staff_sessions_user_idx").on(table.staffUserId),
  ],
);

export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    passwordHash: text("password_hash"),
    active: integer("active").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("customers_email_uq").on(table.email),
    check("customers_flags", isFlag("active")),
  ],
);

export const orderSequences = pgTable("order_sequences", {
  key: text("key").primaryKey(),
  currentNumber: integer("current_number").notNull(),
});

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),
    orderNumber: text("order_number").notNull(),
    trackingTokenHash: text("tracking_token_hash").notNull(),
    feedbackTokenHash: text("feedback_token_hash").notNull(),
    customerId: text("customer_id").references(() => customers.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    customerEmail: text("customer_email").notNull(),
    fulfilment: text("fulfilment").notNull(),
    // Where the order was taken. Defaulted rather than required so every existing
    // row — all of which came through the website — backfills correctly.
    channel: text("channel").notNull().default("online"),
    status: text("status").notNull(),
    paymentStatus: text("payment_status").notNull(),
    paymentMethod: text("payment_method").notNull(),
    scheduleType: text("schedule_type").notNull(),
    scheduledFor: bigint("scheduled_for", { mode: "number" }),
    estimatedFor: bigint("estimated_for", { mode: "number" }).notNull(),
    addressJson: text("address_json"),
    instructions: text("instructions"),
    pricingJson: text("pricing_json").notNull(),
    subtotalCents: integer("subtotal_cents").notNull(),
    discountCents: integer("discount_cents").notNull(),
    taxCents: integer("tax_cents").notNull(),
    deliveryFeeCents: integer("delivery_fee_cents").notNull(),
    tipCents: integer("tip_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    acknowledgedAt: bigint("acknowledged_at", { mode: "number" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("orders_number_uq").on(table.orderNumber),
    uniqueIndex("orders_tracking_token_hash_uq").on(table.trackingTokenHash),
    index("orders_status_idx").on(table.status, table.createdAt),
    index("orders_customer_idx").on(table.customerId),
    // History is read by created_at almost every time it is read at all — the
    // owner's date-range filter and the CSV export both scan on it.
    index("orders_created_idx").on(table.createdAt),
    index("orders_channel_idx").on(table.channel, table.createdAt),
    check("orders_status", inList("status", ORDER_STATUSES)),
    check("orders_payment_status", inList("payment_status", ORDER_PAYMENT_STATUSES)),
    check("orders_payment_method", inList("payment_method", ["online", "pay_at_store"])),
    check("orders_fulfilment", inList("fulfilment", ["pickup", "delivery"])),
    check("orders_channel", inList("channel", ORDER_CHANNELS)),
    check("orders_schedule_type", inList("schedule_type", ["asap", "scheduled"])),
    check(
      "orders_money_nonneg",
      nonNegative(
        "subtotal_cents",
        "discount_cents",
        "tax_cents",
        "delivery_fee_cents",
        "tip_cents",
        "total_cents",
      ),
    ),
    // A scheduled order with no time is unfulfillable and an ASAP order with one
    // is a contradiction the kitchen board would render wrong.
    check(
      "orders_schedule_consistent",
      sql`(schedule_type = 'scheduled' AND scheduled_for IS NOT NULL) OR (schedule_type = 'asap' AND scheduled_for IS NULL)`,
    ),
    // A delivery with no address cannot be delivered.
    check("orders_delivery_has_address", sql`fulfilment <> 'delivery' OR address_json IS NOT NULL`),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade", onUpdate: "cascade" }),
    // Restrict, not cascade: deleting a product must not silently rewrite what a
    // customer was billed for. The admin UI deactivates instead of deleting.
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict", onUpdate: "cascade" }),
    productName: text("product_name").notNull(),
    variationName: text("variation_name"),
    quantity: integer("quantity").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    lineTotalCents: integer("line_total_cents").notNull(),
    taxable: integer("taxable").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    instructions: text("instructions"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("order_items_order_idx").on(table.orderId),
    check("order_items_quantity", sql`quantity > 0`),
    check("order_items_money_nonneg", nonNegative("unit_price_cents", "line_total_cents")),
    check("order_items_flags", isFlag("taxable")),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade", onUpdate: "cascade" }),
    provider: text("provider").notNull(),
    providerReference: text("provider_reference"),
    method: text("method").notNull(),
    status: text("status").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    failureReason: text("failure_reason"),
    ...timestamps,
  },
  (table) => [
    // H-17b: scoped to live payments rather than all of them. When a checkout
    // session cannot be created the order is cancelled and the idempotency key
    // released so the customer can retry — but the payments row stays behind for
    // reconciliation, still holding that key. Under an unconditional unique
    // index that leftover row makes every retry collide, so the customer is
    // locked out of their own order permanently. Excluding failed payments frees
    // the key without discarding the audit trail.
    uniqueIndex("payments_idempotency_uq")
      .on(table.idempotencyKey)
      .where(sql`${table.status} <> 'failed'`),
    index("payments_order_idx").on(table.orderId),
    check("payments_status", inList("status", PAYMENT_STATUSES)),
    check("payments_method", inList("method", ["online", "pay_at_store"])),
    check("payments_amount_nonneg", nonNegative("amount_cents")),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade", onUpdate: "cascade" }),
    // Restrict: a refund with no payment behind it is unreconcilable.
    paymentId: text("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict", onUpdate: "cascade" }),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    internalNote: text("internal_note"),
    customerNote: text("customer_note"),
    providerReference: text("provider_reference"),
    status: text("status").notNull(),
    actorId: text("actor_id").notNull(),
    ...timestamps,
  },
  (table) => [
    index("refunds_order_idx").on(table.orderId),
    check("refunds_amount_positive", sql`amount_cents > 0`),
    // `recorded` is the only status this system can reach on its own: the money
    // moves in the Clover dashboard and is entered here afterwards. `voided`
    // exists so a mis-keyed entry can be retracted without deleting the trail.
    check("refunds_status", inList("status", ["recorded", "voided"])),
  ],
);

export const orderEvents = pgTable(
  "order_events",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade", onUpdate: "cascade" }),
    previousStatus: text("previous_status"),
    nextStatus: text("next_status").notNull(),
    actorType: text("actor_type").notNull(),
    // No foreign key: `actor_id` is a staff id only when `actor_type` is 'staff'.
    // For 'system', 'clover' and 'restaurant' it is null, and for a customer
    // cancellation it identifies the token holder, not a row in staff_users.
    actorId: text("actor_id"),
    note: text("note"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("order_events_order_idx").on(table.orderId),
    check("order_events_next_status", inList("next_status", ORDER_STATUSES)),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    previousJson: text("previous_json"),
    nextJson: text("next_json"),
    reason: text("reason"),
    requestId: text("request_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [index("audit_created_idx").on(table.createdAt)],
);

export const timeClockEvents = pgTable(
  "time_clock_events",
  {
    id: text("id").primaryKey(),
    // Restrict: hours worked are payroll evidence. Removing an employee must not
    // remove the record of what they are owed.
    staffUserId: text("staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "restrict", onUpdate: "cascade" }),
    sessionId: text("session_id").notNull(),
    action: text("action").notNull(),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
    source: text("source").notNull(),
    correctionOf: text("correction_of"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("clock_user_time_idx").on(table.staffUserId, table.occurredAt),
    uniqueIndex("clock_event_exact_uq").on(table.staffUserId, table.action, table.occurredAt),
    check("clock_events_action", inList("action", ["clock_in", "clock_out", "break_start", "break_end"])),
    check("clock_events_source", inList("source", ["self_service", "kiosk", "manager"])),
  ],
);

export const correctionRequests = pgTable(
  "correction_requests",
  {
    id: text("id").primaryKey(),
    staffUserId: text("staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "cascade", onUpdate: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => timeClockEvents.id, { onDelete: "cascade", onUpdate: "cascade" }),
    requestedTime: bigint("requested_time", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull(),
    reviewerId: text("reviewer_id").references(() => staffUsers.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    reviewerNote: text("reviewer_note"),
    ...timestamps,
  },
  (table) => [
    index("correction_status_idx").on(table.status, table.createdAt),
    // 'declined', not 'rejected' — the value the manager route actually writes.
    check("correction_status", inList("status", ["pending", "approved", "declined"])),
  ],
);

export const timeOffRequests = pgTable(
  "time_off_requests",
  {
    id: text("id").primaryKey(),
    staffUserId: text("staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "cascade", onUpdate: "cascade" }),
    startsAt: bigint("starts_at", { mode: "number" }).notNull(),
    endsAt: bigint("ends_at", { mode: "number" }).notNull(),
    partialDay: integer("partial_day").notNull().default(0),
    note: text("note"),
    status: text("status").notNull(),
    reviewerId: text("reviewer_id").references(() => staffUsers.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    reviewerNote: text("reviewer_note"),
    ...timestamps,
  },
  (table) => [
    index("time_off_status_idx").on(table.status, table.createdAt),
    check("time_off_status", inList("status", ["pending", "approved", "declined"])),
    check("time_off_window", sql`ends_at >= starts_at`),
    check("time_off_flags", isFlag("partial_day")),
  ],
);

export const feedbackQuestions = pgTable("feedback_questions", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  type: text("type").notNull(),
  ratingScale: integer("rating_scale"),
  required: integer("required").notNull().default(0),
  conditionJson: text("condition_json").notNull().default("{}"),
  active: integer("active").notNull().default(1),
  displayOrder: integer("display_order").notNull().default(0),
  ...timestamps,
});

export const feedbackResponses = pgTable(
  "feedback_responses",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade", onUpdate: "cascade" }),
    overallRating: integer("overall_rating").notNull(),
    answersJson: text("answers_json").notNull(),
    writtenFeedback: text("written_feedback"),
    reviewedAt: bigint("reviewed_at", { mode: "number" }),
    internalNote: text("internal_note"),
    submittedAt: bigint("submitted_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("feedback_order_uq").on(table.orderId),
    check("feedback_rating_range", sql`overall_rating BETWEEN 1 AND 5`),
  ],
);

export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    recipient: text("recipient"),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    scheduledFor: bigint("scheduled_for", { mode: "number" }).notNull(),
    sentAt: bigint("sent_at", { mode: "number" }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => [
    index("outbox_status_idx").on(table.status, table.scheduledFor),
    check("outbox_status", inList("status", OUTBOX_STATUSES)),
    check("outbox_attempts_nonneg", nonNegative("attempt_count")),
  ],
);

export const idempotencyKeys = pgTable("idempotency_keys", {
  keyHash: text("key_hash").primaryKey(),
  scope: text("scope").notNull(),
  resourceId: text("resource_id"),
  status: text("status").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const rateLimits = pgTable("rate_limits", {
  keyHash: text("key_hash").primaryKey(),
  windowStartedAt: bigint("window_started_at", { mode: "number" }).notNull(),
  attempts: integer("attempts").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id"),
    customerId: text("customer_id").references(() => customers.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    orderId: text("order_id").references(() => orders.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    eventName: text("event_name").notNull(),
    contextJson: text("context_json").notNull().default("{}"),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
  },
  (table) => [index("analytics_event_time_idx").on(table.eventName, table.occurredAt)],
);

// C-06: single-row-per-employee clock state used as a compare-and-swap guard so
// concurrent transitions (e.g. two simultaneous clock-ins) cannot both succeed.
export const timeClockState = pgTable(
  "time_clock_state",
  {
    staffUserId: text("staff_user_id")
      .primaryKey()
      .references(() => staffUsers.id, { onDelete: "cascade", onUpdate: "cascade" }),
    state: text("state").notNull(),
    sessionId: text("session_id"),
    transitionId: text("transition_id"),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  () => [
    check("clock_state_value", inList("state", ["clocked_out", "working", "on_break"])),
    check("clock_state_session", sql`state = 'clocked_out' OR session_id IS NOT NULL`),
  ],
);

// Time clock: pay, kiosk PIN and the work-week rules that drive overtime. Kept
// separate from staff_users so payroll data is not loaded on every auth check.
export const staffProfiles = pgTable("staff_profiles", {
  staffUserId: text("staff_user_id")
    .primaryKey()
    .references(() => staffUsers.id, { onDelete: "cascade", onUpdate: "cascade" }),
  jobTitle: text("job_title"),
  employmentType: text("employment_type").notNull().default("hourly"),
  wageCents: integer("wage_cents").notNull().default(0),
  weeklyOvertimeMinutes: integer("weekly_overtime_minutes").notNull().default(2640),
  overtimeMultiplierBps: integer("overtime_multiplier_bps").notNull().default(15000),
  weekStartsOn: integer("week_starts_on").notNull().default(0),
  pinHash: text("pin_hash"),
  pinSalt: text("pin_salt"),
  pinIterations: integer("pin_iterations"),
  availabilityJson: text("availability_json").notNull().default("[]"),
  hiredAt: bigint("hired_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// A scheduled shift. `staff_user_id` is null for an open shift nobody is assigned
// to yet; `published` keeps a draft schedule invisible to the team until released.
export const shifts = pgTable(
  "shifts",
  {
    id: text("id").primaryKey(),
    // Null is an unassigned open shift, so `set null` is the natural delete rule:
    // an employee leaving turns their future shifts back into open ones.
    staffUserId: text("staff_user_id").references(() => staffUsers.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    role: text("role"),
    startsAt: bigint("starts_at", { mode: "number" }).notNull(),
    endsAt: bigint("ends_at", { mode: "number" }).notNull(),
    unpaidBreakMinutes: integer("unpaid_break_minutes").notNull().default(0),
    notes: text("notes"),
    published: integer("published").notNull().default(0),
    publishedAt: bigint("published_at", { mode: "number" }),
    createdBy: text("created_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("shifts_starts_at_idx").on(table.startsAt),
    index("shifts_staff_idx").on(table.staffUserId, table.startsAt),
    check("shifts_window", sql`ends_at > starts_at`),
    check("shifts_break_nonneg", nonNegative("unpaid_break_minutes")),
    check("shifts_flags", isFlag("published")),
  ],
);

// One row per employee per pay period once a manager signs the timesheet off.
export const timesheetApprovals = pgTable(
  "timesheet_approvals",
  {
    id: text("id").primaryKey(),
    // Restrict, like the clock events it summarises: a signed-off timesheet is
    // the record that someone was paid a specific amount for a specific period.
    staffUserId: text("staff_user_id")
      .notNull()
      .references(() => staffUsers.id, { onDelete: "restrict", onUpdate: "cascade" }),
    periodStart: bigint("period_start", { mode: "number" }).notNull(),
    periodEnd: bigint("period_end", { mode: "number" }).notNull(),
    status: text("status").notNull().default("approved"),
    paidMs: integer("paid_ms").notNull().default(0),
    regularMs: integer("regular_ms").notNull().default(0),
    overtimeMs: integer("overtime_ms").notNull().default(0),
    grossPayCents: integer("gross_pay_cents").notNull().default(0),
    note: text("note"),
    approvedBy: text("approved_by").notNull(),
    approvedAt: bigint("approved_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("timesheet_approvals_period_idx").on(table.staffUserId, table.periodStart),
    check("timesheet_period", sql`period_end > period_start`),
    check("timesheet_amounts_nonneg", nonNegative("paid_ms", "regular_ms", "overtime_ms", "gross_pay_cents")),
  ],
);

/**
 * H-08: holidays, one-off closures, and "stop taking orders for the next hour".
 *
 * The only control that existed was an indefinite `ordering.paused` toggle,
 * which someone has to remember to turn back on — so the store either stayed
 * shut after the holiday or took orders during it. A closure is a window with an
 * end, which is the property that makes it safe to set and forget.
 *
 * Scope matters as much as the window: closing delivery when the driver is off
 * while the counter keeps selling is the common case, not the exception.
 * Enforcement lives in `createOrder` and in scheduled-time validation, so an
 * order can never be *promised* for a day the store is closed either.
 */
export const storeClosures = pgTable(
  "store_closures",
  {
    id: text("id").primaryKey(),
    // Epoch-ms window, resolved in the business time zone by the caller. A
    // whole-day holiday is midnight to midnight; a "back in an hour" pause is
    // now to now+1h. One shape covers both, so there is one code path.
    startsAt: bigint("starts_at", { mode: "number" }).notNull(),
    endsAt: bigint("ends_at", { mode: "number" }).notNull(),
    scope: text("scope").notNull().default("both"),
    reason: text("reason").notNull(),
    // Shown to customers in place of the ordering form. Null falls back to a
    // generic message, so a closure is never blocked on wording.
    customerMessage: text("customer_message"),
    createdBy: text("created_by").notNull(),
    ...timestamps,
  },
  (table) => [
    index("store_closures_window_idx").on(table.startsAt, table.endsAt),
    check("store_closures_scope", inList("scope", ["both", "pickup", "delivery"])),
    check("store_closures_window", sql`ends_at > starts_at`),
  ],
);

/**
 * Third-party credentials the owner can set without a developer or an Azure login.
 *
 * The value is AES-256-GCM ciphertext under `SETTINGS_ENCRYPTION_KEY`, which
 * lives in Key Vault and is never in the database — so a database dump alone
 * does not yield a Clover token. Reads go through `lib/integration-secrets.ts`,
 * which checks here first and falls back to the environment, so a deployment
 * that sets everything in Key Vault keeps working untouched.
 *
 * `hint` is the last four characters in clear, stored deliberately: the admin
 * screen has to be able to show *which* key is configured without being able to
 * show the key, and recomputing that would mean decrypting on every page load.
 */
export const integrationSecrets = pgTable("integration_secrets", {
  key: text("key").primaryKey(),
  cipherText: text("cipher_text").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  hint: text("hint").notNull().default(""),
  updatedBy: text("updated_by").notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
