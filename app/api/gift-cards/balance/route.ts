/**
 * "How much is left on this card?"
 *
 * **POST, not GET, and that is the whole design.** A gift card code is money.
 * A GET would put it in the URL, and from there into the browser's history, the
 * `Referer` header of every asset the page loads, any proxy's access log and the
 * server's own. The only safe place for it is a request body.
 *
 * For the same reason there is no link in the delivery email that carries the
 * code as a query parameter, however convenient that would be: the recipient
 * copies their code and pastes it, once, into a form.
 *
 * The rate limit is tight because this is the brute-force surface. A code is
 * about 79 bits, so guessing one is hopeless — but only while guesses are
 * expensive, and a balance endpoint that answered a thousand times a minute
 * would be the one place that assumption stopped holding.
 */
import { evaluateGiftCard, normalizeGiftCardCode } from "@/lib/gift-cards";
import { lookupGiftCard, toRedeemable } from "@/lib/gift-card-store";
import { logFailure } from "@/lib/log";
import { enforceRateLimit, RateLimitError } from "@/lib/security";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "gift-card-balance", 20, 15 * 60 * 1000);
    const body = (await request.json()) as { code?: string };
    const normalized = normalizeGiftCardCode(body.code);
    const card = normalized ? await lookupGiftCard(normalized) : null;
    // One answer for a code that never existed and one that was mistyped. Any
    // difference between the two turns this into an oracle that tells an
    // attacker which guesses were close.
    if (!card) {
      return Response.json(
        { error: "We could not find that gift card. Check the code and try again." },
        { status: 404 },
      );
    }
    const redeemable = toRedeemable(card);
    // Priced against its own balance, so `accepted` answers "is this card
    // usable" rather than "does it cover some particular order".
    const quote = evaluateGiftCard(redeemable, redeemable.balanceCents);
    return Response.json({
      card: {
        suffix: card.code_suffix,
        balanceCents: redeemable.balanceCents,
        // Null on every purchased card, always — see the schema constraint.
        expiresAt: redeemable.expiresAt,
        usable: quote.accepted,
        message: quote.message,
      },
    });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return Response.json(
        { error: "Too many balance checks. Please wait a few minutes and try again." },
        { status: 429 },
      );
    }
    const reference = logFailure("giftCards.balance", error);
    return Response.json({ error: "We could not check that balance.", reference }, { status: 500 });
  }
}
