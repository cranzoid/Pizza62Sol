import { ensureDatabase, getD1, getSetting, safeJson } from "@/db/runtime";
import { hashOpaqueToken } from "@/lib/domain";
import { anyProviderConfigured } from "@/lib/notifications/config";
import { activeFeedbackReward } from "@/lib/rewards";
import { enforceRateLimit, RateLimitError } from "@/lib/security";

type QuestionCondition = {
  /** Legacy, and kept working: matches the raw `products.product_type` column. */
  includesProductType?: string;
  /** What the order actually contained, however it was sold. */
  requiresTrait?: string;
  wordingByFulfilment?: boolean;
};

/**
 * What was in the order, in terms a question can be asked about.
 *
 * Not the product type. A large pizza bought on its own is a `pizza`; the same
 * pizza inside a two-pizza deal is part of a `bundle`, and asking the deal
 * customer nothing about their crust because of how it was sold is the wrong
 * answer to the wrong question. So an item counts as pizza when it *is* one or
 * when it carries a topping group, which is what a pizza inside a deal has —
 * and the same reasoning gives wings and drinks.
 *
 * Derived from the product's live configuration rather than the item snapshot:
 * the snapshot records what the customer chose, and a customer who chose no
 * toppings at all still ate a crust.
 */
function orderTraits(
  rows: Array<{ product_type: string; category_id: string; configuration_json: string }>,
): Set<string> {
  const traits = new Set<string>();
  for (const row of rows) {
    const configuration = safeJson<{ sections?: Array<{ source?: string }> }>(row.configuration_json, {});
    const sources = new Set(
      (Array.isArray(configuration.sections) ? configuration.sections : []).map((section) => section?.source),
    );
    if (row.product_type === "pizza" || sources.has("toppings")) traits.add("pizza");
    if (sources.has("wing_flavours")) traits.add("wings");
    if (sources.has("drinks") || row.category_id === "drinks") traits.add("drinks");
  }
  return traits;
}

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
        `SELECT p.product_type, p.category_id, p.configuration_json
         FROM order_items i JOIN products p ON p.id = i.product_id
         WHERE i.order_id = ?`,
      )
      .bind(order.id)
      .all<{ product_type: string; category_id: string; configuration_json: string }>();
    const types = new Set(itemTypes.results.map((row) => row.product_type));
    const traits = orderTraits(itemTypes.results);
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
          const condition = safeJson<QuestionCondition>(question.condition_json as string, {});
          if (condition.requiresTrait && !traits.has(condition.requiresTrait)) return false;
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
    /**
     * The thank-you coupon, for everyone who answered.
     *
     * Queued on the strength of a reward existing *now*; the dispatcher looks it
     * up again at send time and parks the row if it has since been switched off,
     * so the terms in the mail are always the terms the till will honour.
     *
     * Silently skipped when there is no email address to send it to — a counter
     * order is often taken with nothing but a name — and never allowed to fail
     * the submission. The feedback is the thing that had to be saved, and it
     * already has been by this point; a customer whose answers vanished because
     * a coupon could not be queued would have every right to be annoyed.
     */
    const reward = await activeFeedbackReward().catch(() => null);
    if (reward && order.customer_email) {
      await getD1()
        .prepare(
          `INSERT INTO notification_outbox
           (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
           VALUES (?, 'feedback_reward', ?, ?, ?, 0, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          String(order.customer_email),
          JSON.stringify({ orderId: order.id, orderNumber: order.order_number }),
          (await anyProviderConfigured()) ? "pending" : "pending_provider_setup",
          now,
          now,
          now,
        )
        .run()
        .catch(() => undefined);
    }
    const business = await getSetting<{ googleReviewUrl: string | null }>("business");
    return Response.json(
      {
        ok: true,
        googleReviewUrl: business.googleReviewUrl,
        // What the thank-you screen may promise. Null when there is no live
        // offer, or nowhere to send it — the screen must not tell someone to
        // watch their inbox for a mail that was never queued.
        reward: reward && order.customer_email ? { offer: reward.offer, worth: reward.worth } : null,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof RateLimitError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Feedback could not be saved." }, { status: 500 });
  }
}
