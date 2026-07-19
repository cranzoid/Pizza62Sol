import { env } from "cloudflare:workers";
import { authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1, listSettings } from "@/db/runtime";

export async function GET(request: Request) {
  try {
    const user = await requireStaff(request, "view_orders");
    await ensureDatabase();
    const dayStart = Date.now() - 24 * 60 * 60 * 1000;
    const [orders, today, availability, clocked, feedback, settings, products, toppings] = await Promise.all([
      getD1()
        .prepare(
          `SELECT id, order_number, customer_name, customer_phone, fulfilment, status, payment_status,
                  schedule_type, scheduled_for, estimated_for, total_cents, created_at, acknowledged_at
           FROM orders WHERE status IN ('received', 'preparing', 'ready_for_pickup', 'out_for_delivery')
           ORDER BY created_at DESC LIMIT 60`,
        )
        .all<Record<string, unknown>>(),
      getD1()
        .prepare(
          `SELECT COUNT(*) AS order_count, COALESCE(SUM(total_cents), 0) AS sales_cents,
                  COALESCE(AVG(total_cents), 0) AS average_cents
           FROM orders WHERE created_at >= ? AND status != 'cancelled'`,
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
          `SELECT id, category_id, name, description, base_price_cents, active, sold_out,
                  pickup_eligible, delivery_eligible, taxable
           FROM products WHERE active = 1 ORDER BY display_order, name`,
        )
        .all(),
      getD1()
        .prepare(
          `SELECT id, name, kitchen_label, is_meat, has_halal_version, halal_available, active
           FROM toppings ORDER BY display_order, name`,
        )
        .all(),
    ]);
    return Response.json({
      user,
      orders: orders.results,
      metrics: today,
      availabilityWarnings: availability,
      clockedIn: clocked.results,
      lowRatings: feedback.results,
      settings,
      products: products.results,
      toppings: toppings.results,
      integrations: {
        stripeSecret: Boolean((env as unknown as Record<string, string | undefined>).STRIPE_SECRET_KEY),
        stripeWebhook: Boolean((env as unknown as Record<string, string | undefined>).STRIPE_WEBHOOK_SECRET),
        emailApiKey: Boolean((env as unknown as Record<string, string | undefined>).EMAIL_API_KEY),
        emailProvider: (env as unknown as Record<string, string | undefined>).EMAIL_PROVIDER ?? null,
      },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
