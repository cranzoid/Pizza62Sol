/**
 * Admin → Gift cards.
 *
 * Search, the ledger, the outstanding liability, and the four things staff need
 * to be able to do to a card: issue one, adjust a balance, void one, and
 * void-and-reissue when a customer has lost their code.
 *
 * **There is no "show me the code".** There cannot be — `gift_cards` holds a
 * SHA-256 digest and nothing else, so no screen and no database dump can produce
 * a spendable number. That is the point, and void-and-reissue is the consequence:
 * a lost card is cancelled and its remaining balance is minted onto a new one,
 * which is better practice anyway because the lost code dies with it.
 *
 * Issuing a free promotional card is **owner-only**, deliberately tighter than
 * the `manage_gift_cards` permission that covers everything else here. Every
 * other action on this screen moves money that a customer already paid for;
 * issuing creates money out of nothing, and that is the owner's decision.
 */
import { AuthError, authErrorResponse, requireStaff } from "@/lib/auth";
import { ensureDatabase, getD1, writeAudit } from "@/db/runtime";
import { hasPermission } from "@/lib/domain";
import { GIFT_CARD_MAX_CENTS, GIFT_CARD_MIN_CENTS, normalizeGiftCardCode } from "@/lib/gift-cards";
import {
  giftCardLiability,
  loadGiftCard,
  loadGiftCardLedger,
  lookupGiftCard,
  mintGiftCard,
  type GiftCardRow,
} from "@/lib/gift-card-store";
import { logFailure } from "@/lib/log";

const CARD_COLUMNS = `id, code_suffix, initial_cents, balance_cents, currency, status, origin,
                      purchase_id, recipient_name, recipient_email, sender_name, message,
                      expires_at, issued_at, created_at, updated_at`;

/** `manage_gift_cards` for everything; owner for creating value from nothing. */
async function requireGiftCardStaff(request: Request, mustBeOwner = false) {
  const user = await requireStaff(request, "view_orders");
  if (!hasPermission(user.role, user.permissions, "manage_gift_cards")) {
    throw new AuthError(403, "You do not have permission to manage gift cards.");
  }
  if (mustBeOwner && user.role !== "owner") {
    throw new AuthError(403, "Only the owner can issue a promotional gift card.");
  }
  return user;
}

