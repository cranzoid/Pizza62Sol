/**
 * Selling a gift card.
 *
 * POST starts a purchase and takes the money; GET reports what became of one,
 * addressed by the Clover session id, which is what `/gift-cards/return` polls
 * while it waits for the webhook.
 *
 * **The rate limit is the fraud control, not a politeness measure.** A gift card
 * is merchandise delivered by email in seconds, which makes card-testing and
 * stolen-card cash-out the obvious attacks; twelve attempts per client per day
 * is generous for anyone buying a present and useless to anyone working through
 * a list of stolen numbers. The amount ceiling in lib/gift-cards.ts caps what a
 * single success is worth, and nothing is minted until the money is confirmed.
 */
import { logFailure } from "@/lib/log";
import {
  GiftCardValidationError,
  giftCardPurchaseBySession,
  giftCardsAvailable,
  startGiftCardPurchase,
} from "@/lib/gift-card-purchase";
import { enforceRateLimit, RateLimitError } from "@/lib/security";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "gift-card-purchase", 12, 24 * 60 * 60 * 1000);
    if (!(await giftCardsAvailable())) {
      return Response.json(
        { error: "Gift cards are not available right now.", code: "GIFT_CARDS_UNAVAILABLE" },
        { status: 503 },
      );
    }
    const body = await request.json();
    const result = await startGiftCardPurchase(body);
    return Response.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof GiftCardValidationError || error instanceof RateLimitError) {
      return Response.json(
        { error: error.message, code: error instanceof GiftCardValidationError ? error.code : "RATE_LIMITED" },
        { status: error.status },
      );
    }
    // Opaque outward, specific in the logs — the same contract /api/orders keeps.
    const reference = logFailure("giftCards.purchase", error);
    return Response.json(
      { error: "We could not complete that gift card purchase. No card was created.", reference },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  try {
    await enforceRateLimit(request, "gift-card-purchase-status", 120, 15 * 60 * 1000);
    const session = new URL(request.url).searchParams.get("session") ?? "";
    const purchase = await giftCardPurchaseBySession(session);
    // An unknown session is a 404 with no detail. The identifier is Clover's own
    // UUID, so there is nothing to enumerate, but there is also nothing useful
    // to say beyond "not ours".
    if (!purchase) return Response.json({ error: "Not found." }, { status: 404 });
    return Response.json({ purchase });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return Response.json({ error: error.message, code: "RATE_LIMITED" }, { status: 429 });
    }
    const reference = logFailure("giftCards.purchaseStatus", error);
    return Response.json({ error: "We could not check that purchase.", reference }, { status: 500 });
  }
}
