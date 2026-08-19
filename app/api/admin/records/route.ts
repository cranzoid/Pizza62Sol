import { authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1, safeJson, writeAudit } from "@/db/runtime";
import { hasPermission } from "@/lib/domain";

/** Past orders and customer feedback: the two things an owner looks back at. */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request, "view_orders");
    const url = new URL(request.url);
    const tab = url.searchParams.get("tab") === "feedback" ? "feedback" : "orders";
    const canViewContact = user.role === "owner" || user.permissions.includes("view_customer_contact");

    if (tab === "feedback") {
      const rows = await getD1()
        .prepare(
          `SELECT f.id, f.overall_rating, f.written_feedback, f.answers_json, f.submitted_at,
                  f.reviewed_at, f.internal_note, o.order_number, o.fulfilment
           FROM feedback_responses f LEFT JOIN orders o ON o.id = f.order_id
           ORDER BY f.submitted_at DESC LIMIT 100`,
        )
        .all<Record<string, unknown>>();
      return Response.json({
        feedback: rows.results.map((row) => ({
          ...row,
          answers: safeJson(String(row.answers_json ?? "{}"), {}),
          answers_json: undefined,
        })),
      });
    }

    const query = (url.searchParams.get("query") ?? "").trim().slice(0, 60);
    const status = url.searchParams.get("status") ?? "";
    const conditions: string[] = [];
    const bindings: unknown[] = [];
    if (query) {
      // Order number, name, phone or email — whichever the owner has to hand.
      conditions.push("(order_number ILIKE ? OR customer_name ILIKE ? OR customer_phone ILIKE ? OR customer_email ILIKE ?)");
      const like = `%${query}%`;
      bindings.push(like, like, like, like);
    }
    if (status && status !== "all") {
      conditions.push("status = ?");
      bindings.push(status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await getD1()
      .prepare(
        `SELECT id, order_number, customer_name, customer_phone, customer_email, fulfilment, status,
                payment_status, payment_method, schedule_type, scheduled_for, created_at,
                subtotal_cents, discount_cents, tax_cents, delivery_fee_cents, tip_cents, total_cents
         FROM orders ${where} ORDER BY created_at DESC LIMIT 100`,
      )
      .bind(...bindings)
      .all<Record<string, unknown>>();
    return Response.json({
      orders: rows.results.map((order) => ({
        ...order,
        customer_phone: canViewContact ? order.customer_phone : undefined,
        customer_email: canViewContact ? order.customer_email : undefined,
        contactRedacted: !canViewContact,
      })),
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request, "view_orders");
    const body = (await request.json()) as { action?: string; id?: string; note?: string };
    if (body.action === "feedback.review") {
      if (user.role !== "owner" && !hasPermission(user.role, user.permissions, "view_analytics")) {
        return Response.json({ error: "You do not have permission to handle feedback." }, { status: 403 });
      }
      const now = Date.now();
      const result = await getD1()
        .prepare("UPDATE feedback_responses SET reviewed_at = ?, internal_note = ? WHERE id = ?")
        .bind(now, body.note ? String(body.note).slice(0, 500) : null, body.id ?? "")
        .run();
      if (!result.meta.changes) return Response.json({ error: "That feedback no longer exists." }, { status: 404 });
      await writeAudit({ actorId: user.id, action: "feedback.review", targetType: "feedback", targetId: String(body.id) });
      return Response.json({ ok: true });
    }
    return Response.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    return authErrorResponse(error);
  }
}
