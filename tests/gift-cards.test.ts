/**
 * Gift cards, through the real code paths.
 *
 * The two things worth testing here are not the same thing:
 *
 * 1. **A gift card is a tender, not a discount.** The regression that matters
 *    most is HST. A $25 card on a $30 order must leave `tax_cents` byte-identical
 *    to the same order with no card — because in Canada a gift card sale is not
 *    a taxable supply, so the tax is charged in full on the food when the card
 *    is *spent*. Folding a redemption into the discount would under-collect HST
 *    on every order a card ever touched, and would do it silently.
 *
 * 2. **Every hold is resolved.** A hold with neither a capture nor a release is
 *    a customer who has permanently lost money, so each of the three paths that
 *    can end an unpaid order is exercised and the balance is asserted whole
 *    afterwards.
 *
 * These go through `createOrder`, `applyPaymentApproved` and `reapStalePayments`
 * themselves rather than re-implementing their SQL, because the bugs this is
 * guarding against live in the interaction between them.
 *
 * Requires a reachable Postgres; skipped otherwise, like the driver suite.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.PGSSLMODE ??= "disable";
process.env.DATABASE_URL ??= "postgres://localhost:5432/pizza62_test";

const { getPool, closePool, PostgresDatabase } = await import("@/db/pg-driver");
const { createOrder, quoteOrder, OrderValidationError } = await import("@/lib/order-service");
const { applyPaymentApproved } = await import("@/lib/payment-completion");
const { mintGiftCard, lookupGiftCard } = await import("@/lib/gift-card-store");
const {
  generateGiftCardCode,
  normalizeGiftCardCode,
  giftCardAmountError,
  parseGiftCardAmountCents,
  evaluateGiftCard,
} = await import("@/lib/gift-cards");
const { reapStalePayments } = await import("@/scripts/reap-payments");
const { nextOrderSlots } = await import("@/lib/domain");
const { getD1 } = await import("@/db/runtime");
const { clearIntegrationSecretCache } = await import("@/lib/integration-secrets");

/**
 * Clover, stubbed.
 *
 * The hold/capture/release tests need an order that reaches `awaiting_payment`,
 * and only an online order does that. The alternative — letting the real call
 * fail — would exercise the *failure* path on every one of them, which is a
 * different test and would hide the ones written here.
 *
 * Credentials go through lib/integration-secrets, which caches its database
 * lookup for thirty seconds, so setting them is always paired with a cache clear.
 */
const realFetch = globalThis.fetch;

