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
  /**
   * What the code can be spent on, named from the promotion's own targeting —
   * "Garlic Bread, Garlic Bread with Cheese, 1 Pop, 4 Pops or Water Bottle" —
   * or null when the offer is good on anything.
   *
   * Read from the promotion for the same reason the value is: a restriction the
   * checkout enforces and the email does not mention is a customer arriving with
   * a pizza order and a code that will not come off it.
   */
  restrictedTo: string | null;
};

type PromotionRow = {
  code: string;
  type: string;
  amount: number;
  min_subtotal_cents: number;
  ends_at: number | null;
  rule_json: string | null;
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
      `SELECT code, type, amount, min_subtotal_cents, ends_at, rule_json
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
    restrictedTo: await describeRestriction(promotion.rule_json),
  };
}

/**
 * The products the code is limited to, in the menu's own words.
 *
 * Names are looked up rather than stored beside the offer, so renaming an item
 * or retargeting the promotion changes the email by itself. Anything that fails
 * to resolve — a product the owner has since retired — is left out instead of
 * printed as an id, and a rule that targets categories rather than products
 * returns null: better to send the offer with no small print than small print
 * that is wrong.
 */
async function describeRestriction(ruleJson: string | null): Promise<string | null> {
  let productIds: string[] = [];
  try {
    const rule = JSON.parse(ruleJson || "{}") as { productIds?: unknown };
    if (Array.isArray(rule.productIds)) {
      productIds = rule.productIds.filter((id): id is string => typeof id === "string" && Boolean(id));
    }
  } catch {
    return null;
  }
  if (!productIds.length) return null;
  const rows = await getD1()
    .prepare(`SELECT id, name FROM products WHERE active = 1 AND id IN (${productIds.map(() => "?").join(",")})`)
    .bind(...productIds)
    .all<{ id: string; name: string }>()
    .catch(() => ({ results: [] as Array<{ id: string; name: string }> }));
  const names = new Map(rows.results.map((row) => [row.id, row.name]));
  const ordered = productIds.map((id) => names.get(id)).filter((name): name is string => Boolean(name));
  if (!ordered.length) return null;
  if (ordered.length === 1) return ordered[0];
  return `${ordered.slice(0, -1).join(", ")} or ${ordered[ordered.length - 1]}`;
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
