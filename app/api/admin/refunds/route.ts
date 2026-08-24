/**
 * Recording a refund (H-07 / H-25).
 *
 * **This does not move money, and says so everywhere.** The researched Clover
 * contract covers creating a hosted checkout and the payment webhook; it
 * documents no refund endpoint. Writing one would mean guessing at an API, and a
 * refund path that records a refund without moving money is worse than no path
 * at all — the customer is out of pocket and the books say they were paid back.
 *
 * So the refund happens where it can actually happen — in the Clover merchant
 * dashboard — and is recorded here afterwards, with the Clover reference tying
 * the two together. That gives the owner one place to see what was refunded and
 * why, correct order and payment state, and reporting that is not silently wrong
 * about revenue. When a refund API contract does arrive, this becomes the
 * bookkeeping half of it rather than something to unpick.
 *
 * The guards that matter:
 *
 * - **You cannot record more than was captured**, cumulatively across refunds.
 *   Nothing downstream would catch a total that exceeds the payment.
 * - **A cash order refunds without a Clover reference**, because there is no
 *   Clover transaction to reference. Requiring one would push staff to type
 *   something to get past the form.
 * - **Recording is reversible by voiding, not by deleting.** A mis-keyed amount
 *   must be correctable without erasing the fact that someone keyed it.
 */
import { AuthError, authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1, writeAudit } from "@/db/runtime";
import { hasPermission, validateRefundAmount } from "@/lib/domain";
import { logFailure } from "@/lib/log";

type Body =
  | {
      action: "refund.record";
      orderId?: string;
      amountCents?: number;
      reason?: string;
      providerReference?: string;
      customerNote?: string;
    }
  | { action: "refund.void"; refundId?: string; reason?: string };

async function requireRefundPermission(request: Request) {
  const user = await requireStaff(request, "view_orders");
  if (user.role !== "owner" && !hasPermission(user.role, user.permissions, "issue_refunds")) {
    throw new AuthError(403, "You do not have permission to record refunds.");
  }
  return user;
}