function stubClover(): void {
  process.env.CLOVER_MERCHANT_ID = "TESTMERCHANT123";
  process.env.CLOVER_API_TOKEN = "test-private-token";
  clearIntegrationSecretCache();
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        href: "https://checkout.clover.test/session/abc",
        checkoutSessionId: `sess-${crypto.randomUUID()}`,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

function restoreClover(): void {
  globalThis.fetch = realFetch;
  delete process.env.CLOVER_MERCHANT_ID;
  delete process.env.CLOVER_API_TOKEN;
  clearIntegrationSecretCache();
}

/** An online order, which is the only kind that waits on a payment. */
async function onlineOrder(overrides: Record<string, unknown>) {
  stubClover();
  try {
    return await createOrder(await orderBody({ paymentMethod: "online", ...overrides }));
  } finally {
    restoreClover();
  }
}

const reachable = await getPool()
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

after(async () => {
  await closePool();
});

const withDb = (name: string, body: () => Promise<void>) =>
  test(name, { skip: reachable ? false : "Postgres is not reachable" }, body);

const uniqueKey = () => `giftcard-test-${crypto.randomUUID()}-${crypto.randomUUID()}`;

/**
 * The next time the restaurant is open.
 *
 * Orders are validated against the seeded hours, so a hard-coded time would
 * pass or fail depending on the hour the suite ran at.
 */
async function nextOpenSlot(): Promise<number> {
  const { getSetting } = await import("@/db/runtime");
  const hours = await getSetting<Array<{ weekday: number; openMinute: number; closeMinute: number }>>("hours");
  const slots = nextOrderSlots({ now: Date.now(), hours, timeZone: "America/Toronto", leadMinutes: 30, limit: 4 });
  assert.ok(slots.length, "the seeded hours should offer an upcoming slot");
  return slots[0];
}

/**
 * A card with a known balance, plus the plaintext code.
 *
 * `mintGiftCard` returns the code once and it cannot be recovered afterwards —
 * which is the security property under test elsewhere and, here, simply the
 * only way to get a spendable code.
 */
async function freshCard(amountCents: number) {
  return mintGiftCard({
    amountCents,
    origin: "purchase",
    recipientName: "Ada Lovelace",
    recipientEmail: `ada-${crypto.randomUUID().slice(0, 8)}@example.test`,
    senderName: "Charles Babbage",
    actorType: "customer",
  });
}

type OrderBody = Parameters<typeof createOrder>[0];

async function orderBody(overrides: Record<string, unknown> = {}): Promise<OrderBody> {
  return {
    idempotencyKey: uniqueKey(),
    fulfilment: "pickup",
    customer: { name: "Ada Lovelace", phone: "905-555-0142", email: "ada@example.test" },
    items: [{ productId: "poutine", quantity: 2 }],
    schedule: { type: "scheduled", scheduledFor: await nextOpenSlot() },
    paymentMethod: "pay_at_store",
    tip: { type: "none" },
    ...overrides,
  } as OrderBody;
}

async function balanceOf(giftCardId: string): Promise<number> {
  const row = await getD1()
    .prepare("SELECT balance_cents FROM gift_cards WHERE id = ?")
    .bind(giftCardId)
    .first<{ balance_cents: number }>();
  return Number(row?.balance_cents ?? -1);
}

async function ledgerTypes(giftCardId: string): Promise<string[]> {
  const rows = await getD1()
    .prepare("SELECT type FROM gift_card_transactions WHERE gift_card_id = ? ORDER BY created_at, id")
    .bind(giftCardId)
    .all<{ type: string }>();
  return rows.results.map((row) => row.type);
}

async function orderRow(orderId: string) {
  return getD1()
    .prepare(
      `SELECT status, payment_status, total_cents, tax_cents, subtotal_cents, discount_cents,
              gift_card_applied_cents, gift_card_id
       FROM orders WHERE id = ?`,
    )
    .bind(orderId)
    .first<Record<string, number | string | null>>();
}

// --- codes, which are money and must behave like it ---------------------------

test("a generated code round-trips through normalisation", () => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = generateGiftCardCode();
    assert.match(code, /^P62-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const body = normalizeGiftCardCode(code);
    assert.equal(body?.length, 16);
    // Typed by hand, pasted with stray spaces, or shouted down a phone in lower
    // case — all the same card.
    assert.equal(normalizeGiftCardCode(code.toLowerCase()), body);
    assert.equal(normalizeGiftCardCode(code.replaceAll("-", "")), body);
    assert.equal(normalizeGiftCardCode(` ${code} `), body);
  }
});

test("codes avoid the characters people misread", () => {
  const codes = Array.from({ length: 200 }, () => generateGiftCardCode().slice(4).replaceAll("-", "")).join("");
  for (const forbidden of ["0", "O", "1", "I", "L"]) {
    assert.ok(!codes.includes(forbidden), `generated codes must never contain "${forbidden}"`);
  }
});

test("a bare body beginning P62 is not mistaken for a prefix", () => {
  // The failure this guards against: stripping "P62" whenever a code starts
  // with it would mangle a perfectly valid 16-character body into 13.
  const body = "P62QRSTUVWXY2345";
  assert.equal(normalizeGiftCardCode(body), body);
  assert.equal(normalizeGiftCardCode(`P62-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12)}`), body);
});

test("obvious rubbish is refused without a database read", () => {
  assert.equal(normalizeGiftCardCode(""), null);
  assert.equal(normalizeGiftCardCode("P62-0000-0000-0000-0000"), null, "0 is not in the alphabet");
  assert.equal(normalizeGiftCardCode("too short"), null);
  assert.equal(normalizeGiftCardCode(null), null);
  assert.equal(normalizeGiftCardCode(42), null);
});

