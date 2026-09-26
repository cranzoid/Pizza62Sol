import type { Metadata } from "next";
import UnsubscribeForm from "./UnsubscribeForm";

export const metadata: Metadata = {
  title: "Unsubscribe · Pizza 62",
  description: "Stop Pizza 62 marketing emails.",
  robots: { index: false, follow: false },
};

export default function UnsubscribePage() {
  return <UnsubscribeForm />;
}
