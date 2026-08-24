/**
 * Prices a cart without creating anything (H-24).
 *
 * The checkout review used to add up the cart in the browser and call the result
 * "estimated", because nothing on the server would tell it otherwise until the
 * order was submitted. That is the shape of problem where a customer agrees to
 * one number and is charged another: two implementations of discount and tax
 * arithmetic, and no mechanism keeping them in step.
 *
 * This runs the same pricing path `createOrder` runs. Whatever it returns is
 * what the order will cost.
 *
 * Read-only — no order, no payment, no idempotency key, nothing written. The
 * rate limit is generous for that reason: it is re-quoted on every tip change
 * and coupon attempt, and being stingy here just means a review screen that
 * stops updating while someone is deciding how much to tip.
 */
import { OrderValidationError, quoteOrder } from "@/lib/order-service";
import { logFailure } from "@/lib/log";
import { enforceRateLimit, RateLimitError } from "@/lib/security";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "order-quote", 120, 15 * 60 * 1000);
    const body = await request.json();
    return Response.json(await quoteOrder(body), { status: 200 });
  } catch (error) {
    if (error instanceof OrderValidationError || error instanceof RateLimitError) {
      return Response.json(
        { error: error.message, code: error instanceof OrderValidationError ? error.code : "RATE_LIMITED" },
        { status: error.status },
      );
    }
    const reference = logFailure("orders.quote", error);
    return Response.json({ error: "We could not price that cart.", reference }, { status: 500 });
  }
}
