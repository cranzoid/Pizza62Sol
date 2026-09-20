import type { Metadata } from "next";
import GiftCardBalance from "./GiftCardBalance";

export const metadata: Metadata = {
  title: "Gift Card Balance · Pizza 62",
  description: "Check the remaining balance on a Pizza 62 gift card.",
  // A page whose entire content is "type your card number here" has no business
  // in a search result, and a crawler has no balance to check.
  robots: { index: false, follow: false },
};
export default function GiftCardBalancePage() { return <GiftCardBalance />; }