test("amounts outside what we sell are named, not silently clamped", () => {
  assert.equal(giftCardAmountError(parseGiftCardAmountCents("25")), null);
  assert.equal(giftCardAmountError(parseGiftCardAmountCents("25.50")), null);
  assert.match(String(giftCardAmountError(parseGiftCardAmountCents("5"))), /smallest/);
  assert.match(String(giftCardAmountError(parseGiftCardAmountCents("500"))), /largest/);
  assert.match(String(giftCardAmountError(parseGiftCardAmountCents("banana"))), /Enter an amount/);
});

test("the arithmetic never applies more than the card holds or the bill costs", () => {
  const card = { id: "x", codeSuffix: "NPQR", balanceCents: 5_000, status: "active", expiresAt: null };
  assert.equal(evaluateGiftCard(card, 3_427).appliedCents, 3_427, "a big card pays the whole bill");
  assert.equal(evaluateGiftCard(card, 3_427).remainingAfterCents, 1_573);
  assert.equal(evaluateGiftCard(card, 9_999).appliedCents, 5_000, "a small card pays what it has");
  assert.equal(evaluateGiftCard(card, 9_999).remainingAfterCents, 0);
  assert.equal(evaluateGiftCard({ ...card, status: "voided" }, 3_427).accepted, false);
  assert.equal(evaluateGiftCard({ ...card, balanceCents: 0 }, 3_427).accepted, false);
  assert.equal(evaluateGiftCard({ ...card, expiresAt: Date.now() - 1 }, 3_427).accepted, false);
});

// --- the regression that matters most -----------------------------------------

withDb("a gift card is a tender, not a discount: HST is identical either way", async () => {
  const withoutCard = await createOrder(await orderBody());
  const plain = await orderRow(String(withoutCard.orderId));
  // Deliberately smaller than the bill, so this is a partial redemption and the
  // tax base is genuinely being checked against a card that moved money.
  const cardCents = Math.floor(Number(plain?.total_cents) / 2);
  const card = await freshCard(cardCents);
  const withCard = await createOrder(await orderBody({ giftCardCode: card.code }));
  const carded = await orderRow(String(withCard.orderId));

  assert.equal(
    Number(carded?.tax_cents),
    Number(plain?.tax_cents),
    "HST must be charged on the food in full — a gift card pays the bill, it does not reduce it",
  );
  assert.equal(Number(carded?.subtotal_cents), Number(plain?.subtotal_cents));
  assert.equal(Number(carded?.discount_cents), Number(plain?.discount_cents), "a redemption is never a discount");
  assert.equal(Number(carded?.total_cents), Number(plain?.total_cents), "the bill itself is unchanged");
  assert.equal(Number(carded?.gift_card_applied_cents), cardCents);
  assert.equal(carded?.gift_card_id, card.id);
});

withDb("the payment row records what was charged, not what the order cost", async () => {
  const card = await freshCard(1_000);
  const order = await createOrder(await orderBody({ giftCardCode: card.code, items: [{ productId: "poutine", quantity: 3 }] }));
  const row = await orderRow(String(order.orderId));
  const payment = await getD1()
    .prepare("SELECT amount_cents, provider, status FROM payments WHERE order_id = ?")
    .bind(String(order.orderId))
    .first<{ amount_cents: number; provider: string; status: string }>();

  // This is what keeps the existing refund ceiling honest: you can only refund
  // to a card what actually went onto it.
  assert.equal(
    Number(payment?.amount_cents),
    Number(row?.total_cents) - 1_000,
    "payments.amount_cents is the amount due, so a refund cannot exceed what the card paid",
  );
});

// --- quoting -------------------------------------------------------------------

withDb("the quote reports the balance, what it pays and what is left", async () => {
  const card = await freshCard(5_000);
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [{ productId: "poutine", quantity: 2 }],
    giftCardCode: card.code,
  });
  assert.equal(quote.giftCard?.accepted, true);
  assert.equal(quote.giftCard?.balanceCents, 5_000);
  assert.equal(quote.giftCard?.appliedCents, quote.totals.giftCardAppliedCents);
  assert.equal(
    quote.giftCard?.remainingAfterCents,
    5_000 - quote.totals.giftCardAppliedCents,
    "the customer is told what is left for next time",
  );
  assert.equal(quote.totals.amountDueCents, quote.totals.totalCents - quote.totals.giftCardAppliedCents);
  // Read-only: quoting must never reserve money, or every abandoned cart would
  // strand a balance.
  assert.equal(await balanceOf(card.id), 5_000, "a quote takes no hold");
});

