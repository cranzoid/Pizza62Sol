import { env } from "cloudflare:workers";
import { ensureDatabase, getD1 } from "@/db/runtime";

function equalHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<boolean> {
  const parts = header.split(",").map((entry) => entry.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1] ?? "";
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)));
  const expected = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return signatures.some((signature) => equalHex(signature, expected));
}

export async function POST(request: Request) {
  const webhookSecret = (env as unknown as Record<string, string | undefined>).STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return Response.json({ error: "Stripe webhook is not configured." }, { status: 503 });
  const payload = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";
  if (!(await verifyStripeSignature(payload, signature, webhookSecret))) {
    return Response.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }
  const event = JSON.parse(payload) as {
    type?: string;
    data?: { object?: { id?: string; amount_total?: number; payment_status?: string; metadata?: { order_id?: string } } };
  };
  const session = event.data?.object;
  const orderId = session?.metadata?.order_id ?? "";
  if (!orderId || !session?.id) return Response.json({ received: true });
  await ensureDatabase();
  const record = await getD1()
    .prepare(
      `SELECT o.status, o.payment_status, p.amount_cents
       FROM orders o JOIN payments p ON p.order_id = o.id
       WHERE o.id = ? AND p.provider = 'stripe'`,
    )
    .bind(orderId)
    .first<{ status: string; payment_status: string; amount_cents: number }>();
  if (!record) return Response.json({ received: true });
  if (event.type === "checkout.session.completed" && session.payment_status === "paid") {
    if (session.amount_total !== record.amount_cents) {
      return Response.json({ error: "Stripe amount does not match the server-priced order." }, { status: 409 });
    }
    if (record.status === "awaiting_payment") {
      const now = Date.now();
      const confirmationStatus = (env as unknown as Record<string, string | undefined>).EMAIL_API_KEY
        ? "pending"
        : "pending_provider_setup";
      await getD1().batch([
        getD1()
          .prepare("UPDATE payments SET status = 'captured', provider_reference = ?, updated_at = ? WHERE order_id = ?")
          .bind(session.id, now, orderId),
        getD1()
          .prepare("UPDATE orders SET status = 'received', payment_status = 'paid', updated_at = ? WHERE id = ? AND status = 'awaiting_payment'")
          .bind(now, orderId),
        getD1()
          .prepare(
            `INSERT INTO order_events
             (id, order_id, previous_status, next_status, actor_type, actor_id, note, created_at)
             VALUES (?, ?, 'awaiting_payment', 'received', 'stripe', NULL, 'Stripe payment confirmed', ?)`,
          )
          .bind(crypto.randomUUID(), orderId, now),
        getD1()
          .prepare(
            `UPDATE notification_outbox SET status = ?, updated_at = ?
             WHERE kind = 'customer_order_confirmation'
               AND json_extract(payload_json, '$.orderId') = ?`,
          )
          .bind(confirmationStatus, now, orderId),
      ]);
    }
  } else if (event.type === "checkout.session.expired" && record.status === "awaiting_payment") {
    const now = Date.now();
    await getD1().batch([
      getD1()
        .prepare("UPDATE payments SET status = 'expired', updated_at = ? WHERE order_id = ?")
        .bind(now, orderId),
      getD1()
        .prepare("UPDATE orders SET status = 'cancelled', payment_status = 'expired', updated_at = ? WHERE id = ?")
        .bind(now, orderId),
      getD1()
        .prepare(
          `UPDATE notification_outbox SET status = 'cancelled', updated_at = ?
           WHERE kind = 'customer_order_confirmation'
             AND json_extract(payload_json, '$.orderId') = ?`,
        )
        .bind(now, orderId),
    ]);
  }
  return Response.json({ received: true });
}
