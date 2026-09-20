/**
 * Gift cards, as arithmetic and as strings. Nothing here touches the database.
 *
 * ## The decision everything else follows from
 *
 * **A gift card is a tender, not a discount.** It pays a bill; it does not
 * reduce one. `applyPromotions` in lib/domain.ts takes money *off* the taxable
 * food subtotal, which is exactly what must not happen here: in Canada the sale
 * of a gift card is not a taxable supply, so no HST is charged when the card is
 * bought, and HST is charged in full when the card is *spent*, on the food. The
 * card then pays part of that tax-inclusive total.
 *
 * So redemption sits one layer outside `priceCart`, which is left completely
 * untouched:
 *
 *     totalCents              (from priceCart — unchanged, HST and tip included)
 *   − giftCardAppliedCents    = min(balance, totalCents)
 *   = amountDueCents          → what Clover charges, and what `payments` records
 *
 * Because `payments.amount_cents` becomes the amount actually charged to the
 * card, the existing refund ceiling keeps working untouched: you can only refund
 * to a card what went onto it.
 *
 * ## Why this file is pure
 *
 * The checkout, the till and the purchase page all need the presets, the limits
 * and the code format, and they run in the browser. The database half lives in
 * `lib/gift-card-store.ts` — the same split as `lib/order-presentation.ts`
 * (pure) and `lib/notifications/order-details.ts` (the query).
 */
import { formatMoney, hashOpaqueToken } from "@/lib/domain";

/**
 * The alphabet a code is drawn from: 31 characters, with every pair that gets
 * misread out of it — no `0` or `O`, no `1`, `I` or `L`.
 *
 * This is not fussiness. The delivery email is read off a phone and typed into
 * a checkout, or read down a telephone line to whoever is at the counter, and a
 * code that cannot be transcribed is a card that cannot be spent. Sixteen
 * characters from 31 is a little over 79 bits, which is what makes guessing one
 * hopeless even before the balance endpoint's rate limit.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const CODE_LENGTH = 16;
const CODE_PREFIX = "P62";

/** Presets on the purchase page. The custom field is bounded by the pair below. */
export const GIFT_CARD_PRESET_CENTS = [1_500, 2_500, 5_000, 7_500] as const;

/**
 * The floor and the ceiling, enforced server-side as well as in the form.
 *
 * The ceiling is a fraud control before it is a product decision. Buying gift
 * cards with a stolen credit card is the classic cash-out for this feature — the
 * card is the merchandise and it is delivered instantly by email — so the most a
 * single successful fraudulent purchase can be worth is capped here, and the
 * number of attempts is capped by the rate limit on the purchase route.
 */
export const GIFT_CARD_MIN_CENTS = 1_000;
export const GIFT_CARD_MAX_CENTS = 20_000;

/** Personal messages are quoted verbatim into an email; this is the cap. */
export const GIFT_CARD_MESSAGE_MAX = 200;

/** `P62-XXXX-XXXX-XXXX-XXXX` from the 16 bare characters. */
export function formatGiftCardCode(body: string): string {
  return [CODE_PREFIX, ...(body.match(/.{1,4}/g) ?? [body])].join("-");
}

/**
 * A fresh code, unbiased.
 *
 * 31 does not divide 256, so bytes at or above the largest multiple of 31 are
 * thrown away rather than folded in with `%`. Folding would make the first few
 * characters of the alphabet measurably more likely, which is a small bias in a
 * place where the whole security argument is that every code is equally likely.
 */
export function generateGiftCardCode(): string {
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let body = "";
  while (body.length < CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(CODE_LENGTH))) {
      if (byte >= limit) continue;
      body += ALPHABET[byte % ALPHABET.length];
      if (body.length === CODE_LENGTH) break;
    }
  }
  return formatGiftCardCode(body);
}

/**
 * The 16 bare characters, or null if this could not be a code at all.
 *
 * Forgiving about everything that does not change what was meant — case, the
 * dashes, spaces pasted in from an email — and strict about everything else, so
 * a typo is refused here rather than costing a database read. The prefix is only
 * stripped when the length says it is a prefix: a bare body may legitimately
 * begin `P62`, and stripping it then would silently mangle a valid code.
 */
export function normalizeGiftCardCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const stripped = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body =
    stripped.length === CODE_PREFIX.length + CODE_LENGTH && stripped.startsWith(CODE_PREFIX)
      ? stripped.slice(CODE_PREFIX.length)
      : stripped;
  if (body.length !== CODE_LENGTH) return null;
  for (const character of body) {
    if (!ALPHABET.includes(character)) return null;
  }
  return body;
}