withDb("an unknown code is refused without revealing whether it ever existed", async () => {
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [{ productId: "poutine", quantity: 2 }],
    giftCardCode: generateGiftCardCode(),
  });
  assert.equal(quote.giftCard?.accepted, false);
  assert.match(String(quote.giftCard?.message), /could not find that gift card/);
  // Nothing comes off the bill...
  assert.equal(quote.totals.amountDueCents, quote.totals.totalCents);
  // ...and the quote says the order would be refused, rather than enabling a
  // button that `createOrder` is guaranteed to reject. Unlike a coupon, which
  // leaves a placeable order at full price.
  assert.equal(quote.ok, false);
  assert.ok(
    quote.issues.some((issue) => issue.code === "GIFT_CARD_UNAVAILABLE"),
    "the refusal is reported as a blocking issue so the checkout can disable the button",
  );
});

withDb("a voided card is refused at the quote and at creation", async () => {
  const card = await freshCard(5_000);
  await getD1()
    .prepare("UPDATE gift_cards SET status = 'voided', balance_cents = 0 WHERE id = ?")
    .bind(card.id)
    .run();

  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [{ productId: "poutine", quantity: 2 }],
    giftCardCode: card.code,
  });
  assert.equal(quote.giftCard?.accepted, false);

  const attempt = await orderBody({ giftCardCode: card.code });
  await assert.rejects(
    () => createOrder(attempt),
    (error: unknown) => error instanceof OrderValidationError,
    "createOrder must refuse rather than quietly charge full price",
  );
});

// --- partial redemption across several orders ---------------------------------

withDb("a balance is spent down across orders and then refused", async () => {
  const card = await freshCard(2_000);

  const first = await createOrder(await orderBody({ giftCardCode: card.code, items: [{ productId: "poutine", quantity: 1 }] }));
  const firstApplied = Number((await orderRow(String(first.orderId)))?.gift_card_applied_cents);
  assert.ok(firstApplied > 0 && firstApplied < 2_000, "one poutine should not exhaust a $20 card");
  assert.equal(await balanceOf(card.id), 2_000 - firstApplied);

  // The remainder, on an order big enough to swallow it.
  const second = await createOrder(await orderBody({ giftCardCode: card.code, items: [{ productId: "poutine", quantity: 4 }] }));
  assert.equal(Number((await orderRow(String(second.orderId)))?.gift_card_applied_cents), 2_000 - firstApplied);
  assert.equal(await balanceOf(card.id), 0);

  // And a third is refused, because there is nothing left.
  const third = await orderBody({ giftCardCode: card.code });
  await assert.rejects(
    () => createOrder(third),
    (error: unknown) => error instanceof OrderValidationError && /no balance left/.test(error.message),
  );
});

// --- the three places a hold must be resolved ---------------------------------

withDb("hold then capture: an approved payment spends the balance for good", async () => {
  const card = await freshCard(1_000);
  const order = await onlineOrder({ giftCardCode: card.code });
  // Online and not fully covered, so it waits for Clover with the hold taken.
  assert.equal(await balanceOf(card.id), 0, "the hold is taken inside the order's own transaction");
  assert.deepEqual(await ledgerTypes(card.id), ["issue", "hold"]);

  await applyPaymentApproved({ orderId: String(order.orderId), note: "test capture" });

  assert.equal(await balanceOf(card.id), 0, "capture moves no money — the hold already did");
  assert.deepEqual(await ledgerTypes(card.id), ["issue", "hold", "capture"]);

  // Idempotent: Clover redelivers webhooks, and a second capture must not write
  // a second row or move the balance.
  await applyPaymentApproved({ orderId: String(order.orderId), note: "redelivered" });
  assert.deepEqual(await ledgerTypes(card.id), ["issue", "hold", "capture"]);
  assert.equal(await balanceOf(card.id), 0);
});

