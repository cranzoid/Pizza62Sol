import type { Metadata } from "next";
import FeedbackApp from "./FeedbackApp";

export const metadata: Metadata = {
  title: "Share Feedback | Pizza 62",
  description: "Send secure, order-linked feedback to Pizza 62.",
  robots: { index: false, follow: false },
};
export default function FeedbackPage() { return <FeedbackApp />; }
