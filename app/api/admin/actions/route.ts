import { authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1, getSetting, writeAudit } from "@/db/runtime";
import { canTransitionOrderStatus, type Fulfilment } from "@/lib/domain";

type ActionBody =
  | { action: "order.status"; orderId?: string; status?: string; note?: string; override?: boolean }
  | { action: "order.acknowledge"; orderId?: string }
  | { action: "product.availability"; productId?: string; soldOut?: boolean; reason?: string }
  | { action: "ordering.pause"; paused?: boolean; message?: string; reason?: string }
  | { action: "estimate.update"; fulfilment?: Fulfilment; minutes?: number; reason?: string };

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json()) as ActionBody;
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    if (body.action === "order.status") {
      const target = body.status ?? "";
      const user = await requireStaff(
        request,
        target === "cancelled" ? "cancel_orders" : "change_order_status",
      );
      const order = await getD1()
        .prepare("SELECT id, status, fulfilment FROM orders WHERE id = ?")
        .bind(body.orderId ?? "")
        .first<{ id: string; status: string; fulfilment: Fulfilment }>();
      if (!order) return Response.json({ error: "Order not found." }, { status: 404 });
      if (!canTransitionOrderStatus(order.fulfilment, order.status, target, Boolean(body.override))) {
        return Response.json({ error: "That order status transition is not valid." }, { status: 409 });
      }
      if (body.override && user.role !== "owner" && !user.permissions.includes("manual_order_override")) {
        return Response.json({ error: "Override permission is required." }, { status: 403 });
      }
      const now = Date.now();
      await getD1().batch([
        getD1()
          .prepare(
            `UPDATE orders SET status = ?,
               payment_status = CASE
                 WHEN ? = 'cancelled' AND payment_status = 'pending_at_store' THEN 'cancelled'
                 ELSE payment_status
               END,
               updated_at = ?
             WHERE id = ? AND status = ?`,
          )
          .bind(target, target, now, order.id, order.status),
        getD1()
          .prepare(
            `INSERT INTO order_events
             (id, order_id, previous_status, next_status, actor_type, actor_id, note, created_at)
             VALUES (?, ?, ?, ?, 'staff', ?, ?, ?)`,
          )
          .bind(crypto.randomUUID(), order.id, order.status, target, user.id, body.note?.trim() || null, now),
      ]);
      await writeAudit({
        actorId: user.id,
        action: body.override ? "order.status.override" : "order.status.change",
        targetType: "order",
        targetId: order.id,
        previous: { status: order.status },
        next: { status: target },
        reason: body.note,
        requestId,
      });
      return Response.json({ ok: true, status: target });
    }
    if (body.action === "order.acknowledge") {
      const user = await requireStaff(request, "acknowledge_orders");
      const now = Date.now();
      const result = await getD1()
        .prepare("UPDATE orders SET acknowledged_at = ?, updated_at = ? WHERE id = ? AND acknowledged_at IS NULL")
        .bind(now, now, body.orderId ?? "")
        .run();
      if (!result.meta.changes) return Response.json({ error: "Order not found or already acknowledged." }, { status: 409 });
      await writeAudit({ actorId: user.id, action: "order.acknowledge", targetType: "order", targetId: body.orderId ?? "", requestId });
      return Response.json({ ok: true });
    }
    if (body.action === "product.availability") {
      const user = await requireStaff(request, "mark_products_unavailable");
      const product = await getD1()
        .prepare("SELECT id, name, sold_out FROM products WHERE id = ?")
        .bind(body.productId ?? "")
        .first<{ id: string; name: string; sold_out: number }>();
      if (!product) return Response.json({ error: "Product not found." }, { status: 404 });
      const next = Boolean(body.soldOut);
      await getD1().prepare("UPDATE products SET sold_out = ?, updated_at = ? WHERE id = ?").bind(next ? 1 : 0, Date.now(), product.id).run();
      await writeAudit({
        actorId: user.id,
        action: "product.availability.change",
        targetType: "product",
        targetId: product.id,
        previous: { soldOut: Boolean(product.sold_out) },
        next: { soldOut: next },
        reason: body.reason,
        requestId,
      });
      return Response.json({ ok: true });
    }
    if (body.action === "ordering.pause") {
      const user = await requireStaff(request, "pause_online_ordering");
      const current = await getSetting<Record<string, unknown>>("ordering");
      const next = {
        ...current,
        paused: Boolean(body.paused),
        pauseMessage: body.message?.trim() || current.pauseMessage,
      };
      const now = Date.now();
      await getD1()
        .prepare("UPDATE settings SET value_json = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE key = 'ordering'")
        .bind(JSON.stringify(next), user.id, now)
        .run();
      await writeAudit({
        actorId: user.id,
        action: next.paused ? "ordering.pause" : "ordering.resume",
        targetType: "setting",
        targetId: "ordering",
        previous: current,
        next,
        reason: body.reason,
        requestId,
      });
      return Response.json({ ok: true, ordering: next });
    }
    if (body.action === "estimate.update") {
      const user = await requireStaff(request, "change_preparation_time");
      if (!Number.isInteger(body.minutes) || (body.minutes ?? 0) < 5 || (body.minutes ?? 0) > 240) {
        return Response.json({ error: "Estimate must be between 5 and 240 minutes." }, { status: 400 });
      }
      const fulfilment = body.fulfilment;
      if (fulfilment !== "pickup" && fulfilment !== "delivery") {
        return Response.json({ error: "Choose pickup or delivery." }, { status: 400 });
      }
      const current = await getSetting<Record<string, unknown>>("ordering");
      const field = fulfilment === "pickup" ? "pickupEstimateMinutes" : "deliveryEstimateMinutes";
      const next = { ...current, [field]: body.minutes };
      await getD1()
        .prepare("UPDATE settings SET value_json = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE key = 'ordering'")
        .bind(JSON.stringify(next), user.id, Date.now())
        .run();
      await writeAudit({
        actorId: user.id,
        action: "order.estimate.change",
        targetType: "setting",
        targetId: field,
        previous: { minutes: current[field] },
        next: { minutes: body.minutes },
        reason: body.reason,
        requestId,
      });
      return Response.json({ ok: true, ordering: next });
    }
    return Response.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
