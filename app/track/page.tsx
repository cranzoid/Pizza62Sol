import type { Metadata } from "next";
import TrackingApp from "./TrackingApp";

export const metadata: Metadata = {
  title: "Track Your Pizza 62 Order",
  description: "Securely follow a Pizza 62 pickup or delivery order.",
  robots: { index: false, follow: false },
};
export default function TrackPage() { return <TrackingApp />; }
