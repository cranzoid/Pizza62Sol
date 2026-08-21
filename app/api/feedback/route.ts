import { ensureDatabase, getD1, getSetting, safeJson } from "@/db/runtime";
import { hashOpaqueToken } from "@/lib/domain";
import { enforceRateLimit, RateLimitError } from "@/lib/security";

async function findOrder(orderNumber: string, token: string) {
  return getD1()
    .prepare(
      `SELECT id, order_number, fulfilment, status, customer_name, customer_email, customer_phone
       FROM orders WHERE order_number = ? AND feedback_token_hash = ?`,
    )
    .bind(orderNumber.trim().toUpperCase(), await hashOpaqueToken(token))
    .first<Record<string, unknown>>();
}

export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, "feedback-read", 20, 15 * 60 * 1000);
    await ensureDatabase();
    const url = new URL(request.url);
    const orderNumber = url.searchParams.get("order") ?? "";
    // H-15: same as tracking — the app sends the token in a header so it never
    // reaches an access log; the query parameter is the no-JavaScript fallback.
    const token = request.headers.get("x-tracking-token")?.trim() || url.searchParams.get("token") || "";
    const order = token.length >= 32 ? await findOrder(orderNumber, token) : null;
    if (!order || order.status === "cancelled") {
      return Response.json({ error: "Feedback link is invalid or unavailable." }, { status: 404 });
    }
    const existing = await getD1()
      .prepare("SELECT submitted_at FROM feedback_responses WHERE order_id = ?")
      .bind(order.id)
      .first();
    const itemTypes = await getD1()
      .prepare(
        `SELECT p.product_type FROM order_items i JOIN products p ON p.id = i.product_id
         WHERE i.order_id = ?`,
      )
      .bind(order.id)
      .all<{ product_type: string }>();
    const types = new Set(itemTypes.results.map((row) => row.product_type));
    const questions = await getD1()
      .prepare(
        `SELECT id, label, type, rating_scale, required, condition_json
         FROM feedback_questions WHERE active = 1 ORDER BY display_order, id`,
      )
      .all<Record<string, unknown>>();
    const business = await getSetting<{ googleReviewUrl: string | null }>("business");
    return Response.json({
      order: { orderNumber: order.order_number, fulfilment: order.fulfilment },
      alreadySubmitted: Boolean(existing),
      googleReviewUrl: business.googleReviewUrl,
      questions: questions.results
        .filter((question) => {
          const condition = safeJson<{ includesProductType?: string }>(question.condition_json as string, {});
          return !condition.includesProductType || types.has(condition.includesProductType);
        })
        .map((question) => ({
          id: question.id,
          label:
            question.id === "speed"
              ? order.fulfilment === "pickup"
                ? "Pickup speed"
                : "Delivery speed"
              : question.label,
          type: question.type,
          ratingScale: question.rating_scale,
          required: Boolean(question.required),
        })),
    });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Feedback is temporarily unavailable." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "feedback-submit", 8, 60 * 60 * 1000);
    await ensureDatabase();
    const body = (await request.json()) as {
      orderNumber?: string;
      token?: string;
      answers?: Record<string, number | string>;
      writtenFeedback?: string;
    };
    const order =
      body.token && body.token.length >= 32
        ? await findOrder(body.orderNumber ?? "", body.token)
        : null;
    if (!order || order.status === "cancelled") {
      return Response.json({ error: "Feedback link is invalid or unavailable." }, { status: 404 });
    }
    const overall = Number(body.answers?.overall);
    if (!Number.isInteger(overall) || overall < 1 || overall > 5) {
      return Response.json({ error: "An overall rating from 1 to 5 is required." }, { status: 400 });
    }
    const written = body.writtenFeedback?.trim() ?? "";
    if (written.length > 2000) {
      return Response.json({ error: "Written feedback must be 2,000 characters or fewer." }, { status: 400 });
    }
    const now = Date.now();
    const result = await getD1()
      .prepare(
        `INSERT INTO feedback_responses
         (id, order_id, overall_rating, answers_json, written_feedback, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(order_id) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        order.id,
        overall,
        JSON.stringify(body.answers ?? {}),
        written || null,
        now,
      )
      .run();
    if (!result.meta.changes) {
      return Response.json({ error: "Feedback has already been submitted for this order." }, { status: 409 });
    }
    const operations = await getSetting<{ lowRatingThreshold: number }>("operations");
    if (overall <= operations.lowRatingThreshold) {
      await getD1()
        .prepare(
          `INSERT INTO notification_outbox
           (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
           VALUES (?, 'low_rating_alert', NULL, ?, 'pending_provider_setup', 0, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          JSON.stringify({
            orderId: order.id,
            orderNumber: order.order_number,
            overall,
            writtenFeedback: written,
            customerName: order.customer_name,
            customerEmail: order.customer_email,
            customerPhone: order.customer_phone,
          }),
          now,
          now,
          now,
        )
        .run();
    }
    const business = await getSetting<{ googleReviewUrl: string | null }>("business");
    return Response.json({ ok: true, googleReviewUrl: business.googleReviewUrl }, { status: 201 });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Feedback could not be saved." }, { status: 500 });
  }
}
