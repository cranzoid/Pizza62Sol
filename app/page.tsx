import type { Metadata } from "next";
import CustomerApp from "./customer/CustomerApp";

export const metadata: Metadata = {
  title: "Pizza 62 | Hamilton Pizza, Pickup & Delivery",
  description:
    "Order Pizza 62 pizzas, wings, pickup specials, combos and family deals in Hamilton, Ontario.",
};

export default function Home() {
  return <CustomerApp />;
}
