import { env } from "@/lib/runtime-env";
import { authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1, listSettings, safeJson } from "@/db/runtime";
import { cloverCheckoutConfigured, cloverWebhookConfigured } from "@/lib/clover";

// Start of the current day in America/Toronto, returned as an epoch-ms timestamp.
function torontoStartOfDay(nowMs: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const elapsedTodayMs = (get("hour") * 3600 + get("minute") * 60 + get("second")) * 1000;
  return nowMs - elapsedTodayMs;
}

export async function GET(request: Request) {
  try {
    const user = await requireStaff(request, "view_orders");
    await ensureDatabase();
    // H-19: report settled "today" revenue on the Toronto business calendar, not a
    // rolling 24 hours, and exclude orders that have not actually been paid.
    const dayStart = torontoStartOfDay(Date.now());
    const canManageEmployees = user.role === "owner" || user.permissions.includes("manage_employees");
    // C-03: customer contact (phone/email) is a distinct permission from viewing orders.
    const canViewContact = user.role === "owner" || user.permissions.includes("view_customer_contact");
    const [orders, awaitingPayment, today, availability, clocked, feedback, settings, products, toppings, categories, variations, staff, promotions] = await Promise.all([
      getD1()
        .prepare(
          `SELECT id, order_number, customer_name, customer_phone, customer_email, fulfilment, status,
                  payment_status, payment_method, schedule_type, scheduled_for, estimated_for,
                  address_json, instructions, subtotal_cents, discount_cents, tax_cents,
                  delivery_fee_cents, tip_cents, total_cents, created_at, acknowledged_at
           FROM orders WHERE status IN ('received', 'preparing', 'ready_for_pickup', 'out_for_delivery')
           ORDER BY created_at DESC LIMIT 60`,
        )
        .all<Record<string, unknown>>(),
      // H-20a: orders that started a checkout and never came back. They were in
      // no list at all - not the live queue above, and not reachable from
      // history, whose filter offered no such status - so a customer whose
      // payment succeeded but whose webhook was lost simply vanished. Nobody
      // could see the order to rescue it.
      //
      // Kept as its own queue rather than merged into the live one: these are
      // not confirmed orders and the kitchen must not start cooking them.
      getD1()
        .prepare(
          `SELECT id, order_number, customer_name, customer_phone, customer_email, fulfilment,
                  status, payment_status, payment_method, total_cents, created_at
           FROM orders WHERE status = 'awaiting_payment'
           ORDER BY created_at DESC LIMIT 30`,
        )
        .all<Record<string, unknown>>(),
      getD1()
        .prepare(
          `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_cents), 0) AS sales_cents,
                  COALESCE(AVG(total_cents), 0) AS average_cents
           FROM orders WHERE created_at >= ? AND status != 'cancelled'
             AND (payment_method = 'pay_at_store' OR payment_status = 'paid')`,
        )
        .bind(dayStart)
        .first(),
      getD1()
        .prepare("SELECT COUNT(*) AS count FROM products WHERE active = 1 AND (sold_out = 1 OR setup_required = 1)")
        .first(),
      getD1()
        .prepare(
          `SELECT u.id, u.name, e.action, e.occurred_at
           FROM staff_users u JOIN time_clock_events e ON e.staff_user_id = u.id
           WHERE e.occurred_at = (SELECT MAX(e2.occurred_at) FROM time_clock_events e2 WHERE e2.staff_user_id = u.id)
           AND e.action != 'clock_out'`,
        )
        .all(),
      getD1()
        .prepare(
          `SELECT f.id, f.overall_rating, f.written_feedback, f.submitted_at, o.order_number
           FROM feedback_responses f JOIN orders o ON o.id = f.order_id
           WHERE f.overall_rating <= 2 AND f.reviewed_at IS NULL ORDER BY f.submitted_at DESC LIMIT 8`,
        )
        .all(),
      listSettings(),
      getD1()
        .prepare(
          `SELECT id, category_id, name, description, product_type, image_url, base_price_cents,
                  active, sold_out, pickup_eligible, delivery_eligible, taxable, halal_capable,
                  setup_required, kitchen_label, configuration_json, display_order
           FROM products ORDER BY display_order, name`,
        )
        .all(),
      getD1()
        .prepare(
          `SELECT id, name, kitchen_label, is_meat, has_halal_version, halal_available, active
           FROM toppings ORDER BY display_order, name`,
        )
        .all(),
      getD1()
        .prepare("SELECT id, name, slug, description, active, display_order FROM categories ORDER BY display_order, name")
        .all(),
      getD1()
        .prepare("SELECT id, product_id, name, base_price_cents, extra_topping_price_cents, included_topping_units_bps, active, display_order FROM product_variations ORDER BY product_id, display_order, name")
        .all(),
      canManageEmployees
        ? getD1().prepare("SELECT id, email, name, role, permissions_json, active, last_login_at, created_at FROM staff_users ORDER BY active DESC, name").all<Record<string, unknown>>()
        : Promise.resolve({ results: [], success: true, meta: { changes: 0 } }),
      getD1()
        .prepare("SELECT id, name, code, type, amount, priority, combinable, exclusive, active, rule_json, display_order FROM promotions ORDER BY display_order, name")
        .all(),
    ]);
    // C-05: kitchen cards must show what to make. Load the immutable item snapshots
    // for every visible order and attach them, along with delivery address and
    // payment state. Contact fields are gated by view_customer_contact (C-03).
    const orderIds = orders.results.map((order) => String(order.id));
    const items = orderIds.length
      ? await getD1()
          .prepare(
            `SELECT id, order_id, product_name, variation_name, quantity, unit_price_cents,
                    line_total_cents, snapshot_json, instructions
             FROM order_items WHERE order_id IN (${orderIds.map(() => "?").join(",")})
             ORDER BY created_at`,
          )
          .bind(...orderIds)
          .all<Record<string, unknown>>()
      : { results: [] as Record<string, unknown>[] };
    const itemsByOrder = new Map<string, Array<Record<string, unknown>>>();
    for (const item of items.results) {
      const key = String(item.order_id);
      const list = itemsByOrder.get(key) ?? [];
      list.push({
        id: item.id,
        productName: item.product_name,
        variationName: item.variation_name,
        quantity: item.quantity,
        unitPriceCents: item.unit_price_cents,
        lineTotalCents: item.line_total_cents,
        instructions: item.instructions,
        snapshot: safeJson(String(item.snapshot_json ?? "{}"), {}),
      });
      itemsByOrder.set(key, list);
    }
    const serializedOrders = orders.results.map((order) => ({
      ...order,
      customer_phone: canViewContact ? order.customer_phone : undefined,
      customer_email: canViewContact ? order.customer_email : undefined,
      contactRedacted: !canViewContact,
      address: safeJson(String(order.address_json ?? "null"), null),
      address_json: undefined,
      items: itemsByOrder.get(String(order.id)) ?? [],
    }));
    return Response.json({
      user,
      orders: serializedOrders,
      // Same contact-permission rule as the live queue (C-03).
      awaitingPayment: awaitingPayment.results.map((order) => ({
        ...order,
        customer_phone: canViewContact ? order.customer_phone : undefined,
        customer_email: canViewContact ? order.customer_email : undefined,
        contactRedacted: !canViewContact,
      })),
      metrics: today,
      availabilityWarnings: availability,
      clockedIn: clocked.results,
      lowRatings: feedback.results,
      settings,
      products: products.results.map((product) => ({
        ...product,
        configuration: safeJson(String((product as Record<string, unknown>).configuration_json ?? "{}"), {}),
        configuration_json: undefined,
      })),
      toppings: toppings.results,
      categories: categories.results,
      variations: variations.results,
      staff: staff.results.map((member) => ({
        ...member,
        permissions: safeJson(String(member.permissions_json ?? "[]"), []),
        permissions_json: undefined,
      })),
      promotions: promotions.results.map((promotion) => ({
        ...promotion,
        rule: safeJson(String((promotion as Record<string, unknown>).rule_json ?? "{}"), {}),
        rule_json: undefined,
      })),
      integrations: {
        cloverCheckout: cloverCheckoutConfigured(),
        cloverWebhook: cloverWebhookConfigured(),
        emailApiKey: Boolean((env as unknown as Record<string, string | undefined>).EMAIL_API_KEY),
        emailProvider: (env as unknown as Record<string, string | undefined>).EMAIL_PROVIDER ?? null,
      },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
