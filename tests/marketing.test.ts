import assert from "node:assert/strict";
import test from "node:test";

import { isConfirmedOnlinePurchase } from "@/lib/marketing";

test("recognizes only an explicitly paid hosted Clover order as a Purchase", () => {
  assert.equal(isConfirmedOnlinePurchase({ status: "received", paymentStatus: "paid" }), true);
  assert.equal(isConfirmedOnlinePurchase({ status: "preparing", paymentStatus: "paid" }), true);

  assert.equal(isConfirmedOnlinePurchase({ status: "received", paymentStatus: "awaiting_checkout" }), false);
  assert.equal(isConfirmedOnlinePurchase({ status: "received", paymentStatus: "pending_at_store" }), false);
  assert.equal(isConfirmedOnlinePurchase({ status: "awaiting_payment", paymentStatus: "paid" }), false);
  assert.equal(isConfirmedOnlinePurchase({ status: "cancelled", paymentStatus: "paid" }), false);
  assert.equal(isConfirmedOnlinePurchase({ status: "completed", paymentStatus: "refunded" }), false);
  assert.equal(isConfirmedOnlinePurchase(undefined), false);
});
