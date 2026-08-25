/**
 * Counter and phone order entry.
 *
 * The owner's question is "how many were in store", and it cannot be answered
 * while half the orders live in a different system. This is the other half: a
 * member of staff keying in a walk-in or a phone order, tagged with where it
 * came from, priced by the same code the website uses.
 *
 * **It goes through `createOrder`.** Not a shortcut that writes an order row —
 * the same function, so pricing, HST, promotions, the delivery minimum, closures,
 * the kitchen ticket, the outbox and the audit trail are identical to an online
 * order. A counter order priced by a second implementation is how a restaurant
 * ends up with two sets of books.
 *
 * **The channel is not in the request body.** It is passed as a trusted context
 * argument after authentication, so a customer hitting the public order endpoint
 * cannot label their own order `walk_in` and quietly corrupt the figures the
 * owner runs the business on.
 */
import { AuthError, authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, writeAudit } from "@/db/runtime";
import { hasPermission } from "@/lib/domain";
import { logFailure } from "@/lib/log";
import { createOrder, OrderValidationError, quoteOrder, type OrderRequest } from "@/lib/order-service";
import { loadOrderCore, loadOrderDetail, redactOrderContact } from "@/lib/order-detail";

type Body = OrderRequest & {
  /** Where it was taken. Anything else is refused rather than defaulted. */
  channel?: string;
  /** True to price without creating, so the counter shows a total before ringing it in. */
  quoteOnly?: boolean;
};

/**
 * The exact committed order shape consumed by the existing PassPRNT ticket.
 *
 * Loaded here, after creation, instead of trusting the till's cart: the server
 * has applied the real price, tax, promotions and immutable item snapshots by
 * this point. Returning it from this authenticated endpoint also lets Android
 * start printing immediately without waiting for the 30-second dashboard poll.
 */
async function loadPrintOrder(orderId: unknown): Promise<Record<string, unknown> | null> {
  if (typeof orderId !== "string" || !orderId) return null;
  return loadOrderCore(orderId);
}

/**
 * Order detail — everything staff can look back at once an order has left the
 * live board: items, the status timeline, refunds, feedback and who rang it
 * in. Contact fields follow the same `view_customer_contact` rule as the
 * order history CSV export.
 */
export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request, "view_orders");
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!id) return Response.json({ error: "An order id is required." }, { status: 400 });
    const order = await loadOrderDetail(id);
    if (!order) return Response.json({ error: "That order could not be found." }, { status: 404 });
    const canViewContact = user.role === "owner" || user.permissions.includes("view_customer_contact");
    return Response.json({ order: redactOrderContact(order, canViewContact) });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const user = await requireStaff(request, "view_orders");
    if (user.role !== "owner" && !hasPermission(user.role, user.permissions, "manual_order_override")) {
      throw new AuthError(403, "You do not have permission to take orders on behalf of a customer.");
    }

    const body = (await request.json()) as Body;
    const channel = body.channel === "phone" ? "phone" : body.channel === "walk_in" ? "walk_in" : null;
    if (!channel) {
      return Response.json(
        { error: "Say whether this is a walk-in or a phone order." },
        { status: 400 },
      );
    }

    // The counter needs the total before it takes the money, and it must be the
    // same number the order will be created for — so it comes from the same
    // pricing path rather than being added up on the till screen.
    if (body.quoteOnly) {
      return Response.json(await quoteOrder(body), { status: 200 });
    }

    const result = await createOrder(body, { channel, staffEntry: true, staffUserId: user.id });

    // Who rang it in. An order that appeared at the counter with no record of
    // who took it is the thing a cash-handling audit asks about first.
    await writeAudit({
      actorId: user.id,
      action: "order.staff_entry",
      targetType: "order",
      targetId: String(result.orderId ?? ""),
      next: { channel, orderNumber: result.orderNumber, totalCents: result.totalCents },
    });

    // The order is already committed. If the convenience read for automatic
    // printing ever fails, report the successful order and leave it printable
    // from Live orders instead of telling staff to submit (and charge) it again.
    const printOrder = await loadPrintOrder(result.orderId).catch((error) => {
      logFailure("orders.staff_ticket", error);
      return null;
    });
    return Response.json({ ...result, printOrder }, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof OrderValidationError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof AuthError) return authErrorResponse(error);
    const reference = logFailure("orders.staff_entry", error);
    return Response.json({ error: "That order could not be created.", reference }, { status: 500 });
  }
}
