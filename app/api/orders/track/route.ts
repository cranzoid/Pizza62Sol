import { ensureDatabase, getD1, getSetting, safeJson } from "@/db/runtime";
import { hashOpaqueToken } from "@/lib/domain";
import { enforceRateLimit, RateLimitError } from "@/lib/security";

export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, "public-order-tracking", 20, 15 * 60 * 1000);
    await ensureDatabase();
    const url = new URL(request.url);
    const orderNumber = url.searchParams.get("order")?.trim().toUpperCase() ?? "";
    // H-15: the header is what the app sends. A token in a query string is
    // written to every access log it passes through, which is how it was found
    // in the first place — the audit read full tokenised URLs out of the runtime
    // log. The query parameter remains only so a link opened by something that
    // does not run JavaScript still works.
    const token = request.headers.get("x-tracking-token")?.trim() || url.searchParams.get("token") || "";
    if (!/^P62-[0-9]{1,10}$/.test(orderNumber) || token.length < 32) {
      return Response.json({ error: "Order not found." }, { status: 404 });
    }
    const row = await getD1()
      .prepare(
        `SELECT id, order_number, fulfilment, status, payment_status, schedule_type,
                scheduled_for, estimated_for, address_json, pricing_json, total_cents, created_at
         FROM orders WHERE order_number = ? AND tracking_token_hash = ?`,
      )
      .bind(orderNumber, await hashOpaqueToken(token))
      .first<Record<string, unknown>>();
    if (!row) return Response.json({ error: "Order not found." }, { status: 404 });
    const items = await getD1()
      .prepare(
        `SELECT product_name, variation_name, quantity, unit_price_cents, line_total_cents,
                snapshot_json, instructions FROM order_items WHERE order_id = ? ORDER BY created_at`,
      )
      .bind(row.id)
      .all<Record<string, unknown>>();
    const business = await getSetting<{ name: string; phone: string }>("business");
    const address = safeJson<Record<string, string>>(row.address_json as string | null, {});
    return Response.json({
      order: {
        orderNumber: row.order_number,
        fulfilment: row.fulfilment,
        status: row.status,
        paymentStatus: row.payment_status,
        scheduleType: row.schedule_type,
        scheduledFor: row.scheduled_for,
        estimatedFor: row.estimated_for,
        totalCents: row.total_cents,
        createdAt: row.created_at,
        maskedAddress: address.city ? `${address.city}, ${address.province ?? "ON"}` : null,
        pricing: safeJson(row.pricing_json as string, {}),
        items: items.results.map((item) => ({
          name: item.product_name,
          variation: item.variation_name,
          quantity: item.quantity,
          unitPriceCents: item.unit_price_cents,
          lineTotalCents: item.line_total_cents,
          configuration: safeJson(item.snapshot_json as string, {}),
          instructions: item.instructions,
        })),
      },
      store: business,
    });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Tracking is temporarily unavailable." }, { status: 500 });
  }
}
