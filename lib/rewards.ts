/**
 * The thank-you a customer gets for filling in the feedback form.
 *
 * Two pieces of state have to agree for one to exist: a settings blob naming a
 * code and describing the offer in the owner's words, and a live promotion row
 * that the checkout will actually honour. This module is the only place that
 * joins them, and it returns null unless both hold — which is what lets the
 * dispatcher park a message instead of emailing a code that does nothing.
 *
 * **The value is never stored in settings.** It is read off the promotion every
 * time, so the sentence in the email and the discount at the till are the same
 * fact rather than two copies of it. An owner who edits the offer in Admin →
 * History & offers has, by doing so, edited what the email says it is worth.
 *
 * Everyone who answers the form gets this, whatever they scored us. Rewarding
 * only the good ratings buys a star average and destroys the only thing feedback
 * is for, and Google's review policy prohibits it besides.
 */
import { getD1, getSetting } from "@/db/runtime";
import { formatMoney } from "@/lib/domain";

export type RewardSetting = {
  feedbackRewardEnabled?: boolean;
  feedbackRewardCode?: string;
  feedbackRewardOffer?: string;
};

export type FeedbackReward = {
  code: string;
  /** The owner's wording — "a free garlic bread or four pops". */
  offer: string;
  /** What the promotion is actually worth, already formatted for a reader. */
  worth: string;
  minimumCents: number;
  endsAt: number | null;
};

type PromotionRow = {
  code: string;
  type: string;
  amount: number;
  min_subtotal_cents: number;
  ends_at: number | null;
};

const DEFAULT_OFFER = "something on us";

/**
 * The live offer behind the configured code, or null.
 *
 * The liveness tests are the same ones `activePromotions` applies when the
 * customer types the code at checkout — active, inside its window, not spent.
 * They have to be: a code this says is good and the order path then rejects is
 * worse than no email at all, because the customer has already been told.
 */
export async function activeFeedbackReward(): Promise<FeedbackReward | null> {
  const settings = await getSetting<RewardSetting>("rewards").catch(() => ({}) as RewardSetting);
  if (!settings.feedbackRewardEnabled) return null;
  const code = settings.feedbackRewardCode?.trim().toUpperCase() ?? "";
  if (!code) return null;

  const now = Date.now();
  const promotion = await getD1()
    .prepare(
      `SELECT code, type, amount, min_subtotal_cents, ends_at
       FROM promotions
       WHERE UPPER(code) = ? AND active = 1
         AND (starts_at IS NULL OR starts_at <= ?)
         AND (ends_at IS NULL OR ends_at >= ?)
         AND (usage_limit IS NULL OR usage_count < usage_limit)
       LIMIT 1`,
    )
    .bind(code, now, now)
    .first<PromotionRow>();
  if (!promotion) return null;

  const worth = describeWorth(promotion.type, Number(promotion.amount ?? 0));
  if (!worth) return null;

  return {
    code: promotion.code,
    offer: settings.feedbackRewardOffer?.trim() || DEFAULT_OFFER,
    worth,
    minimumCents: Number(promotion.min_subtotal_cents ?? 0),
    endsAt: promotion.ends_at ?? null,
  };
}

/**
 * A promotion in one phrase a customer can check against their bill.
 *
 * `amount` means something different per type — cents for a fixed discount,
 * basis points for a percentage, nothing at all for free delivery — and getting
 * that wrong would print "C$15.00 off" for a 15% offer. An unrecognised type
 * returns null rather than guessing, which stops the email at the dispatcher
 * instead of sending a sentence nobody can honour. `applyPromotions` treats
 * unknown types as inert for the same reason.
 */
function describeWorth(type: string, amount: number): string | null {
  if (type === "fixed") return amount > 0 ? `${formatMoney(amount)} off` : null;
  if (type === "percentage") return amount > 0 ? `${amount / 100}% off` : null;
  if (type === "free_delivery") return "free delivery";
  return null;
}