withDb("hold then release: the reaper gives an abandoned checkout's balance back", async () => {
  const card = await freshCard(1_000);
  const order = await onlineOrder({ giftCardCode: card.code });
  assert.equal(await balanceOf(card.id), 0);

  // Age the order past the reaper's cutoff rather than waiting twenty minutes.
  await getD1()
    .prepare("UPDATE orders SET created_at = ? WHERE id = ?")
    .bind(Date.now() - 30 * 60_000, String(order.orderId))
    .run();
  await reapStalePayments(new PostgresDatabase(getPool()));

  assert.equal(await balanceOf(card.id), 1_000, "the customer's money comes back in full");
  assert.deepEqual(await ledgerTypes(card.id), ["issue", "hold", "release"]);

  // Running again must not credit the card a second time.
  await reapStalePayments(new PostgresDatabase(getPool()));
  assert.equal(await balanceOf(card.id), 1_000);
  assert.deepEqual(await ledgerTypes(card.id), ["issue", "hold", "release"]);
});

withDb("a captured hold is never released, even if the order is later cancelled", async () => {
  const card = await freshCard(1_000);
  const order = await onlineOrder({ giftCardCode: card.code });
  await applyPaymentApproved({ orderId: String(order.orderId), note: "paid" });

  // The reaper only touches `awaiting_payment`, but the release statements are
  // written to be safe to call on anything — because the staff cancel path does.
  const { releaseGiftCardStatements } = await import("@/lib/gift-card-store");
  await getD1().batch(
    releaseGiftCardStatements({
      orderId: String(order.orderId),
      actorType: "staff",
      note: "cancelled after payment",
      now: Date.now(),
    }),
  );

  assert.equal(
    await balanceOf(card.id),
    0,
    "money that was genuinely spent stays spent — putting it back is a refund, and a refund is a decision for a person",
  );
  assert.deepEqual(await ledgerTypes(card.id), ["issue", "hold", "capture"]);
});

// --- full coverage --------------------------------------------------------------

withDb("a card that covers the bill produces a live order and never calls Clover", async () => {
  const card = await freshCard(20_000);
  const order = await onlineOrder({ giftCardCode: card.code });

  const row = await orderRow(String(order.orderId));
  assert.equal(row?.status, "received", "there is nothing to wait for, so the kitchen gets it now");
  assert.equal(row?.payment_status, "paid");
  assert.equal(Number(row?.gift_card_applied_cents), Number(row?.total_cents));
  assert.equal((order as { amountDueCents?: number }).amountDueCents, 0);
  assert.ok(!("checkoutUrl" in order), "no hosted checkout session is created for a zero charge");

  const payment = await getD1()
    .prepare("SELECT provider, status, amount_cents, method FROM payments WHERE order_id = ?")
    .bind(String(order.orderId))
    .first<{ provider: string; status: string; amount_cents: number; method: string }>();
  // The row exists so the reconciliation trail is unbroken, at the amount
  // actually charged, which is nothing.
  assert.equal(payment?.provider, "gift_card");
  assert.equal(payment?.status, "captured");
  assert.equal(Number(payment?.amount_cents), 0);

  // The hold is resolved inside the same batch, because this order never passes
  // through `applyPaymentApproved`.
  assert.deepEqual(await ledgerTypes(card.id), ["issue", "hold", "capture"]);

  // Its confirmation and kitchen alert are released rather than parked waiting
  // for a payment that already happened.
  const parked = await getD1()
    .prepare(
      "SELECT COUNT(*)::int AS parked FROM notification_outbox WHERE status = 'waiting_payment' AND payload_json::jsonb->>'orderId' = ?",
    )
    .bind(String(order.orderId))
    .first<{ parked: number }>();
  assert.equal(Number(parked?.parked), 0, "nothing should be waiting on a payment that is already done");
});

