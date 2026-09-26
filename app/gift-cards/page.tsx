/**
 * `/gift-cards` — public and indexable.
 *
 * A server component so the Clover configuration is resolved here rather than
 * fetched: the purchase page has no need for the menu, and pulling
 * `/api/catalog` just to learn whether the inline card form is available would
 * download the whole catalogue to answer a boolean.
 */
import type { Metadata } from "next";
import {
  cloverApiBase,
  cloverIframeEnabled,
  cloverMerchantId,
  cloverPublicToken,
} from "@/lib/clover";
import { giftCardsAvailable } from "@/lib/gift-card-purchase";
import GiftCardPurchase from "./GiftCardPurchase";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Gift Cards | Pizza 62",
  description:
    "Send a Pizza 62 gift card by email in under a minute, with a personal message for someone special.",
  alternates: { canonical: "/gift-cards" },
  openGraph: {
    title: "Pizza 62 Gift Cards",
    description: "Choose an amount, add a message, and send a Pizza 62 gift card by email.",
    type: "website",
  },
};

export default async function GiftCardsPage() {
  const [available, inline] = await Promise.all([giftCardsAvailable(), cloverIframeEnabled()]);
  const cardForm = inline
    ? {
        enabled: true,
        publicToken: await cloverPublicToken(),
        merchantId: await cloverMerchantId(),
        sandbox: (await cloverApiBase()).includes("sandbox"),
      }
    : { enabled: false };
  return <GiftCardPurchase available={available} cardForm={cardForm} />;
}