/** The last four characters — what staff search on and what the email quotes. */
export function giftCardCodeSuffix(body: string): string {
  return body.slice(-4);
}

/**
 * The stored form of a code.
 *
 * Namespaced, like the rate limiter's keys, so a digest from this table can
 * never be mistaken for — or collide with — a tracking or feedback token.
 * Nothing anywhere stores the code itself: a dump of the database contains no
 * spendable money, which is the whole point, and the price of it is that a lost
 * code cannot be re-sent. Staff void the card and reissue the balance instead.
 */
export function hashGiftCardCode(body: string): Promise<string> {
  return hashOpaqueToken(`giftcard:${body}`);
}

/**
 * Reads an amount a customer typed into cents, or null if it is not a number.
 *
 * Deliberately separate from the range check: "that is not an amount" and "that
 * is outside what we sell" are different things to be told.
 */
export function parseGiftCardAmountCents(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw : "";
  const cleaned = text.replace(/[^0-9.]/g, "");
  if (!cleaned || !/^\d*\.?\d{0,2}$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Null when the amount is sellable; otherwise the sentence to show. */
export function giftCardAmountError(cents: number | null): string | null {
  if (cents === null) return "Enter an amount, like 40 or 40.00.";
  if (cents < GIFT_CARD_MIN_CENTS) {
    return `The smallest gift card we sell is ${formatMoney(GIFT_CARD_MIN_CENTS)}.`;
  }
  if (cents > GIFT_CARD_MAX_CENTS) {
    return `The largest gift card we sell online is ${formatMoney(GIFT_CARD_MAX_CENTS)}. Call us for anything bigger.`;
  }
  return null;
}

/** Everything the redemption arithmetic needs, and nothing that could spend it. */
export type RedeemableGiftCard = {
  id: string;
  codeSuffix: string;
  balanceCents: number;
  status: string;
  expiresAt: number | null;
};

export type GiftCardQuote = {
  /** The last four characters. Never the code. */
  suffix: string;
  accepted: boolean;
  /** Balance before this order. Zero when the card cannot be used. */
  balanceCents: number;
  appliedCents: number;
  remainingAfterCents: number;
  /** Why it was refused, or null when it was not. */
  message: string | null;
};

/** What a card that could not be found — or was never real — comes back as. */
export function unknownGiftCardQuote(suffix: string): GiftCardQuote {
  return {
    suffix,
    accepted: false,
    balanceCents: 0,
    appliedCents: 0,
    remainingAfterCents: 0,
    // One sentence for a code that never existed and for one that did but was
    // mistyped. Saying "no such card" for the first and something else for the
    // second would turn this into an oracle: an attacker guessing codes would
    // learn which guesses were close, and 79 bits of entropy is only worth
    // anything while every wrong answer looks identical.
    message: "We could not find that gift card. Check the code and try again.",
  };
}

/**
 * How much of this bill the card can pay.
 *
 * Read-only and takes no hold: this runs on every keystroke of the checkout's
 * quote, and a hold taken here would strand money on every abandoned cart. The
 * hold is taken once, inside the transaction that creates the order.
 */
export function evaluateGiftCard(
  card: RedeemableGiftCard,
  totalCents: number,
  now: number = Date.now(),
): GiftCardQuote {
  const suffix = card.codeSuffix;
  const refuse = (message: string): GiftCardQuote => ({
    suffix,
    accepted: false,
    balanceCents: Math.max(0, card.balanceCents),
    appliedCents: 0,
    remainingAfterCents: Math.max(0, card.balanceCents),
    message,
  });

  if (card.status !== "active") {
    // The holder has the code, so there is nothing to protect by being vague —
    // and "this card was cancelled" is the one message that gets them to phone
    // us, which is exactly what someone holding a voided card should do.
    return refuse("That gift card is no longer active. Please call us and we will sort it out.");
  }
  // Only ever set on a free promotional card: a purchased one cannot expire
  // under Ontario law, and the database refuses to store an expiry on one.
  if (card.expiresAt !== null && card.expiresAt <= now) {
    return refuse("That promotional gift card has expired.");
  }
  if (card.balanceCents <= 0) {
    return refuse("That gift card has no balance left on it.");
  }
  if (totalCents <= 0) {
    return refuse("There is nothing to pay on this order yet.");
  }

  const appliedCents = Math.min(card.balanceCents, totalCents);
  return {
    suffix,
    accepted: true,
    balanceCents: card.balanceCents,
    appliedCents,
    remainingAfterCents: card.balanceCents - appliedCents,
    message: null,
  };
}

/** "the card ending 7Q4K", for a receipt line or an email. */
export function describeGiftCard(suffix: string): string {
  return `Gift card ending ${suffix}`;
}
