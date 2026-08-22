import { authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1, getSetting, writeAudit } from "@/db/runtime";
import { canTransitionOrderStatus, generateOpaqueToken, hashOpaqueToken, type Fulfilment } from "@/lib/domain";
import { anyProviderConfigured } from "@/lib/notifications/config";
import { dispatchSoon } from "@/lib/notifications/dispatcher";
import { isCustomerNotifiableStatus } from "@/lib/notifications/messages";

type ActionBody =
  | { action: "order.status"; orderId?: string; status?: string; note?: string; override?: boolean }
  | { action: "order.acknowledge"; orderId?: string }
  | { action: "product.availability"; productId?: string; soldOut?: boolean; reason?: string }
  | { action: "ordering.pause"; paused?: boolean; message?: string; reason?: string }
  | { action: "estimate.update"; fulfilment?: Fulfilment; minutes?: number; reason?: string }
  | {
      action: "closure.create";
      startsAt?: number;
      endsAt?: number;
      scope?: string;
      reason?: string;
      customerMessage?: string;
    }
  | { action: "closure.remove"; id?: string }
  | { action: "kiosk.pair" };

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json()) as ActionBody;
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    // C-09 follow-up: pairing the time-clock tablet.
    //
    // The roster endpoint publishes staff first names, and rate limiting bounds
    // how fast they can be scraped rather than stopping them being read. This
    // mints the device token that gates it.
    //
    // The raw token is returned exactly once and only its hash is stored, so a
    // database dump does not hand over the kiosk. Pairing again invalidates the
    // previous tablet, which is also how a lost one is revoked.
    if (body.action === "kiosk.pair") {
      const user = await requireStaff(request, "manage_employees");
      const token = generateOpaqueToken();
      const now = Date.now();
      await getD1()
        .prepare(
          `INSERT INTO settings (key, value_json, version, updated_by, updated_at)
           VALUES ('kiosk', ?, 1, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
             version = settings.version + 1, updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`,
        )
        .bind(JSON.stringify({ tokenHash: await hashOpaqueToken(token), pairedAt: now }), user.id, now)
        .run();
      await writeAudit({
        actorId: user.id,
        action: "kiosk.pair",
        targetType: "settings",
        targetId: "kiosk",
        requestId,
      });
      // The URL is the whole setup: open it on the tablet once and it stores the
      // token and forgets the URL.
      return Response.json({ ok: true, pairingPath: `/kiosk?pair=${encodeURIComponent(token)}` });
    }

    // H-08: holidays, one-off closures, and "back in an hour".
    //
    // Deliberately a window rather than a toggle. `ordering.paused` has no end,
    // so it depends on somebody remembering to switch it back — and the two ways
    // that goes wrong are the store staying shut after the holiday, or taking
    // orders during it. A closure expires on its own.
    if (body.action === "closure.create") {
      const user = await requireStaff(request, "pause_online_ordering");
      const startsAt = Number(body.startsAt);
      const endsAt = Number(body.endsAt);
      const scope = body.scope === "pickup" || body.scope === "delivery" ? body.scope : "both";
      const reason = (body.reason ?? "").trim();
      if (!Number.isSafeInteger(startsAt) || !Number.isSafeInteger(endsAt) || endsAt <= startsAt) {
        return Response.json({ error: "Choose a start and an end, with the end after the start." }, { status: 400 });
      }
      // A year is not a closure, it is a decision to stop trading — and one
      // mistyped year digit would silently take the store off the internet.
      if (endsAt - startsAt > 366 * 86_400_000) {
        return Response.json({ error: "A closure cannot run longer than a year." }, { status: 400 });
      }
      if (reason.length < 2 || reason.length > 200) {
        return Response.json({ error: "Give the closure a short reason." }, { status: 400 });
      }
      const id = crypto.randomUUID();
      const now = Date.now();
      await getD1()
        .prepare(
          `INSERT INTO store_closures (id, starts_at, ends_at, scope, reason, customer_message, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, startsAt, endsAt, scope, reason, (body.customerMessage ?? "").trim() || null, user.id, now, now)
        .run();
      await writeAudit({
        actorId: user.id,
        action: "closure.create",
        targetType: "store_closure",
        targetId: id,
        next: { startsAt, endsAt, scope, reason },
        requestId,
      });
      return Response.json({ ok: true, id }, { status: 201 });
    }

    if (body.action === "closure.remove") {
      const user = await requireStaff(request, "pause_online_ordering");
      const id = String(body.id ?? "");
      const previous = await getD1()
        .prepare("SELECT id, starts_at, ends_at, scope, reason FROM store_closures WHERE id = ?")
        .bind(id)
        .first<Record<string, unknown>>();
      if (!previous) return Response.json({ error: "That closure no longer exists." }, { status: 404 });
      await getD1().prepare("DELETE FROM store_closures WHERE id = ?").bind(id).run();
      await writeAudit({
        actorId: user.id,
        action: "closure.remove",
        targetType: "store_closure",
        targetId: id,
        previous,
        requestId,
      });
      return Response.json({ ok: true });
    }

    if (body.action === "order.status") {
      const target = body.status ?? "";
      const user = await requireStaff(
        request,
        target === "cancelled" ? "cancel_orders" : "change_order_status",
      );
      const order = await getD1()
        .prepare("SELECT id, order_number, status, fulfilment, customer_email FROM orders WHERE id = ?")
        .bind(body.orderId ?? "")
        .first<{ id: string; order_number: string; status: string; fulfilment: Fulfilment; customer_email: string | null }>();
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
      // Telling the customer the order moved. Only the steps they would
      // otherwise phone to ask about — ready for pickup, out for delivery; see
      // CUSTOMER_STATUS_UPDATES for why not every status — and only
      // when there is an address to reach them at: a counter order rung in
      // without an email must not queue a message to nowhere, which produces one
      // permanently failed row per walk-in in the exact place someone has to
      // look to find a real delivery failure.
      //
      // The status travels in the payload rather than being read off the order
      // at send time. A retry that runs after the kitchen has moved the order on
      // again would otherwise deliver "ready for pickup" to someone already
      // holding the bag.
      if (isCustomerNotifiableStatus(target) && order.customer_email) {
        await getD1()
          .prepare(
            `INSERT INTO notification_outbox
             (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
             VALUES (?, 'customer_status_update', ?, ?, ?, 0, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            order.customer_email,
            JSON.stringify({ orderId: order.id, orderNumber: order.order_number, status: target }),
            (await anyProviderConfigured()) ? "pending" : "pending_provider_setup",
            now,
            now,
            now,
          )
          .run();
        // Node can send this in-process, so "ready for pickup" does not wait for
        // the next cron tick to leave. A failure here is swallowed by design: the
        // row is already durable, and the sweeper is the safety net.
        dispatchSoon();
      }
      // H-09: completing an order is what releases its feedback request, delayed
      // by operations.feedbackDelayMinutes so the customer is asked after they
      // have actually eaten rather than as they walk out of the door.
      if (target === "completed") {
        const operations = await getSetting<{ feedbackDelayMinutes: number }>("operations");
        await getD1()
          .prepare(
            `UPDATE notification_outbox SET status = ?, scheduled_for = ?, updated_at = ?
             WHERE kind = 'feedback_request'
               AND status = 'waiting_completion'
               AND payload_json::jsonb->>'orderId' = ?`,
          )
          .bind(
            (await anyProviderConfigured()) ? "pending" : "pending_provider_setup",
            now + (operations.feedbackDelayMinutes ?? 40) * 60_000,
            now,
            order.id,
          )
          .run();
      }
      // A cancelled order must never confirm itself, ring the kitchen, or ask
      // the customer how their meal was.
      if (target === "cancelled") {
        await getD1()
          .prepare(
            `UPDATE notification_outbox SET status = 'cancelled', updated_at = ?
             WHERE status IN ('waiting_payment', 'waiting_completion', 'pending', 'retrying', 'pending_provider_setup')
               AND payload_json::jsonb->>'orderId' = ?`,
          )
          .bind(now, order.id)
          .run();
      }
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
      // Acknowledging on the kitchen screen is what stops the escalation calls:
      // requeueUnacknowledgedOrders() only re-queues orders whose acknowledged_at
      // is still null, so this button and the phone keypad share one piece of
      // state rather than each keeping their own.
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
