/**
 * Which placed orders the till may change. Pure, so the till can grey out the
 * Edit button with exactly the rule the server enforces in `editOrder`.
 */

/**
 * Statuses an order can still be changed in. Once it is completed the food has
 * left the building; a cancelled order is history; an online checkout that has
 * not been confirmed is not the restaurant's to edit.
 */
export const EDITABLE_ORDER_STATUSES = ["received", "preparing", "ready_for_pickup", "out_for_delivery"] as const;

/** The note that marks an edit in `order_events`; the live board reads it back. */
export const ORDER_EDIT_EVENT_PREFIX = "Edited at the till";

/**
 * Why an order cannot be changed at the till, or null when it can.
 *
 * Only orders still owed at the store are editable. A card payment taken
 * online, or a gift card that has paid part of the bill, would have to move
 * money to follow an edit — a refund or a second charge — and that is a
 * decision for a person in History, not a side effect of changing a pizza.
 */
export function orderEditRefusal(order: {
  status?: unknown;
  payment_method?: unknown;
  payment_status?: unknown;
  gift_card_applied_cents?: unknown;
}): string | null {
  const status = String(order.status ?? "");
  if (status === "completed") return "This order is already completed, so it can no longer be edited. Ring in a new order instead.";
  if (status === "cancelled") return "This order was cancelled, so it cannot be edited.";
  if (!(EDITABLE_ORDER_STATUSES as readonly string[]).includes(status)) {
    return "This order is still waiting for its online payment, so it cannot be edited yet.";
  }
  if (order.payment_method !== "pay_at_store" || order.payment_status !== "pending_at_store") {
    return "This order was paid online by card. Refund or cancel it from History and ring in a new order instead.";
  }
  if (Number(order.gift_card_applied_cents ?? 0) > 0) {
    return "A gift card paid part of this order, so it cannot be edited. Cancel it and ring in a new order instead.";
  }
  return null;
}