type Body =
  | { action: "issue"; amountCents?: number; recipientName?: string; recipientEmail?: string; note?: string; expiresAt?: number | null }
  | { action: "adjust"; giftCardId?: string; amountCents?: number; note?: string }
  | { action: "void"; giftCardId?: string; note?: string; reissue?: boolean };

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    await requireGiftCardStaff(request);
    const url = new URL(request.url);
    const query = (url.searchParams.get("q") ?? "").trim();
    const cardId = url.searchParams.get("id") ?? "";

    if (cardId) {
      const card = await loadGiftCard(cardId);
      if (!card) return Response.json({ error: "That gift card could not be found." }, { status: 404 });
      return Response.json({ card, ledger: await loadGiftCardLedger(cardId) });
    }

    const liability = await giftCardLiability();
    if (!query) {
      // No search term: the most recent cards, which is what someone opening
      // this screen to answer "did that card go out?" is looking for.
      const recent = await getD1()
        .prepare(`SELECT ${CARD_COLUMNS} FROM gift_cards ORDER BY issued_at DESC LIMIT 25`)
        .all<GiftCardRow>();
      return Response.json({ cards: recent.results, liability });
    }

    // A full code pasted in is looked up by its hash, which is the only exact
    // match available — and is how staff confirm a card a customer is reading
    // out over the phone. Anything else searches the suffix and the recipient.
    const byCode = normalizeGiftCardCode(query) ? await lookupGiftCard(query) : null;
    if (byCode) return Response.json({ cards: [byCode], liability });

    const like = `%${query.toLowerCase()}%`;
    const rows = await getD1()
      .prepare(
        `SELECT ${CARD_COLUMNS} FROM gift_cards
          WHERE LOWER(code_suffix) = LOWER(?)
             OR LOWER(recipient_email) LIKE ?
             OR LOWER(recipient_name) LIKE ?
             OR LOWER(sender_name) LIKE ?
          ORDER BY issued_at DESC LIMIT 25`,
      )
      .bind(query.replace(/[^A-Za-z0-9]/g, "").slice(-4), like, like, like)
      .all<GiftCardRow>();
    return Response.json({ cards: rows.results, liability });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    const reference = logFailure("giftCards.admin.read", error);
    return Response.json({ error: "Gift cards could not be loaded.", reference }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const body = (await request.json()) as Body;
    const user = await requireGiftCardStaff(request, body.action === "issue");

    if (body.action === "issue") {
      const amountCents = Math.round(Number(body.amountCents));
      if (!Number.isSafeInteger(amountCents) || amountCents < GIFT_CARD_MIN_CENTS || amountCents > GIFT_CARD_MAX_CENTS) {
        return Response.json({ error: "Enter an amount between $10 and $200." }, { status: 400 });
      }
      const recipientEmail = String(body.recipientEmail ?? "").trim().toLowerCase();
      const recipientName = String(body.recipientName ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail) || recipientName.length < 2) {
        return Response.json({ error: "Enter the recipient's name and a valid email address." }, { status: 400 });
      }
      const note = String(body.note ?? "").trim().slice(0, 200);
      if (note.length < 2) {
        return Response.json({ error: "Say why this card is being issued — it goes in the audit trail." }, { status: 400 });
      }
      // A promotional card *may* expire, unlike one somebody paid for. The
      // database refuses an expiry on a purchased card outright, so this is the
      // only place the column is ever set.
      const expiresAt = Number.isSafeInteger(Number(body.expiresAt)) && Number(body.expiresAt) > Date.now()
        ? Number(body.expiresAt)
        : null;

      const card = await mintGiftCard({
        amountCents,
        origin: "staff_issue",
        recipientName,
        recipientEmail,
        senderName: "Pizza 62",
        message: null,
        expiresAt,
        actorType: "staff",
        actorId: user.id,
        note,
      });
      await queueDelivery(card.id, card.code, recipientEmail);
      await writeAudit({
        actorId: user.id,
        action: "giftCard.issue",
        targetType: "gift_card",
        targetId: card.id,
        next: { amountCents, recipientEmail, suffix: card.suffix, expiresAt },
        reason: note,
      });
      // The suffix, never the code. It has already gone to the outbox, and
      // returning it here would put a spendable number in a staff browser's
      // memory and in whatever logs sit between.
      return Response.json({ ok: true, suffix: card.suffix });
    }

    if (body.action === "adjust") {
      const card = await loadGiftCard(String(body.giftCardId ?? ""));
      if (!card) return Response.json({ error: "That gift card could not be found." }, { status: 404 });
      if (card.status !== "active") {
        return Response.json({ error: "That card is voided, so its balance cannot be changed." }, { status: 409 });
      }
      const amountCents = Math.round(Number(body.amountCents));
      if (!Number.isSafeInteger(amountCents) || amountCents === 0) {
        return Response.json({ error: "Enter the amount to add or take off." }, { status: 400 });
      }
      const note = String(body.note ?? "").trim().slice(0, 200);
      if (note.length < 2) {
        return Response.json({ error: "Say why this balance is being changed." }, { status: 400 });
      }
      const nextBalance = Number(card.balance_cents) + amountCents;
      if (nextBalance < 0) {
        return Response.json({ error: "That would take the balance below zero." }, { status: 400 });
      }
      if (nextBalance > GIFT_CARD_MAX_CENTS * 5) {
        return Response.json({ error: "That balance is implausibly large — check the amount." }, { status: 400 });
      }
      const now = Date.now();
      await getD1().batch([
        // Guarded on the balance we read, so an adjustment cannot silently
        // overwrite a redemption that landed in between.
        getD1()
          .prepare(
            "UPDATE gift_cards SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ? AND status = 'active' AND balance_cents = ?",
          )
          .bind(amountCents, now, card.id, card.balance_cents),
        getD1()
          .prepare(
            `INSERT INTO gift_card_transactions
             (id, gift_card_id, type, amount_cents, balance_after_cents, order_id, actor_type, actor_id, note, created_at)
             VALUES (?, ?, 'adjust', ?, (SELECT balance_cents FROM gift_cards WHERE id = ?), NULL, 'staff', ?, ?, ?)`,
          )
          .bind(crypto.randomUUID(), card.id, amountCents, card.id, user.id, note, now),
      ]);
      const updated = await loadGiftCard(card.id);
      if (Number(updated?.balance_cents) !== nextBalance) {
        return Response.json(
          { error: "That card's balance changed while you were looking at it. Reload and try again." },
          { status: 409 },
        );
      }
      await writeAudit({
        actorId: user.id,
        action: "giftCard.adjust",
        targetType: "gift_card",
        targetId: card.id,
        previous: { balanceCents: card.balance_cents },
        next: { balanceCents: nextBalance },
        reason: note,
      });
      return Response.json({ ok: true, balanceCents: nextBalance });
    }

    if (body.action === "void") {
      const card = await loadGiftCard(String(body.giftCardId ?? ""));
      if (!card) return Response.json({ error: "That gift card could not be found." }, { status: 404 });
      if (card.status !== "active") return Response.json({ error: "That card is already voided." }, { status: 409 });
      const note = String(body.note ?? "").trim().slice(0, 200);
      if (note.length < 2) {
        return Response.json({ error: "Say why this card is being voided." }, { status: 400 });
      }
      const remaining = Number(card.balance_cents);
      const now = Date.now();
      await getD1().batch([
        // Zeroing the balance as well as flipping the status is what actually
        // stops it being spent: `holdGiftCardStatements` filters on
        // `status = 'active'`, but a voided card with a balance still on it
        // makes the liability total wrong, and the liability total is the number
        // the bookkeeper uses.
        getD1()
          .prepare(
            "UPDATE gift_cards SET status = 'voided', balance_cents = 0, updated_at = ? WHERE id = ? AND status = 'active' AND balance_cents = ?",
          )
          .bind(now, card.id, card.balance_cents),
        getD1()
          .prepare(
            `INSERT INTO gift_card_transactions
             (id, gift_card_id, type, amount_cents, balance_after_cents, order_id, actor_type, actor_id, note, created_at)
             VALUES (?, ?, 'void', ?, 0, NULL, 'staff', ?, ?, ?)`,
          )
          .bind(crypto.randomUUID(), card.id, -remaining, user.id, note, now),
      ]);
      const voided = await loadGiftCard(card.id);
      if (voided?.status !== "voided") {
        return Response.json(
          { error: "That card changed while you were looking at it. Reload and try again." },
          { status: 409 },
        );
      }

      /**
       * Void and reissue — the answer to "I have lost my code".
       *
       * The old card dies with its code, which is the security property worth
       * having: whoever found the lost email cannot spend it either. The
       * remaining balance is minted onto a brand-new card and emailed to the
       * same address, with the two linked in each other's ledger notes so the
       * trail can be followed in either direction.
       */
      let reissuedSuffix: string | null = null;
      if (body.reissue && remaining > 0) {
        const replacement = await mintGiftCard({
          amountCents: remaining,
          origin: "staff_issue",
          recipientName: card.recipient_name,
          recipientEmail: card.recipient_email,
          senderName: card.sender_name,
          message: card.message,
          // Still no expiry: this is the same money the customer paid for, only
          // on a new number, so the purchased-card rule follows it across.
          expiresAt: null,
          actorType: "staff",
          actorId: user.id,
          note: `Reissued from card ending ${card.code_suffix}`,
        });
        reissuedSuffix = replacement.suffix;
        await getD1()
          .prepare(
            `INSERT INTO gift_card_transactions
             (id, gift_card_id, type, amount_cents, balance_after_cents, order_id, actor_type, actor_id, note, created_at)
             VALUES (?, ?, 'void', 0, 0, NULL, 'staff', ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            card.id,
            user.id,
            `Balance moved to replacement card ending ${replacement.suffix}`,
            Date.now(),
          )
          .run();
        await queueDelivery(replacement.id, replacement.code, card.recipient_email);
      }

      await writeAudit({
        actorId: user.id,
        action: body.reissue ? "giftCard.voidAndReissue" : "giftCard.void",
        targetType: "gift_card",
        targetId: card.id,
        previous: { balanceCents: remaining, status: "active" },
        next: { status: "voided", reissuedSuffix },
        reason: note,
      });
      return Response.json({ ok: true, reissuedSuffix });
    }

    return Response.json({ error: "Unsupported action." }, { status: 400 });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    const reference = logFailure("giftCards.admin.write", error);
    return Response.json({ error: "That gift card action could not be completed.", reference }, { status: 500 });
  }
}

/**
 * Puts a freshly minted card in the outbox.
 *
 * The same row shape the purchase path writes, and for the same reason: the
 * plaintext code exists for exactly as long as it takes to get from `mintGiftCard`
 * into this payload, and the dispatcher scrubs it on send.
 *
 * `giftCardPurchaseId` is deliberately absent — a staff-issued card has no sale
 * behind it — so the delivery renderer reads the card row instead. See the
 * dispatcher's `gift_card_delivery` case.
 */
async function queueDelivery(giftCardId: string, code: string, recipientEmail: string): Promise<void> {
  const { anyProviderConfigured } = await import("@/lib/notifications/config");
  const { dispatchSoon } = await import("@/lib/notifications/dispatcher");
  const now = Date.now();
  await getD1()
    .prepare(
      `INSERT INTO notification_outbox
       (id, kind, recipient, payload_json, status, attempt_count, scheduled_for, created_at, updated_at)
       VALUES (?, 'gift_card_delivery', ?, ?, ?, 0, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      recipientEmail,
      JSON.stringify({ giftCardId, code }),
      (await anyProviderConfigured()) ? "pending" : "pending_provider_setup",
      now,
      now,
      now,
    )
    .run();
  dispatchSoon();
}
