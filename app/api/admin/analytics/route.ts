import { authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1 } from "@/db/runtime";
import { zonedParts } from "@/lib/domain";

const MAX_DAYS = 180;
const TIME_ZONE = "America/Toronto";

/** Local calendar day for a timestamp, e.g. "2026-07-27" in the restaurant's zone. */
function localDay(timestamp: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(timestamp));
}

function emptyDays(from: number, days: number): Map<string, { orders: number; salesCents: number }> {
  const buckets = new Map<string, { orders: number; salesCents: number }>();
  for (let index = 0; index < days; index += 1) {
    buckets.set(localDay(from + index * 86_400_000), { orders: 0, salesCents: 0 });
  }
  return buckets;
}

export async function GET(request: Request) {
  try {
    const user = await requireStaff(request, "view_analytics");
    await ensureDatabase();
    const url = new URL(request.url);
    const days = Math.min(MAX_DAYS, Math.max(1, Number(url.searchParams.get("days") ?? 30) || 30));
    const now = Date.now();
    const from = now - (days - 1) * 86_400_000;
    // The window starts at midnight of the first local day so day buckets are whole.
    const start = from - zonedParts(from, TIME_ZONE).minute * 60_000;
    const previousStart = start - days * 86_400_000;
    const paidFilter = "status != 'cancelled' AND (payment_method = 'pay_at_store' OR payment_status = 'paid')";
    const database = getD1();
    const [orderRows, totals, previousTotals, fulfilment, payment, schedule, statuses, topProducts, events, ratings, customers] =
      await Promise.all([
        database
          .prepare(`SELECT created_at, total_cents FROM orders WHERE created_at >= ? AND ${paidFilter} ORDER BY created_at`)
          .bind(start)
          .all<{ created_at: number; total_cents: number }>(),
        database
          .prepare(
            `SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales_cents,
                    COALESCE(AVG(total_cents), 0) AS average_cents,
                    COALESCE(SUM(tip_cents), 0) AS tip_cents,
                    COALESCE(SUM(discount_cents), 0) AS discount_cents,
                    COALESCE(SUM(delivery_fee_cents), 0) AS delivery_cents,
                    COALESCE(SUM(tax_cents), 0) AS tax_cents
             FROM orders WHERE created_at >= ? AND ${paidFilter}`,
          )
          .bind(start)
          .first<Record<string, number>>(),
        database
          .prepare(
            `SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales_cents
             FROM orders WHERE created_at >= ? AND created_at < ? AND ${paidFilter}`,
          )
          .bind(previousStart, start)
          .first<Record<string, number>>(),
        database
          .prepare(
            `SELECT fulfilment, COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS sales_cents
             FROM orders WHERE created_at >= ? AND ${paidFilter} GROUP BY fulfilment`,
          )
          .bind(start)
          .all<Record<string, unknown>>(),
        database
          .prepare(
            `SELECT payment_method, COUNT(*) AS orders FROM orders
             WHERE created_at >= ? AND ${paidFilter} GROUP BY payment_method`,
          )
          .bind(start)
          .all<Record<string, unknown>>(),
        database
          .prepare(
            `SELECT schedule_type, COUNT(*) AS orders FROM orders
             WHERE created_at >= ? AND ${paidFilter} GROUP BY schedule_type`,
          )
          .bind(start)
          .all<Record<string, unknown>>(),
        database
          .prepare("SELECT status, COUNT(*) AS orders FROM orders WHERE created_at >= ? GROUP BY status")
          .bind(start)
          .all<Record<string, unknown>>(),
        database
          .prepare(
            `SELECT i.product_name AS name, SUM(i.quantity) AS quantity,
                    COALESCE(SUM(i.line_total_cents), 0) AS sales_cents
             FROM order_items i JOIN orders o ON o.id = i.order_id
             WHERE o.created_at >= ? AND o.status != 'cancelled'
             GROUP BY i.product_name ORDER BY quantity DESC LIMIT 12`,
          )
          .bind(start)
          .all<Record<string, unknown>>(),
        database
          .prepare(
            `SELECT event_name, COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
             FROM analytics_events WHERE occurred_at >= ? GROUP BY event_name`,
          )
          .bind(start)
          .all<Record<string, unknown>>(),
        database
          .prepare(
            `SELECT overall_rating AS rating, COUNT(*) AS responses FROM feedback_responses
             WHERE submitted_at >= ? GROUP BY overall_rating ORDER BY overall_rating`,
          )
          .bind(start)
          .all<Record<string, unknown>>(),
        database
          .prepare(
            `SELECT COUNT(*) AS customers, COALESCE(SUM(CASE WHEN orders > 1 THEN 1 ELSE 0 END), 0) AS repeat_customers
             FROM (SELECT customer_email, COUNT(*) AS orders FROM orders
                   WHERE created_at >= ? AND ${paidFilter} GROUP BY customer_email)`,
          )
          .bind(start)
          .first<Record<string, number>>(),
      ]);

    // Day, hour and weekday buckets are built here rather than in SQL so daylight
    // saving cannot shift an order into the wrong local day.
    const daily = emptyDays(start, days);
    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, salesCents: 0 }));
    const weekday = Array.from({ length: 7 }, (_, index) => ({ weekday: index, orders: 0, salesCents: 0 }));
    for (const order of orderRows.results) {
      const bucket = daily.get(localDay(order.created_at));
      if (bucket) {
        bucket.orders += 1;
        bucket.salesCents += order.total_cents;
      }
      const local = zonedParts(order.created_at, TIME_ZONE);
      const hour = Math.floor(local.minute / 60);
      hourly[hour].orders += 1;
      hourly[hour].salesCents += order.total_cents;
      weekday[local.weekday].orders += 1;
      weekday[local.weekday].salesCents += order.total_cents;
    }

    const eventCounts = new Map(events.results.map((row) => [String(row.event_name), Number(row.sessions ?? 0)]));
    const visits = eventCounts.get("website_visit") ?? 0;
    const funnel = [
      { step: "Visited the site", sessions: visits },
      { step: "Opened an item", sessions: eventCounts.get("product_viewed") ?? 0 },
      { step: "Added to the bag", sessions: eventCounts.get("add_to_cart") ?? 0 },
      { step: "Started checkout", sessions: eventCounts.get("checkout_started") ?? 0 },
      { step: "Completed the order", sessions: eventCounts.get("purchase_completed") ?? 0 },
    ];
    const ratingRows = ratings.results.map((row) => ({ rating: Number(row.rating), responses: Number(row.responses) }));
    const ratingCount = ratingRows.reduce((sum, row) => sum + row.responses, 0);

    return Response.json({
      user: { id: user.id, role: user.role },
      range: { days, start, end: now, timeZone: TIME_ZONE },
      totals: {
        orders: Number(totals?.orders ?? 0),
        salesCents: Number(totals?.sales_cents ?? 0),
        averageCents: Math.round(Number(totals?.average_cents ?? 0)),
        tipCents: Number(totals?.tip_cents ?? 0),
        discountCents: Number(totals?.discount_cents ?? 0),
        deliveryCents: Number(totals?.delivery_cents ?? 0),
        taxCents: Number(totals?.tax_cents ?? 0),
      },
      previous: { orders: Number(previousTotals?.orders ?? 0), salesCents: Number(previousTotals?.sales_cents ?? 0) },
      daily: [...daily.entries()].map(([date, value]) => ({ date, ...value })),
      hourly,
      weekday,
      fulfilment: fulfilment.results.map((row) => ({ fulfilment: String(row.fulfilment), orders: Number(row.orders), salesCents: Number(row.sales_cents) })),
      payment: payment.results.map((row) => ({ method: String(row.payment_method), orders: Number(row.orders) })),
      schedule: schedule.results.map((row) => ({ type: String(row.schedule_type), orders: Number(row.orders) })),
      statuses: statuses.results.map((row) => ({ status: String(row.status), orders: Number(row.orders) })),
      topProducts: topProducts.results.map((row) => ({ name: String(row.name), quantity: Number(row.quantity), salesCents: Number(row.sales_cents) })),
      funnel,
      conversionBps: visits ? Math.round(((eventCounts.get("purchase_completed") ?? 0) / visits) * 10_000) : 0,
      ratings: {
        count: ratingCount,
        average: ratingCount ? ratingRows.reduce((sum, row) => sum + row.rating * row.responses, 0) / ratingCount : 0,
        distribution: [1, 2, 3, 4, 5].map((rating) => ({
          rating,
          responses: ratingRows.find((row) => row.rating === rating)?.responses ?? 0,
        })),
      },
      customers: { total: Number(customers?.customers ?? 0), returning: Number(customers?.repeat_customers ?? 0) },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
