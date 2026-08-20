import type { Metadata } from "next";
import OrderReturn from "./OrderReturn";

export const metadata: Metadata = {
  title: "Payment Received · Pizza 62",
  description: "Confirming your Pizza 62 online payment.",
  robots: { index: false, follow: false },
};
export default function OrderReturnPage() { return <OrderReturn />; }
