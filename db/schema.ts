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
import { bigint, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
};

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
    categoryId: text("category_id").notNull(),
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
  ],
);

export const productVariations = pgTable(
  "product_variations",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    name: text("name").notNull(),
    basePriceCents: integer("base_price_cents").notNull(),
    extraToppingPriceCents: integer("extra_topping_price_cents").notNull().default(0),
    includedToppingUnitsBps: integer("included_topping_units_bps").notNull().default(0),
    active: integer("active").notNull().default(1),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [index("product_variations_product_idx").on(table.productId)],
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
  (table) => [index("toppings_active_idx").on(table.active)],
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
    ruleJson: text("rule_json").notNull().default("{}"),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [uniqueIndex("promotions_code_uq").on(table.code)],
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
  (table) => [uniqueIndex("staff_users_email_uq").on(table.email)],
);

export const staffSessions = pgTable(
  "staff_sessions",
  {
    id: text("id").primaryKey(),
    staffUserId: text("staff_user_id").notNull(),
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
  (table) => [uniqueIndex("customers_email_uq").on(table.email)],
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
    customerId: text("customer_id"),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    customerEmail: text("customer_email").notNull(),
    fulfilment: text("fulfilment").notNull(),
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
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    productId: text("product_id").notNull(),
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
  (table) => [index("order_items_order_idx").on(table.orderId)],
);

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
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
    uniqueIndex("payments_idempotency_uq").on(table.idempotencyKey),
    index("payments_order_idx").on(table.orderId),
  ],
);

export const refunds = pgTable(
  "refunds",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    paymentId: text("payment_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    reason: text("reason").notNull(),
    internalNote: text("internal_note"),
    customerNote: text("customer_note"),
    providerReference: text("provider_reference"),
    status: text("status").notNull(),
    actorId: text("actor_id").notNull(),
    ...timestamps,
  },
  (table) => [index("refunds_order_idx").on(table.orderId)],
);

export const orderEvents = pgTable(
  "order_events",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    previousStatus: text("previous_status"),
    nextStatus: text("next_status").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    note: text("note"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [index("order_events_order_idx").on(table.orderId)],
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
    staffUserId: text("staff_user_id").notNull(),
    sessionId: text("session_id").notNull(),
    action: text("action").notNull(),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
    source: text("source").notNull(),
    correctionOf: text("correction_of"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [index("clock_user_time_idx").on(table.staffUserId, table.occurredAt)],
);

export const correctionRequests = pgTable(
  "correction_requests",
  {
    id: text("id").primaryKey(),
    staffUserId: text("staff_user_id").notNull(),
    eventId: text("event_id").notNull(),
    requestedTime: bigint("requested_time", { mode: "number" }).notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull(),
    reviewerId: text("reviewer_id"),
    reviewerNote: text("reviewer_note"),
    ...timestamps,
  },
  (table) => [index("correction_status_idx").on(table.status, table.createdAt)],
);

export const timeOffRequests = pgTable(
  "time_off_requests",
  {
    id: text("id").primaryKey(),
    staffUserId: text("staff_user_id").notNull(),
    startsAt: bigint("starts_at", { mode: "number" }).notNull(),
    endsAt: bigint("ends_at", { mode: "number" }).notNull(),
    partialDay: integer("partial_day").notNull().default(0),
    note: text("note"),
    status: text("status").notNull(),
    reviewerId: text("reviewer_id"),
    reviewerNote: text("reviewer_note"),
    ...timestamps,
  },
  (table) => [index("time_off_status_idx").on(table.status, table.createdAt)],
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
    orderId: text("order_id").notNull(),
    overallRating: integer("overall_rating").notNull(),
    answersJson: text("answers_json").notNull(),
    writtenFeedback: text("written_feedback"),
    reviewedAt: bigint("reviewed_at", { mode: "number" }),
    internalNote: text("internal_note"),
    submittedAt: bigint("submitted_at", { mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("feedback_order_uq").on(table.orderId)],
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
  (table) => [index("outbox_status_idx").on(table.status, table.scheduledFor)],
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
    customerId: text("customer_id"),
    orderId: text("order_id"),
    eventName: text("event_name").notNull(),
    contextJson: text("context_json").notNull().default("{}"),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
  },
  (table) => [index("analytics_event_time_idx").on(table.eventName, table.occurredAt)],
);

// C-06: single-row-per-employee clock state used as a compare-and-swap guard so
// concurrent transitions (e.g. two simultaneous clock-ins) cannot both succeed.
export const timeClockState = pgTable("time_clock_state", {
  staffUserId: text("staff_user_id").primaryKey(),
  state: text("state").notNull(),
  sessionId: text("session_id"),
  // C-06: identifies the transition that last won the compare-and-swap, so the
  // matching clock event is inserted in the same batch only by the winning request.
  transitionId: text("transition_id"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

// Time clock: pay, kiosk PIN and the work-week rules that drive overtime. Kept
// separate from staff_users so payroll data is not loaded on every auth check.
export const staffProfiles = pgTable("staff_profiles", {
  staffUserId: text("staff_user_id").primaryKey(),
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
    staffUserId: text("staff_user_id"),
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
  ],
);

// One row per employee per pay period once a manager signs the timesheet off.
export const timesheetApprovals = pgTable(
  "timesheet_approvals",
  {
    id: text("id").primaryKey(),
    staffUserId: text("staff_user_id").notNull(),
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
  (table) => [uniqueIndex("timesheet_approvals_period_idx").on(table.staffUserId, table.periodStart)],
);
