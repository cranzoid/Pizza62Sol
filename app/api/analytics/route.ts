import { ensureDatabase, getD1 } from "@/db/runtime";
import { enforceRateLimit, RateLimitError } from "@/lib/security";

const ALLOWED_EVENTS = new Set([
  "website_visit",
  "fulfilment_selected",
  "delivery_eligibility_checked",
  "menu_viewed",
  "product_viewed",
  "add_to_cart",
  "remove_from_cart",
  "cart_viewed",
  "checkout_started",
  "payment_attempted",
  "purchase_completed",
  "promotion_used",
  "coupon_used",
  "feedback_submitted",
  "google_review_clicked",
  // Inline card entry could not start and the checkout fell back to Clover's
  // hosted page. Recorded because the fallback is deliberately invisible to the
  // customer, which also makes it invisible to us — this is how a broken card
  // form gets noticed without someone happening to have the console open.
  "card_form_unavailable",
  "phone_clicked",
]);

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "analytics", 120, 15 * 60 * 1000);
    await ensureDatabase();
    const body = (await request.json()) as { eventName?: string; sessionId?: string; context?: Record<string, unknown> };
    if (!body.eventName || !ALLOWED_EVENTS.has(body.eventName)) {
      return Response.json({ error: "Unsupported analytics event." }, { status: 400 });
    }
    const context = JSON.stringify(body.context ?? {});
    if (context.length > 4000) return Response.json({ error: "Analytics context is too large." }, { status: 400 });
    await getD1()
      .prepare(
        `INSERT INTO analytics_events (id, session_id, event_name, context_json, occurred_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), body.sessionId?.slice(0, 100) || null, body.eventName, context, Date.now())
      .run();
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof RateLimitError) return new Response(null, { status: 429 });
    return new Response(null, { status: 500 });
  }
}
