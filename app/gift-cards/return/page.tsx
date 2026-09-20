import type { Metadata } from "next";
import GiftCardReturn from "./GiftCardReturn";

export const metadata: Metadata = {
  title: "Gift Card Payment · Pizza 62",
  description: "Confirming your Pizza 62 gift card payment.",
  robots: { index: false, follow: false },
};
export default function GiftCardReturnPage() { return <GiftCardReturn />; }
