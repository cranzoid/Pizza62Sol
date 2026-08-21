import { createOrder, OrderValidationError } from "@/lib/order-service";
import { logFailure } from "@/lib/log";
import { enforceRateLimit, RateLimitError } from "@/lib/security";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "order-create", 12, 15 * 60 * 1000);
    const body = await request.json();
    const result = await createOrder(body);
    return Response.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof OrderValidationError || error instanceof RateLimitError) {
      return Response.json(
        { error: error.message, code: error instanceof OrderValidationError ? error.code : "RATE_LIMITED" },
        { status: error.status },
      );
    }
    // Opaque to the customer, specific in the logs. The message stays vague
    // because a constraint name or a stack trace has no business reaching the
    // internet — but the reference lets support tie a complaint to the log line.
    const requestId = logFailure("orders.create", error);
    return Response.json(
      {
        error: "We could not safely create the order. No confirmation was recorded.",
        reference: requestId,
      },
      { status: 500 },
    );
  }
}