withDb("a pay-at-store order captures its hold immediately", async () => {
  const card = await freshCard(1_000);
  const order = await createOrder(await orderBody({ giftCardCode: card.code, paymentMethod: "pay_at_store" }));
  // Never passes through `applyPaymentApproved`, so a hold left open here would
  // be open forever.
  assert.deepEqual(await ledgerTypes(card.id), ["issue", "hold", "capture"]);
  assert.equal(String((await orderRow(String(order.orderId)))?.status), "received");
});

// --- concurrency -----------------------------------------------------------------

withDb("two orders racing for one balance: exactly one wins and it never goes negative", async () => {
  // A card that can pay for one of these orders but not both.
  const single = await createOrder(await orderBody({ items: [{ productId: "poutine", quantity: 1 }] }));
  const oneOrderCents = Number((await orderRow(String(single.orderId)))?.total_cents);
  const card = await freshCard(oneOrderCents);

  const results = await Promise.allSettled([
    createOrder(await orderBody({ giftCardCode: card.code, items: [{ productId: "poutine", quantity: 1 }] })),
    createOrder(await orderBody({ giftCardCode: card.code, items: [{ productId: "poutine", quantity: 1 }] })),
  ]);
  const won = results.filter((result) => result.status === "fulfilled");

  assert.equal(won.length, 1, "exactly one order may take the last dollar");
  assert.equal(await balanceOf(card.id), 0, "the balance never goes negative");

  // And the loser left nothing behind: the constraint aborts the whole batch, so
  // there is no half-created order holding money that was never taken.
  const holds = (await ledgerTypes(card.id)).filter((type) => type === "hold");
  assert.equal(holds.length, 1, "the losing transaction rolled back its ledger row too");
});

// --- consent ----------------------------------------------------------------------

withDb("a total that grew since the review screen is refused rather than charged", async () => {
  const card = await freshCard(5_000);
  const quote = await quoteOrder({
    fulfilment: "pickup",
    items: [{ productId: "poutine", quantity: 2 }],
    giftCardCode: card.code,
  });
  const stale = await orderBody({
    giftCardCode: card.code,
    items: [{ productId: "poutine", quantity: 2 }],
    // The browser saying "I showed the customer a dollar less than this".
    expectedAmountDueCents: quote.totals.amountDueCents - 100,
  });
  await assert.rejects(
    () => createOrder(stale),
    (error: unknown) => error instanceof OrderValidationError && error.code === "TOTAL_CHANGED",
  );
  // Nothing was reserved by the attempt.
  assert.equal(await balanceOf(card.id), 5_000);
});

// --- storage --------------------------------------------------------------------

withDb("no spendable code is stored anywhere", async () => {
  const card = await freshCard(2_500);
  const body = normalizeGiftCardCode(card.code);
  assert.ok(body);

  const row = await getD1()
    .prepare("SELECT code_hash, code_suffix FROM gift_cards WHERE id = ?")
    .bind(card.id)
    .first<{ code_hash: string; code_suffix: string }>();
  assert.match(String(row?.code_hash), /^[0-9a-f]{64}$/, "the code is stored as a SHA-256 digest");
  assert.ok(!String(row?.code_hash).includes(body!), "the digest must not contain the code");
  assert.equal(row?.code_suffix, body!.slice(-4), "only the last four characters are kept in clear");

  // And the digest is the only way back to the card.
  const found = await lookupGiftCard(card.code);
  assert.equal(found?.id, card.id);
  assert.equal(await lookupGiftCard(generateGiftCardCode()), null);
});

withDb("a purchased card can never be given an expiry date", async () => {
  // Ontario's Consumer Protection Act, as a database constraint rather than a
  // convention someone has to remember.
  await assert.rejects(
    () =>
      getD1()
        .prepare(
          `INSERT INTO gift_cards
           (id, code_hash, code_suffix, initial_cents, balance_cents, currency, status, origin,
            recipient_name, recipient_email, sender_name, expires_at, issued_at, created_at, updated_at)
           VALUES (?, ?, 'ABCD', 1000, 1000, 'CAD', 'active', 'purchase', 'A', 'a@example.test', 'B', ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), crypto.randomUUID(), Date.now() + 86_400_000, Date.now(), Date.now(), Date.now())
        .run(),
    /gift_cards_purchase_never_expires/,
  );
});
