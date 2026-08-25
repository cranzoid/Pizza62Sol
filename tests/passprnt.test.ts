import assert from "node:assert/strict";
import test from "node:test";

import { buildPassPrntTicketHtml, buildPassPrntUri, shouldUsePassPrnt } from "@/lib/passprnt";

const order: Record<string, unknown> = {
  order_number: "P62-123",
  fulfilment: "pickup",
  schedule_type: "asap",
  created_at: Date.UTC(2026, 7, 26, 17, 30),
  customer_name: '<script>alert("drawer")</script>',
  customer_phone: "905-555-0177",
  channel: "walk_in",
  payment_method: "pay_at_store",
  payment_status: "pending_at_store",
  subtotal_cents: 3_600,
  discount_cents: 0,
  tax_cents: 468,
  delivery_fee_cents: 0,
  tip_cents: 0,
  total_cents: 4_068,
  instructions: "Keep & label <carefully>",
  items: [
    {
      id: "line-1",
      productName: "Large Pizza",
      variationName: "Three toppings",
      quantity: 1,
      instructions: "Cut into squares",
      snapshot: {
        halal: true,
        extraCheese: true,
        toppings: [
          { toppingId: "pepperoni", placement: "left" },
          { toppingId: "mushrooms", placement: "right" },
        ],
      },
    },
  ],
};

const toppingNames = new Map([
  ["pepperoni", "Pepperoni"],
  ["mushrooms", "Mushrooms"],
]);

test("builds a self-contained, escaped 576-dot PassPRNT ticket", () => {
  const html = buildPassPrntTicketHtml(order, toppingNames, Date.UTC(2026, 7, 26, 17, 31));

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /width:576px/);
  assert.match(html, /#123/);
  assert.match(html, /LARGE PIZZA/i);
  assert.match(html, /LEFT HALF[\s\S]*Pepperoni/i);
  assert.match(html, /RIGHT HALF[\s\S]*Mushrooms/i);
  assert.match(html, /EXTRA CHEESE/);
  assert.match(html, /&lt;script&gt;alert\(&quot;drawer&quot;\)&lt;\/script&gt;/);
  assert.match(html, /Keep &amp; label &lt;carefully&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("keeps the drawer closed for ordinary and card printing", () => {
  const uri = buildPassPrntUri({
    order,
    toppingNames,
    printedAt: Date.UTC(2026, 7, 26, 17, 31),
    callbackUrl: "https://pizza62.ca/kitchen?screen=orders",
    openDrawer: false,
  });
  const parsed = new URL(uri);

  assert.equal(parsed.protocol, "starpassprnt:");
  assert.equal(parsed.host, "v1");
  assert.equal(parsed.pathname, "/print/nopreview");
  assert.equal(parsed.searchParams.get("size"), "576");
  assert.equal(parsed.searchParams.get("cut"), "partial");
  assert.equal(parsed.searchParams.get("drawer"), "off");
  assert.equal(parsed.searchParams.get("drawerpulse"), "200");
  assert.equal(parsed.searchParams.get("popup"), "enable");
  assert.equal(parsed.searchParams.get("back"), "https://pizza62.ca/kitchen?screen=orders");
  assert.match(parsed.searchParams.get("html") ?? "", /#123/);
});

test("opens the printer-driven drawer only for the explicit cash action", () => {
  const uri = buildPassPrntUri({
    order,
    toppingNames,
    printedAt: Date.UTC(2026, 7, 26, 17, 31),
    callbackUrl: "https://pizza62.ca/kitchen",
    openDrawer: true,
  });

  assert.equal(new URL(uri).searchParams.get("drawer"), "after");
});

test("selects PassPRNT for the Samsung Android till and preserves desktop fallback", () => {
  assert.equal(shouldUsePassPrnt("Mozilla/5.0 (Linux; Android 15; SM-X710) AppleWebKit/537.36"), true);
  assert.equal(shouldUsePassPrnt("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), false);
});