/** Everything already recorded against this order, so a total can be checked. */
async function refundedSoFar(orderId: string): Promise<number> {
  const row = await getD1()
    .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM refunds WHERE order_id = ? AND status = 'recorded'")
    .bind(orderId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    await requireRefundPermission(request);
    const orderId = new URL(request.url).searchParams.get("orderId") ?? "";
    const rows = await getD1()
      .prepare(
        `SELECT r.id, r.amount_cents, r.reason, r.customer_note, r.provider_reference, r.status,
                r.actor_id, r.created_at, u.name AS actor_name
         FROM refunds r LEFT JOIN staff_users u ON u.id = r.actor_id
         WHERE r.order_id = ? ORDER BY r.created_at DESC`,
      )
      .bind(orderId)
      .all<Record<string, unknown>>();
    return Response.json({ refunds: rows.results, refundedCents: await refundedSoFar(orderId) });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireRefundPermission(request);
    const body = (await request.json()) as Body;

    if (body.action === "refund.void") {
      const refundId = String(body.refundId ?? "");
      const previous = await getD1()
        .prepare("SELECT * FROM refunds WHERE id = ? AND status = 'recorded'")
        .bind(refundId)
        .first<Record<string, unknown>>();
      if (!previous) return Response.json({ error: "That refund is not recorded." }, { status: 404 });
      const now = Date.now();
      await getD1()
        .prepare("UPDATE refunds SET status = 'voided', internal_note = ?, updated_at = ? WHERE id = ?")
        .bind(String(body.reason ?? "").slice(0, 500) || "Entered in error", now, refundId)
        .run();
      await syncOrderRefundState(String(previous.order_id));
      await writeAudit({
        actorId: user.id,
        action: "refund.void",
        targetType: "refund",
        targetId: refundId,
        previous,
      });
      return Response.json({ ok: true });
    }

    if (body.action !== "refund.record") {
      return Response.json({ error: "Unsupported action." }, { status: 400 });
    }

    const orderId = String(body.orderId ?? "");
    const order = await getD1()
      .prepare("SELECT id, order_number, payment_method, payment_status, total_cents FROM orders WHERE id = ?")
      .bind(orderId)
      .first<{ id: string; order_number: string; payment_method: string; payment_status: string; total_cents: number }>();
    if (!order) return Response.json({ error: "Order not found." }, { status: 404 });

    const payment = await getD1()
      .prepare(
        `SELECT id, status, amount_cents, provider FROM payments
         WHERE order_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(orderId)
      .first<{ id: string; status: string; amount_cents: number; provider: string }>();
    if (!payment) return Response.json({ error: "That order has no payment to refund." }, { status: 409 });

    // Only money that was actually taken can be given back. A pay-at-store order
    // that was never collected has nothing to refund, and recording one would
    // put revenue on the books that never existed and then take it off again.
    const collected =
      payment.status === "captured" || order.payment_status === "paid" || order.payment_method === "pay_at_store";
    if (!collected) {
      return Response.json(
        { error: "No payment was taken on that order, so there is nothing to refund." },
        { status: 409 },
      );
    }

    const amountCents = Number(body.amountCents);
    const already = await refundedSoFar(orderId);
    try {
      validateRefundAmount(Number(payment.amount_cents), already, amountCents);
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }

    const reason = String(body.reason ?? "").trim();
    if (reason.length < 2 || reason.length > 200) {
      return Response.json({ error: "Give a short reason for the refund." }, { status: 400 });
    }

    // A card refund happens in Clover, so its reference is what ties this record
    // to the actual movement of money. Cash has no such reference, and demanding
    // one would only teach staff to invent it.
    const providerReference = String(body.providerReference ?? "").trim();
    if (payment.provider === "clover" && !providerReference) {
      return Response.json(
        { error: "Issue the refund in the Clover dashboard first, then paste its reference here." },
        { status: 400 },
      );
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    await getD1()
      .prepare(
        `INSERT INTO refunds (id, order_id, payment_id, amount_cents, reason, internal_note, customer_note,
           provider_reference, status, actor_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'recorded', ?, ?, ?)`,
      )
      .bind(
        id,
        orderId,
        payment.id,
        amountCents,
        reason,
        String(body.customerNote ?? "").slice(0, 500) || null,
        providerReference || null,
        user.id,
        now,
        now,
      )
      .run();

    await syncOrderRefundState(orderId);
    await writeAudit({
      actorId: user.id,
      action: "refund.record",
      targetType: "refund",
      targetId: id,
      next: { orderId, orderNumber: order.order_number, amountCents, reason, providerReference },
    });

    return Response.json({ ok: true, id, refundedCents: already + amountCents }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    const reference = logFailure("refunds.record", error);
    return Response.json({ error: "That refund could not be recorded.", reference }, { status: 500 });
  }
}

/**
 * Brings order and payment status in line with what has been recorded.
 *
 * Recomputed from the refund rows rather than incremented, so voiding one puts
 * the order back where it belongs instead of leaving it marked refunded forever.
 */
async function syncOrderRefundState(orderId: string): Promise<void> {
  const payment = await getD1()
    .prepare("SELECT id, amount_cents, provider FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(orderId)
    .first<{ id: string; amount_cents: number; provider: string }>();
  const order = await getD1()
    .prepare("SELECT payment_method FROM orders WHERE id = ?")
    .bind(orderId)
    .first<{ payment_method: string }>();
  if (!payment || !order) return;

  const refunded = await refundedSoFar(orderId);
  const total = Number(payment.amount_cents);
  const now = Date.now();

  // Voiding the only refund has to put the order back where it *was*, which is
  // not the same place for every order. A cash pickup order is `pending_at_store`
  // and its payment row is `pending`; marking it `paid`/`captured` on the way
  // back would invent a card settlement that never happened, and it would count
  // as revenue in the paid-orders figures on the dashboard.
  const restoredPaymentStatus = order.payment_method === "pay_at_store" ? "pending" : "captured";
  const restoredOrderStatus = order.payment_method === "pay_at_store" ? "pending_at_store" : "paid";

  const paymentStatus =
    refunded <= 0 ? restoredPaymentStatus : refunded >= total ? "refunded" : "partially_refunded";
  const orderPaymentStatus =
    refunded <= 0 ? restoredOrderStatus : refunded >= total ? "refunded" : "partially_refunded";

  await getD1().batch([
    getD1()
      .prepare("UPDATE payments SET status = ?, updated_at = ? WHERE id = ?")
      .bind(paymentStatus, now, payment.id),
    getD1()
      .prepare("UPDATE orders SET payment_status = ?, updated_at = ? WHERE id = ?")
      .bind(orderPaymentStatus, now, orderId),
  ]);
}
