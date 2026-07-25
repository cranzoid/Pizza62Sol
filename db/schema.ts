import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
};

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [uniqueIndex("categories_slug_uq").on(table.slug)],
);

export const products = sqliteTable(
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
    taxable: integer("taxable", { mode: "boolean" }).notNull().default(true),
    pickupEligible: integer("pickup_eligible", { mode: "boolean" }).notNull().default(true),
    deliveryEligible: integer("delivery_eligible", { mode: "boolean" }).notNull().default(true),
    halalCapable: integer("halal_capable", { mode: "boolean" }).notNull().default(false),
    promotionEligible: integer("promotion_eligible", { mode: "boolean" }).notNull().default(true),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    soldOut: integer("sold_out", { mode: "boolean" }).notNull().default(false),
    setupRequired: integer("setup_required", { mode: "boolean" }).notNull().default(false),
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

export const productVariations = sqliteTable(
  "product_variations",
  {
    id: text("id").primaryKey(),
    productId: text("product_id").notNull(),
    name: text("name").notNull(),
    basePriceCents: integer("base_price_cents").notNull(),
    extraToppingPriceCents: integer("extra_topping_price_cents").notNull().default(0),
    includedToppingUnitsBps: integer("included_topping_units_bps").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [index("product_variations_product_idx").on(table.productId)],
);

export const toppings = sqliteTable(
  "toppings",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kitchenLabel: text("kitchen_label").notNull(),
    isMeat: integer("is_meat", { mode: "boolean" }).notNull().default(false),
    hasHalalVersion: integer("has_halal_version", { mode: "boolean" }).notNull().default(false),
    halalDisplayName: text("halal_display_name"),
    halalAvailable: integer("halal_available", { mode: "boolean" }).notNull().default(false),
    halalCostCents: integer("halal_cost_cents").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [index("toppings_active_idx").on(table.active)],
);

export const promotions = sqliteTable(
  "promotions",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    code: text("code"),
    type: text("type").notNull(),
    amount: integer("amount").notNull().default(0),
    priority: integer("priority").notNull().default(0),
    combinable: integer("combinable", { mode: "boolean" }).notNull().default(true),
    exclusive: integer("exclusive", { mode: "boolean" }).notNull().default(false),
    stackGroup: text("stack_group"),
    active: integer("active", { mode: "boolean" }).notNull().default(false),
    startsAt: integer("starts_at", { mode: "timestamp_ms" }),
    endsAt: integer("ends_at", { mode: "timestamp_ms" }),
    ruleJson: text("rule_json").notNull().default("{}"),
    displayOrder: integer("display_order").notNull().default(0),
    ...timestamps,
  },
  (table) => [uniqueIndex("promotions_code_uq").on(table.code)],
);

export const staffUsers = sqliteTable(
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
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    lastLoginAt: integer("last_login_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [uniqueIndex("staff_users_email_uq").on(table.email)],
);

export const staffSessions = sqliteTable(
  "staff_sessions",
  {
    id: text("id").primaryKey(),
    staffUserId: text("staff_user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("staff_sessions_token_hash_uq").on(table.tokenHash),
    index("staff_sessions_user_idx").on(table.staffUserId),
  ],
);

export const customers = sqliteTable(
  "customers",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    passwordHash: text("password_hash"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (table) => [uniqueIndex("customers_email_uq").on(table.email)],
);

export const orderSequences = sqliteTable("order_sequences", {
  key: text("key").primaryKey(),
  currentNumber: integer("current_number").notNull(),
});

export const orders = sqliteTable(
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
    scheduledFor: integer("scheduled_for", { mode: "timestamp_ms" }),
    estimatedFor: integer("estimated_for", { mode: "timestamp_ms" }).notNull(),
    addressJson: text("address_json"),
    instructions: text("instructions"),
    pricingJson: text("pricing_json").notNull(),
    subtotalCents: integer("subtotal_cents").notNull(),
    discountCents: integer("discount_cents").notNull(),
    taxCents: integer("tax_cents").notNull(),
    deliveryFeeCents: integer("delivery_fee_cents").notNull(),
    tipCents: integer("tip_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    acknowledgedAt: integer("acknowledged_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("orders_number_uq").on(table.orderNumber),
    uniqueIndex("orders_tracking_token_hash_uq").on(table.trackingTokenHash),
    index("orders_status_idx").on(table.status, table.createdAt),
    index("orders_customer_idx").on(table.customerId),
  ],
);

export const orderItems = sqliteTable(
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
    taxable: integer("taxable", { mode: "boolean" }).notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    instructions: text("instructions"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("order_items_order_idx").on(table.orderId)],
);

export const payments = sqliteTable(
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

export const refunds = sqliteTable(
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

export const orderEvents = sqliteTable(
  "order_events",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    previousStatus: text("previous_status"),
    nextStatus: text("next_status").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("order_events_order_idx").on(table.orderId)],
);

export const auditLog = sqliteTable(
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
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("audit_created_idx").on(table.createdAt)],
);

export const timeClockEvents = sqliteTable(
  "time_clock_events",
  {
    id: text("id").primaryKey(),
    staffUserId: text("staff_user_id").notNull(),
    sessionId: text("session_id").notNull(),
    action: text("action").notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    source: text("source").notNull(),
    correctionOf: text("correction_of"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("clock_user_time_idx").on(table.staffUserId, table.occurredAt)],
);

export const correctionRequests = sqliteTable(
  "correction_requests",
  {
    id: text("id").primaryKey(),
    staffUserId: text("staff_user_id").notNull(),
    eventId: text("event_id").notNull(),
    requestedTime: integer("requested_time", { mode: "timestamp_ms" }).notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull(),
    reviewerId: text("reviewer_id"),
    reviewerNote: text("reviewer_note"),
    ...timestamps,
  },
  (table) => [index("correction_status_idx").on(table.status, table.createdAt)],
);

export const timeOffRequests = sqliteTable(
  "time_off_requests",
  {
    id: text("id").primaryKey(),
    staffUserId: text("staff_user_id").notNull(),
    startsAt: integer("starts_at", { mode: "timestamp_ms" }).notNull(),
    endsAt: integer("ends_at", { mode: "timestamp_ms" }).notNull(),
    partialDay: integer("partial_day", { mode: "boolean" }).notNull().default(false),
    note: text("note"),
    status: text("status").notNull(),
    reviewerId: text("reviewer_id"),
    reviewerNote: text("reviewer_note"),
    ...timestamps,
  },
  (table) => [index("time_off_status_idx").on(table.status, table.createdAt)],
);

export const feedbackQuestions = sqliteTable("feedback_questions", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  type: text("type").notNull(),
  ratingScale: integer("rating_scale"),
  required: integer("required", { mode: "boolean" }).notNull().default(false),
  conditionJson: text("condition_json").notNull().default("{}"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  displayOrder: integer("display_order").notNull().default(0),
  ...timestamps,
});

export const feedbackResponses = sqliteTable(
  "feedback_responses",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").notNull(),
    overallRating: integer("overall_rating").notNull(),
    answersJson: text("answers_json").notNull(),
    writtenFeedback: text("written_feedback"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    internalNote: text("internal_note"),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("feedback_order_uq").on(table.orderId)],
);

export const notificationOutbox = sqliteTable(
  "notification_outbox",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    recipient: text("recipient"),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    scheduledFor: integer("scheduled_for", { mode: "timestamp_ms" }).notNull(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => [index("outbox_status_idx").on(table.status, table.scheduledFor)],
);

export const idempotencyKeys = sqliteTable("idempotency_keys", {
  keyHash: text("key_hash").primaryKey(),
  scope: text("scope").notNull(),
  resourceId: text("resource_id"),
  status: text("status").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const rateLimits = sqliteTable("rate_limits", {
  keyHash: text("key_hash").primaryKey(),
  windowStartedAt: integer("window_started_at", { mode: "timestamp_ms" }).notNull(),
  attempts: integer("attempts").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const analyticsEvents = sqliteTable(
  "analytics_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id"),
    customerId: text("customer_id"),
    orderId: text("order_id"),
    eventName: text("event_name").notNull(),
    contextJson: text("context_json").notNull().default("{}"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("analytics_event_time_idx").on(table.eventName, table.occurredAt)],
);

// C-06: single-row-per-employee clock state used as a compare-and-swap guard so
// concurrent transitions (e.g. two simultaneous clock-ins) cannot both succeed.
export const timeClockState = sqliteTable("time_clock_state", {
  staffUserId: text("staff_user_id").primaryKey(),
  state: text("state").notNull(),
  sessionId: text("session_id"),
  // C-06: identifies the transition that last won the compare-and-swap, so the
  // matching clock event is inserted in the same batch only by the winning request.
  transitionId: text("transition_id"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
